# Databricks notebook source
# # COMMAND ----------

# # ── Key Vault ──────────────────────────────────────────────────────────────────
# KEY_VAULT_URL            = "https://RiskubeProd-KV.vault.azure.net/"
# DB_URL_SECRET_NAME       = "cl01-dev-db-url"
# AOAI_API_KEY_SECRET_NAME = "azure-openai-api-key"

# # ── Azure OpenAI ───────────────────────────────────────────────────────────────
# AZURE_OPENAI_ENDPOINT    = "https://genai-monish-openai.cognitiveservices.azure.com"
# AZURE_OPENAI_DEPLOYMENT  = "gpt-5-mini"
# AZURE_OPENAI_API_VERSION = "2024-12-01-preview"

# # ── Run config ─────────────────────────────────────────────────────────────────
# PRODUCTS    = None   # None = all products from DB; e.g. ["RLAP", "GEL"]
# CONCURRENCY = 10

# # COMMAND ----------
# # MAGIC %md ## 2. Load secrets

# # COMMAND ----------

# import os
# from urllib.parse import urlparse

# from azure.identity import DefaultAzureCredential
# from azure.keyvault.secrets import SecretClient


# def _kv_client() -> SecretClient:
#     return SecretClient(vault_url=KEY_VAULT_URL, credential=DefaultAzureCredential())


# def load_aoai_env() -> None:
#     kv = _kv_client()
#     os.environ["AZURE_OPENAI_ENDPOINT"]    = AZURE_OPENAI_ENDPOINT
#     os.environ["AZURE_OPENAI_API_KEY"]     = kv.get_secret(AOAI_API_KEY_SECRET_NAME).value
#     os.environ["AZURE_OPENAI_API_VERSION"] = AZURE_OPENAI_API_VERSION
#     os.environ["AZURE_OPENAI_DEPLOYMENT"]  = AZURE_OPENAI_DEPLOYMENT
#     print("✅ AOAI env loaded")


# def load_db_env() -> dict:
#     """Parse DB URL from KV → set os.environ AND return psycopg2-style dict."""
#     kv = _kv_client()
#     db_url = kv.get_secret(DB_URL_SECRET_NAME).value
#     parsed = urlparse(db_url)

#     cfg = {
#         "host":     parsed.hostname or "",
#         "port":     parsed.port or 5432,
#         "database": (parsed.path or "").lstrip("/"),
#         "user":     parsed.username or "",
#         "password": parsed.password or "",
#     }
#     os.environ["DB_HOST"]     = cfg["host"]
#     os.environ["DB_PORT"]     = str(cfg["port"])
#     os.environ["DB_NAME"]     = cfg["database"]
#     os.environ["DB_USER"]     = cfg["user"]
#     os.environ["DB_PASSWORD"] = cfg["password"]

#     print(f"✅ DB env loaded — host={cfg['host']}  db={cfg['database']}  user={cfg['user']}")
#     return cfg


# print("Loading secrets...")
# load_aoai_env()
# DB_CONFIG = load_db_env()

# # COMMAND ----------
# # MAGIC %md ## 3. DB utilities

# # COMMAND ----------

# import traceback
# import psycopg2

# _SEARCH_PATH = (
#     "-c search_path=mtd_recovery,recovery,recovery_portfolio,"
#     "recovery_mix_impact,recovery_vintage,recovery_home,"
#     "recovery_daily_payments,recovery_diagnostics"
# )


# def get_db_connection():
#     return psycopg2.connect(
#         host=os.getenv("DB_HOST"),
#         port=os.getenv("DB_PORT", "5432"),
#         dbname=os.getenv("DB_NAME"),
#         user=os.getenv("DB_USER"),
#         password=os.getenv("DB_PASSWORD"),
#         options=_SEARCH_PATH,
#     )


# def _q(conn, sql, params=None):
#     with conn.cursor() as cur:
#         cur.execute(sql, params or ())
#         cols = [d[0] for d in cur.description]
#         return [dict(zip(cols, row)) for row in cur.fetchall()]


# def fetch_products_from_db() -> dict:
#     """Returns {group_key: query_key} from recovery_home.v1_recovery_tile."""
#     conn = get_db_connection()
#     try:
#         rows = _q(conn, """
#             SELECT DISTINCT product_group, group_key
#             FROM recovery_home.v1_recovery_tile
#             WHERE group_key IS NOT NULL
#             ORDER BY group_key
#         """)
#         return {r["group_key"]: r["group_key"] for r in rows}
#     finally:
#         conn.close()

# # COMMAND ----------
# # MAGIC %md ## 4. Data pre-fetch (per product)

# # COMMAND ----------

# from datetime import date, datetime


# def _fmt_month(val) -> str:
#     if val is None:
#         return None
#     return val.strftime("%b-%y") if hasattr(val, "strftime") else str(val)


# def _mtd_at_day(rows, status, day):
#     pts = [r for r in rows if r["date_status"] == status and r["date_index"] == day]
#     if not pts:
#         return None
#     r = pts[0]
#     return {
#         "day_of_month":        day,
#         "year_month":          r["year_month"],
#         "recovery_mio":        round(r["total_recovery"] / 1e6, 3) if r["total_recovery"] else None,
#         "recovery_pct_of_bom": round(r["recovery_percentage"], 6) if r["recovery_percentage"] else None,
#         "bom_pos_mio":         round(r["total_balance"] / 1e6, 2) if r["total_balance"] else None,
#     }


# def get_local_product_overview(product_name: str, group_key: str) -> dict | None:
#     gk, pn = group_key.strip(), product_name.strip()
#     conn = None
#     try:
#         conn = get_db_connection()

#         # 1. Recovery tile
#         tile_rows = _q(conn, """
#             SELECT product_group, group_key,
#                    last_month_pos_mn, last_mtd_pos_mn, current_mtd_pos_mn, pos_change_pct,
#                    last_month_recovery_mn, last_mtd_recovery_mn, current_mtd_recovery_mn, recovery_change_pct,
#                    last_month_ror_pct, last_mtd_ror_pct, current_mtd_ror_pct, ror_change_pct
#             FROM recovery_home.v1_recovery_tile
#             WHERE group_key = %s LIMIT 1
#         """, (gk,))
#         recovery_tile = None
#         if tile_rows:
#             r = tile_rows[0]
#             recovery_tile = {k: r[k] for k in r}

#         # 2. Portfolio trend (6 months)
#         trend_rows = _q(conn, """
#             SELECT year_month, total_balance, total_recovery, recovery_percentage
#             FROM recovery_portfolio.portfolio_value
#             WHERE product_name = %s AND filter = 'all' AND subsegment = 'all'
#             ORDER BY datetime DESC LIMIT 6
#         """, (pn,))
#         portfolio_trend = list(reversed([
#             {
#                 "year_month":          r["year_month"],
#                 "total_balance_mio":   round(r["total_balance"] / 1e6, 2) if r["total_balance"] else None,
#                 "total_recovery_mio":  round(r["total_recovery"] / 1e6, 2) if r["total_recovery"] else None,
#                 "recovery_percentage": round(r["recovery_percentage"], 6) if r["recovery_percentage"] else None,
#             }
#             for r in trend_rows
#         ]))

#         # 3. POS mix — FIX: added prev-month join to get recovery_pct_prev + delta_pp per band
#         pos_mix_rows = _q(conn, """
#             WITH latest AS (
#                 SELECT MAX(datetime) AS max_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'pos_bin'
#             ),
#             prev AS (
#                 SELECT MAX(datetime) AS prev_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'pos_bin'
#                   AND datetime < (SELECT max_dt FROM latest)
#             ),
#             total AS (
#                 SELECT SUM(total_balance) AS tot
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'pos_bin'
#                   AND datetime = (SELECT max_dt FROM latest)
#             )
#             SELECT cur.subsegment,
#                    cur.total_balance,
#                    cur.recovery_percentage,
#                    prv.recovery_percentage AS recovery_pct_prev,
#                    ROUND((cur.total_balance / NULLIF(t.tot, 0) * 100)::numeric, 2) AS contribution_pct
#             FROM recovery_portfolio.portfolio_value cur
#             LEFT JOIN recovery_portfolio.portfolio_value prv
#                 ON prv.product_name = cur.product_name
#                AND prv.filter = cur.filter
#                AND prv.subsegment = cur.subsegment
#                AND prv.datetime = (SELECT prev_dt FROM prev),
#             total t
#             WHERE cur.product_name = %s AND cur.filter = 'pos_bin'
#               AND cur.datetime = (SELECT max_dt FROM latest)
#             ORDER BY cur.total_balance DESC LIMIT 8
#         """, (pn, pn, pn, pn))
#         pos_mix = [
#             {
#                 "subsegment":          r["subsegment"],
#                 "total_balance_mio":   round(r["total_balance"] / 1e6, 2) if r["total_balance"] else None,
#                 "recovery_percentage": round(r["recovery_percentage"], 6) if r["recovery_percentage"] else None,
#                 "recovery_pct_prev":   round(r["recovery_pct_prev"], 6) if r["recovery_pct_prev"] else None,
#                 "delta_pp":            round(r["recovery_percentage"] - r["recovery_pct_prev"], 6)
#                                        if (r["recovery_percentage"] and r["recovery_pct_prev"]) else None,
#                 "contribution_pct":    float(r["contribution_pct"]) if r["contribution_pct"] else None,
#             }
#             for r in pos_mix_rows
#         ]

#         # 4. WO MOB vintage mix (current + prev month RoR per bucket)
#         vmix_rows = _q(conn, """
#             WITH latest AS (
#                 SELECT MAX(datetime) AS max_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'wo_mob_bin'
#             ),
#             prev AS (
#                 SELECT MAX(datetime) AS prev_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'wo_mob_bin'
#                   AND datetime < (SELECT max_dt FROM latest)
#             )
#             SELECT cur.year_month, cur.subsegment,
#                    cur.total_balance,
#                    cur.recovery_percentage AS recovery_pct,
#                    prv.recovery_percentage AS recovery_pct_prev,
#                    SUM(cur.total_balance) OVER () AS total_book
#             FROM recovery_portfolio.portfolio_value cur
#             LEFT JOIN recovery_portfolio.portfolio_value prv
#                 ON prv.product_name = cur.product_name
#                AND prv.filter = cur.filter AND prv.subsegment = cur.subsegment
#                AND prv.datetime = (SELECT prev_dt FROM prev)
#             WHERE cur.product_name = %s AND cur.filter = 'wo_mob_bin'
#               AND cur.datetime = (SELECT max_dt FROM latest)
#             ORDER BY cur.subsegment
#         """, (pn, pn, pn))
#         vintage_mix = [
#             {
#                 "year_month":        r["year_month"],
#                 "bucket":            r["subsegment"],
#                 "balance_mio":       round(r["total_balance"] / 1e6, 2) if r["total_balance"] else None,
#                 "contribution_pct":  round(r["total_balance"] / r["total_book"] * 100, 2)
#                                      if (r["total_balance"] and r["total_book"]) else None,
#                 "recovery_pct":      round(r["recovery_pct"], 6) if r["recovery_pct"] else None,
#                 "recovery_pct_prev": round(r["recovery_pct_prev"], 6) if r["recovery_pct_prev"] else None,
#                 "delta_pp":          round(r["recovery_pct"] - r["recovery_pct_prev"], 6)
#                                      if (r["recovery_pct"] and r["recovery_pct_prev"]) else None,
#             }
#             for r in vmix_rows
#         ]

#         # 5. Mix impact (last 3 months)
#         mix_rows = _q(conn, """
#             SELECT year_month, filter, subsegment, total_balance, total_recovery,
#                    recovery_percentage, percentage_contribution, all_balance
#             FROM recovery_mix_impact.mix_impact_value
#             WHERE product_name = %s AND filter IN ('pos_bin', 'wo_mob_bin')
#             ORDER BY year_month DESC, filter, total_balance DESC LIMIT 24
#         """, (pn,))
#         mix_impact = [
#             {
#                 "year_month":              r["year_month"],
#                 "filter":                  r["filter"],
#                 "subsegment":              r["subsegment"],
#                 "total_balance_mio":       round(r["total_balance"] / 1e6, 2) if r["total_balance"] else None,
#                 "recovery_percentage":     round(r["recovery_percentage"], 6) if r["recovery_percentage"] else None,
#                 "percentage_contribution": round(r["percentage_contribution"], 6) if r["percentage_contribution"] else None,
#             }
#             for r in mix_rows
#         ]

#         # 6. Vintage curves
#         vcurve_rows = _q(conn, """
#             SELECT quarter, month, percentage_value
#             FROM recovery_vintage.vintage
#             WHERE product_name = %s AND filter = 'ALL' AND subsegment = 'ALL'
#               AND quarter IS NOT NULL AND percentage_value IS NOT NULL
#             ORDER BY quarter, CAST(SUBSTRING(month FROM 2) AS INTEGER)
#         """, (pn,))
#         vcurves: dict = {}
#         for r in vcurve_rows:
#             vcurves.setdefault(r["quarter"], []).append({
#                 "month": r["month"],
#                 "cumulative_recovery_pct": round(r["percentage_value"], 6)
#                                            if r["percentage_value"] is not None else None,
#             })
#         vintage_curves = [{"quarter": q, "data": pts} for q, pts in vcurves.items()]

#         # 7. MTD daily pacing
#         mtd_rows = _q(conn, """
#             SELECT date_index, date_status, year_month,
#                    total_balance, total_recovery, recovery_percentage
#             FROM mtd_recovery.recovery_portfolio
#             WHERE group_key = %s
#               AND filter = 'all' AND subsegment = 'all'
#               AND "Metrics" = 'Value'
#               AND date_status IN ('current', 'previous', 'PM+1')
#             ORDER BY date_status, date_index
#         """, (gk,))

#         cm_days     = [r["date_index"] for r in mtd_rows if r["date_status"] == "current"]
#         latest_day  = max(cm_days, default=None)
#         pm_days     = [r["date_index"] for r in mtd_rows if r["date_status"] == "previous"]
#         pm_last_day = max(pm_days, default=latest_day)

#         # Derive the day the tile is anchored to by matching current_mtd_ror_pct
#         tile_current_ror = (recovery_tile or {}).get("current_mtd_ror_pct")
#         pacing_day = None
#         if tile_current_ror is not None:
#             for r in mtd_rows:
#                 if (r["date_status"] == "current"
#                         and r["recovery_percentage"] is not None
#                         and abs(r["recovery_percentage"] - tile_current_ror) < 1e-6):
#                     pacing_day = r["date_index"]
#                     break
#         if pacing_day is None:
#             pacing_day = latest_day

#         today = date.today()
#         cm_year_months    = {r["year_month"] for r in mtd_rows if r["date_status"] == "current"}
#         cm_year_month_str = next(iter(cm_year_months), None)
#         db_current_is_closed = False
#         if cm_year_month_str:
#             try:
#                 db_dt = datetime.strptime(cm_year_month_str, "%b %Y")
#                 if db_dt.month != today.month or db_dt.year != today.year:
#                     db_current_is_closed = True
#             except ValueError:
#                 pass

#         if db_current_is_closed:
#             mtd_pacing = {
#                 "latest_day_of_month": pm_last_day,
#                 "tile_anchor_day":     pacing_day,
#                 "pipeline_note": (
#                     f"DB 'current' label is {cm_year_month_str} which is a closed month "
#                     f"(today is {today.strftime('%d %b %Y')}). Pipeline has not rolled to "
#                     f"{today.strftime('%B %Y')} yet. Treat {cm_year_month_str} as the settled "
#                     f"reference month. No live MTD data available for {today.strftime('%B %Y')}."
#                 ),
#                 "settled_reference_month": _mtd_at_day(mtd_rows, "current", pacing_day),
#                 "PM_same_day":             None,
#                 "PM_month_end":            _mtd_at_day(mtd_rows, "previous", pm_last_day),
#                 "PM1":                     _mtd_at_day(mtd_rows, "PM+1", pacing_day),
#                 "CM":                      None,
#             }
#         else:
#             mtd_pacing = {
#                 "latest_day_of_month": latest_day,
#                 "tile_anchor_day":     pacing_day,
#                 "CM":           _mtd_at_day(mtd_rows, "current",  pacing_day),
#                 "PM_same_day":  _mtd_at_day(mtd_rows, "previous", pacing_day),
#                 "PM_month_end": _mtd_at_day(mtd_rows, "previous", pm_last_day),
#                 "PM1":          _mtd_at_day(mtd_rows, "PM+1",     pacing_day),
#             }

#         # 8. State breakdown
#         state_rows = _q(conn, """
#             WITH latest AS (
#                 SELECT MAX(datetime) AS max_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'state_mapped'
#             ),
#             prev AS (
#                 SELECT MAX(datetime) AS prev_dt
#                 FROM recovery_portfolio.portfolio_value
#                 WHERE product_name = %s AND filter = 'state_mapped'
#                   AND datetime < (SELECT max_dt FROM latest)
#             )
#             SELECT cur.subsegment AS state,
#                    cur.total_balance AS balance,
#                    cur.recovery_percentage AS recovery_pct,
#                    prv.recovery_percentage AS recovery_pct_prev
#             FROM recovery_portfolio.portfolio_value cur
#             LEFT JOIN recovery_portfolio.portfolio_value prv
#                 ON prv.product_name = cur.product_name
#                AND prv.filter = cur.filter AND prv.subsegment = cur.subsegment
#                AND prv.datetime = (SELECT prev_dt FROM prev)
#             WHERE cur.product_name = %s AND cur.filter = 'state_mapped'
#               AND cur.datetime = (SELECT max_dt FROM latest)
#             ORDER BY cur.total_balance DESC LIMIT 8
#         """, (pn, pn, pn))
#         state_breakdown = [
#             {
#                 "state":             r["state"],
#                 "balance_mio":       round(r["balance"] / 1e6, 2) if r["balance"] else None,
#                 "recovery_pct":      round(r["recovery_pct"], 6) if r["recovery_pct"] else None,
#                 "recovery_pct_prev": round(r["recovery_pct_prev"], 6) if r["recovery_pct_prev"] else None,
#                 "delta_pp":          round(r["recovery_pct"] - r["recovery_pct_prev"], 6)
#                                      if (r["recovery_pct"] and r["recovery_pct_prev"]) else None,
#             }
#             for r in state_rows
#         ]

#         return {
#             "recovery_tile":   recovery_tile,
#             "portfolio_trend": portfolio_trend,
#             "pos_mix":         pos_mix,
#             "vintage_mix":     vintage_mix,
#             "mix_impact":      mix_impact,
#             "vintage_curves":  vintage_curves,
#             "mtd_pacing":      mtd_pacing,
#             "state_breakdown": state_breakdown,
#         }

#     except Exception as e:
#         print(f"   ❌ DB error for {product_name}: {e}")
#         traceback.print_exc()
#         return None
#     finally:
#         if conn:
#             conn.close()

# # COMMAND ----------
# # MAGIC %md ## 5. LLM brief generation

# # COMMAND ----------

# import json
# import re
# import requests

# # ── System prompt ──────────────────────────────────────────────────────────────

# CRO_RECOVERY_SKILL_PROMPT = """
# # Recovery Portfolio Overview

# Brief a recovery/collections manager in under 60 seconds. Give them everything they need to understand the recovery portfolio without opening a single dashboard. Verdict first. Cover portfolio balance, recovery rate direction, vintage performance, mix shift, daily pacing, and highest-risk segments — but only surface numbers that explain something non-obvious.

# Your job is not to narrate the dashboard. A manager can read numbers themselves. Your job is to tell them what the numbers mean, whether the signals agree with each other, and what is actually at risk going forward.

# ---

# ## Data Dictionary

# ### Recovery Tile → `response.recovery_tile`

# The tile now reports on a current-month-to-date (MTD) basis alongside last month actuals.
# All balance and recovery figures are in INR Mn.

# | Field | Meaning |
# |---|---|
# | `last_month_pos_mn` | Full prior month write-off POS (INR Mn) — the closed baseline |
# | `last_mtd_pos_mn` | Prior month POS as of the same day-of-month as today (apples-to-apples MTD anchor) |
# | `current_mtd_pos_mn` | Current month POS as of today |
# | `pos_change_pct` | % change in POS: current_mtd vs last_mtd |
# | `last_month_recovery_mn` | Full prior month recovery collected (INR Mn) |
# | `last_mtd_recovery_mn` | Prior month recovery as of same day-of-month (MTD anchor) |
# | `current_mtd_recovery_mn` | Current month recovery collected so far (INR Mn) |
# | `recovery_change_pct` | % change in recovery: current_mtd vs last_mtd |
# | `last_month_ror_pct` | Full prior month Rate of Recovery — use as the settled benchmark |
# | `last_mtd_ror_pct` | Prior month RoR as of same day-of-month |
# | `current_mtd_ror_pct` | Current month RoR so far |
# | `ror_change_pct` | pp change in RoR: current_mtd vs last_mtd |

# **Primary headline signals:**
# - `current_mtd_ror_pct` vs `last_mtd_ror_pct` — is this month's rate running ahead or behind the same point last month?
# - `last_month_ror_pct` — the fully settled prior month baseline; use as the target the current month is tracking toward.
# - `current_mtd_pos_mn` vs `last_mtd_pos_mn` — is the recoverable book growing or shrinking MTD?

# **Do not compare `current_mtd_recovery_mn` to `last_month_recovery_mn` directly** — one is partial-month, one is full-month. Always compare MTD-to-MTD or use RoR (which normalises for book size and timing).

# ---

# ### Portfolio Trend → `response.portfolio_trend`

# 6-month trend, oldest → newest. Each entry:

# | Field | Meaning |
# |---|---|
# | `year_month` | Month label (e.g. "Mar 2026") |
# | `total_balance` | Total write-off POS under recovery (INR Mio) |
# | `total_recovery` | Total recovery collected that month (INR Mio) |
# | `recovery_percentage` | Recovery rate for that month (%) |

# **Use portfolio_trend to:**
# - State whether the recoverable book is growing (more write-offs being added) or shrinking (book running off)
# - Identify the direction and velocity of recovery rate changes over 6 months — is it improving, deteriorating, or volatile?
# - Detect divergence: book growing fast while recovery rate is falling = dilution by fresh/lower-quality write-offs

# ---

# ### POS Mix → `response.pos_mix`

# Latest month breakdown of the write-off book by POS band (product-specific bins like 0-50K, 50K-75K, 75K-1.0L, 1.0L+).

# | Field | Meaning |
# |---|---|
# | `subsegment` | POS band label |
# | `total_balance` | POS in this band (INR Mio) |
# | `recovery_percentage` | Recovery rate for this band (%) |
# | `contribution_pct` | This band's share of total write-off book (%) |

# **Recovery rate gradient:** Smaller ticket sizes (0-50K) generally recover at higher rates; larger tickets (1.0L+) at lower rates. A mix shift toward smaller tickets is recovery-positive; a shift toward larger tickets is recovery-negative. Always state which direction the mix is moving and what it implies for the blended rate.

# ---

# ### Vintage Mix (WO MOB) → `response.vintage_mix`

# V1 = written off 0–6 months ago (freshest), V2 = 7–12 months ago, ... V6 = oldest. Latest month only.

# | Field | Meaning |
# |---|---|
# | `bucket` | V1 through V6 |
# | `balance_mio` | POS in this vintage bucket (INR Mio) |
# | `contribution_pct` | This bucket's share of the total write-off book (%) |
# | `recovery_pct` | Recovery rate this month (%) |
# | `recovery_pct_prev` | Recovery rate prior month (%) — use to compute MoM delta per bucket |

# **Vintage interpretation:**
# - V1 (fresh write-offs) typically recovers best early — high V1 contribution is recovery-positive if the rate holds
# - V2–V3 = mid-aging, where recovery rate decay is most visible
# - V4–V6 (old/stale write-offs) = usually lowest recovery rates — high contribution here drags the blended rate
# - A growing V6 share with low RoR signals the book is aging without being resolved — structural drag
# - Compare V1 RoR vs V2 RoR vs V3 RoR: a sharp drop from V1 to V2 means the fresh recovery window closes fast

# ---

# ### Mix Impact → `response.mix_impact`

# Last 3 months. Shows whether changes in the blended recovery rate are driven by the mix shifting OR by genuine rate improvement within segments.

# | Field | Meaning |
# |---|---|
# | `year_month` | Month |
# | `subsegment` | POS band or vintage bucket |
# | `recovery_percentage` | This segment's RoR that month |
# | `percentage_contribution` | This segment's share of the book that month (%) |

# **How to read mix impact:**
# - If a low-RoR segment's `percentage_contribution` is rising → mix is dragging the blended rate down, even if each segment is individually stable
# - If a high-RoR segment's contribution is shrinking → blended rate will fall even without deterioration in any segment
# - The key question: "Is the blended rate moving because the book is changing composition, or because recovery effectiveness is changing within segments?"

# ---

# ### Vintage Curves → `response.vintage_curves`

# Cumulative recovery % by write-off quarter (Q1 2025, Q2 2025, Q3 2025, Q4 2025, Q1 2026) tracked across maturity months M1–M15.

# | Field | Meaning |
# |---|---|
# | `quarter` | Write-off cohort (e.g. "Q1 2025") |
# | `month` | Maturity month within that cohort (M1 = 1 month after write-off) |
# | `percentage_value` | Cumulative % of write-off POS recovered by this maturity point |

# **Vintage curve interpretation:**
# - Compare cohorts at the SAME maturity point (e.g. all cohorts at M3, M6, M9) — this is the true apples-to-apples comparison
# - A newer cohort tracking below an older cohort at the same age = underperformance; above = outperformance
# - Curve shape matters: a steep M1–M4 ramp followed by flattening = front-loaded recovery; a slow early ramp followed by sustained rise = legal/settlement-led
# - For immature cohorts (Q3 2025, Q4 2025, Q1 2026 with only M1–M6 visible), project ultimate recovery by comparing early-month % to the same early months of a mature cohort
# - "Trajectory gap": if Q4 2025 is at M3 = 3.9% and Q1 2025 at M3 = 6.8%, the new cohort is running 43% below the benchmark — quantify this gap explicitly

# ---

# ### MTD Pacing → `response.mtd_pacing`

# Daily cumulative recovery for current month (CM), prior month (PM), and the last-3-month average (L3M).

# | Field | Meaning |
# |---|---|
# | `latest_day_of_month` | Most recent day with CM data |
# | `CM` | Current month at latest day — recovery_mio, recovery_pct_of_bom |
# | `PM_same_day` | Prior month at the same day — for direct MTD comparison |
# | `PM_month_end` | Prior month at its final day — the full-month settled figure |
# | `PM1` | Two months ago at same day — secondary reference |

# **MTD pacing rules:**
# - Compare CM `recovery_pct_of_bom` vs `PM_same_day` `recovery_pct_of_bom` — running ahead or behind?
# - State the pp gap and directional implication: "running Xpp behind PM at day Y, implying month-end recovery will be ~Z% if pace holds"
# - Use `PM_month_end` to anchor the full-month target the current pace is tracking toward
# - Never compare CM raw recovery amount to PM month-end amount — timing mismatch

# ---

# ### State Breakdown → `response.state_breakdown`

# Latest month breakdown of the write-off book by state, ordered by balance (largest first).

# | Field | Meaning |
# |---|---|
# | `state` | State name (e.g. MAHARASHTRA, UTTAR PRADESH, Others) |
# | `balance_mio` | POS in this state (INR Mio) |
# | `recovery_pct` | Recovery rate for this state this month (%) |
# | `recovery_pct_prev` | Recovery rate prior month (%) |
# | `delta_pp` | MoM change in recovery rate (pp) — positive = improving, negative = deteriorating |

# **State hotspot rule:** Only flag a state if it is (a) top-3 by balance AND (b) showing a negative delta_pp (declining recovery rate). A low recovery rate on a small state is immaterial. The most actionable state risk is large balance + falling rate.

# ---

# ## Before You Write — Analyst Reconciliation Checklist

# Run these questions before writing a single sentence. The answers shape each paragraph.

# **1. Tile MTD vs last month**
# Is `current_mtd_ror_pct` ahead or behind `last_mtd_ror_pct`?
# - Ahead = month is running better than last month at same point in time
# - Behind = month is running worse; check if this is pace (collections timing) or structural
# - Always anchor to `last_month_ror_pct` as the fully settled benchmark the current month is tracking toward

# **2. Book composition check**
# Is total POS (write-off book) growing or shrinking (portfolio_trend)?
# - Growing = more write-offs being fed in. Is recovery rate keeping up, or being diluted by fresh/lower-quality accounts?
# - Shrinking = book running off. If recovery_pct is also falling on a shrinking book, that is double deterioration.

# **3. Rate direction vs mix shift**
# Compare recovery_pct trend (portfolio_trend) vs mix_impact contribution shifts.
# - Rate falling + low-RoR segment contribution rising → mix-driven drag, not operational failure
# - Rate falling + each segment's individual rate also falling → genuine collection effectiveness issue
# - Rate improving but only because high-RoR segment contribution increased → temporary, will reverse if mix normalises

# **4. Vintage curve trajectory**
# For each cohort in vintage_curves, compare to the same maturity month of the best-performing cohort.
# - If newest cohort is tracking materially below benchmark at same age → flag the projected shortfall
# - Compute: (newest cohort M3%) / (best cohort M3%) − 1 = performance gap at current age
# - If newest cohort is tracking ahead → flag it as a positive signal for future months

# **5. WO MOB vintage aging**
# Check vintage_mix: is V6 (old stale accounts) share growing?
# - Rising V6 share = aged inventory building. These accounts have lowest recovery probability.
# - Rising V1 share = fresh write-offs being added at pace. Recovery rate for V1 matters: is it in line with prior V1 cohorts?

# **6. MTD pacing vs prior month**
# Is CM tracking above or below PM at the same day-of-month?
# - Running behind PM AND behind L3M → double miss signal.
# - Running ahead → project upside vs prior month.

# **7. State concentration**
# Is the state with the worst delta_pp also large in absolute balance? Small balance + falling rate = immaterial. Large balance + falling rate = primary risk worth naming.

# ---

# ## Write the 4-Paragraph Brief

# Blank line between paragraphs. Bold label at the start of each.

# **Paragraph 1 — Verdict**
# One sentence. No metrics. No specific segments or cohort names. Pure overall health: "Recovery is improving and tracking ahead of prior month", "showing structural mix-driven drag despite stable operations", "fresh vintage underperformance signals emerging collection risk", etc.

# **Paragraph 2 — Key Observations**
# 3–4 sentences. Always in this order:

# 1. **Tile MTD + book size** — State whether this month's Rate of Recovery (RoR) is running ahead or behind the same point last month, and reference the settled prior month RoR as the benchmark. State current MTD POS vs prior MTD POS. Apply the MTD vs last-month distinction strictly: never present partial-month recovery as a full-month figure.

# 2. **Vintage curve benchmark** — State the sharpest vintage signal: which cohort is most materially above or below benchmark at the same maturity month? Quantify the trajectory gap (pp or %). If newest cohort is immature (M1–M4 only), project implied ultimate recovery vs the best-performing cohort's final level.

# 3. **Mix shift signal** — State whether the blended recovery rate is being driven by mix shift or by genuine effectiveness change, using mix_impact data. Name the specific segment (POS band or WO MOB vintage bucket) whose contribution is moving most, and what it implies for the blended rate next month.

# 4. **MTD pacing** — Current month recovery pace vs prior month at the same day-of-month. State the pp gap and whether the full-month implied recovery is above or below last month's settled rate.

# **Paragraph 3 — Potential Risk** *(one sentence only — skip if nothing material)*
# One sentence. Priority:
# 1. **State hotspot** — only if top-3 by balance AND delta_pp is negative. State the state name, recovery rate, prior month rate, and balance.
# 2. **Vintage/POS segment risk** — if no state hotspot is material, flag the specific POS band or WO MOB bucket with the worst recovery rate and growing contribution.
# Skip entirely if nothing material.

# **Paragraph 4 — Focus**
# 1–2 sentences. The single forward-looking trigger already under the most pressure that would, if it worsens, move the verdict.

# Scan in this order:
# 1. Vintage curves — which cohort's early-month trajectory, if it holds, implies the largest shortfall at M12?
# 2. Mix impact — which segment's contribution is growing fastest, and what does it do to the blended rate if it reaches X%?
# 3. WO MOB aging — is V6 share growing, and at what pace?
# 4. MTD pacing gap — if current day-of-month pace holds, does it imply a miss vs prior month-end?
# 5. Regional Rate Loss — is the worst region's trend accelerating?

# Name the metric, direction, and threshold. No action items.

# ---

# ## Tone

# - Conversational, not academic. Professional enough to forward to a senior leader.
# - Number-sparse — only figures that explain the verdict
# - Expand abbreviations on first use: RoR = Rate of Recovery, POS = Principal Outstanding, WO = Write-Off, MOB = Month on Book, BOM = Beginning of Month, MTD = Month to Date
# - Never "monitor closely" or "analyze further" without a specific reference point
# - Always name specific segments in plain English ("the 0–50K POS band", "the Q3 2025 cohort", "the V6 vintage bucket", "East region")

# ---

# ## Anti-patterns

# - ❌ Bullet lists
# - ❌ Opening with a number instead of a verdict
# - ❌ Reporting a metric direction without a "what this means" clause
# - ❌ Comparing vintage cohorts at different maturity months — always same-age comparison
# - ❌ Calling a shrinking V6 share a risk — it is positive (old inventory running off)
# - ❌ Comparing current_mtd_recovery_mn directly to last_month_recovery_mn — timing mismatch
# - ❌ Using MTD recovery amount without normalising to day-of-month
# - ❌ More than one thing in Potential Risk
# - ❌ Action items in Focus ("review X", "validate Y") — only watch signals with thresholds
# - ❌ Flagging a state hotspot without checking that it is top-3 by balance
# - ❌ Using internal field names in the brief (e.g. "wo_mob_bin", "percentage_contribution", "current_mtd_ror_pct") — always plain English
# - ❌ Claiming mix shift is the cause without actually checking whether segment-level rates are also moving

# ---

# ## Example Output

# *Product: RLAP (Retail Loan Against Property) — Apr 2026*

# **Verdict**: Recovery rate is stable on the surface but a structural collapse in post-Q2 2025 vintage performance means the book is recovering far less from newer write-offs than historical cohorts did.

# **Key observations**: This month's Rate of Recovery (RoR) is running at 0.78% through day 26, marginally ahead of the 0.74% at the same point last month, tracking toward last month's settled 1.13% if the end-of-month collection push holds — but the current MTD Principal Outstanding (POS) of ₹691 Mn is up 1.2% vs last month at this date, meaning a larger book is being worked with broadly the same daily pace. The vintage curve signal is the more concerning story: at M3, Q1 2025 had reached 41.3% cumulative recovery, while Q3 2025, Q4 2025, and Q1 2026 are all in the 1.9–3.8% range at the same age, a structural break that implies terminal recovery of 5–8% vs Q1 2025's 51%. The V6 vintage bucket (write-offs 18+ Months on Book) has grown to 25% of the book at a 0.79% RoR, while the blended rate improvement over six months is being driven by older high-recovery cohorts running off rather than genuine improvement in collection effectiveness within any segment. The current month is running at 0.54% of POS by day 26 vs 0.49% at the same point last month — 5 basis points ahead — suggesting the month will close near or slightly above last month's level if pace holds.

# **Potential Risk**: Andhra Pradesh holds ₹102 Mio — the second-largest state exposure — and its RoR has fallen from 2.08% to 1.03% month-on-month, a 1.05pp drop that is the sharpest balance-weighted geographic drag on the blended rate this month.

# **Focus**: Watch the Q1 2026 cohort at M6 (due next month): Q3 2025 reached 5.8% and Q4 2025 reached 7.3% at M6, both well below Q1 2025's 44.4% at the same age — if Q1 2026 comes in below 6% at M6, it confirms the structural break is not a one-quarter anomaly and the terminal recovery gap on 2025–2026 vintages will widen further.
# """.strip()



# # ── Label normalisation ────────────────────────────────────────────────────────
# _BRIEF_LABELS_RE = re.compile(
#     r"(?m)^(\*{0,2})(Verdict|Key Observations?|Potential Risk|Observation|Focus)(\*{0,2})(:)",
#     re.IGNORECASE,
# )

# _LABEL_MAP = {
#     "verdict":           "Verdict",
#     "key observations":  "Key Observations",
#     "key observation":   "Key Observations",
#     "potential risk":    "Potential Risk",
#     "observation":       "Potential Risk",
#     "focus":             "Focus",
# }


# def _normalise_brief_labels(text: str) -> str:
#     def _replace(m):
#         label = _LABEL_MAP.get(m.group(2).lower(), m.group(2))
#         return f"**{label}**:"
#     return _BRIEF_LABELS_RE.sub(_replace, text)


# # ── Output cleaning ────────────────────────────────────────────────────────────
# _KNOWN_LABELS = re.compile(
#     r"^\*\*(Verdict|Key Observations|Potential Risk|Focus)\*\*:",
#     re.IGNORECASE,
# )


# def _clean_brief(text: str) -> str:
#     """
#     Remove three formatting artifacts the LLM sometimes produces:
#     1. A leading bullet/title line before the first paragraph label
#        e.g.  "• GROUP LOAN — May 2026"  or  "GROUP LOAN — May 2026"
#     2. Stray ** immediately after a paragraph label colon
#        e.g.  "**Verdict**: ** Overall..." → "**Verdict**: Overall..."
#     3. Leading ** on any non-label line
#        e.g.  "** The recoverable book..." → "The recoverable book..."
#     """
#     lines = text.strip().split("\n")

#     # 1. Strip leading non-label lines that look like a title or bullet
#     while lines:
#         first = lines[0].strip()
#         if not first:
#             lines.pop(0)
#             continue
#         if _KNOWN_LABELS.match(first):
#             break  # reached first real paragraph — stop
#         is_bullet  = first.startswith(("•", "-", "#"))
#         is_title   = ("—" in first or "–" in first) and len(first) < 80 and not first[0].isalpha()
#         is_stray   = first.startswith("**") and not _KNOWN_LABELS.match(first) and len(first) < 80
#         if is_bullet or is_title or is_stray:
#             lines.pop(0)
#         else:
#             break

#     text = "\n".join(lines)

#     # 2. Strip ** that bleeds into content right after a label colon
#     #    "**Verdict**: ** Overall..." → "**Verdict**: Overall..."
#     text = re.sub(
#         r"(\*\*(?:Verdict|Key Observations|Potential Risk|Focus)\*\*:)\s*\*{1,2}\s*",
#         r"\1 ",
#         text,
#         flags=re.IGNORECASE,
#     )

#     # 3. Strip leading ** from any non-label line
#     def _fix_line(line: str) -> str:
#         stripped = line.strip()
#         if _KNOWN_LABELS.match(stripped):
#             return line  # keep label lines untouched
#         return re.sub(r"^\s*\*{1,2}\s+", "", line)

#     lines = [_fix_line(ln) for ln in text.split("\n")]
#     return "\n".join(lines).strip()


# # ── Serialiser ─────────────────────────────────────────────────────────────────
# def _serialize_overview(obj):
#     if isinstance(obj, set):
#         return list(obj)
#     if hasattr(obj, "__dict__"):
#         return str(obj)
#     raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


# # ── Main brief generator ───────────────────────────────────────────────────────
# def generate_brief(group_key: str, product_name: str, overview: dict) -> str:
#     synthetic_call_id = "call_prefetch_0"

#     # Latest closed portfolio month from trend
#     trend              = overview.get("portfolio_trend") or []
#     analysis_month     = trend[-1]["year_month"] if trend else "unknown"
#     analysis_month_ror = trend[-1].get("recovery_percentage") if trend else None

#     # Identify which month the tile's last_month_* fields refer to
#     tile          = overview.get("recovery_tile") or {}
#     tile_last_ror = tile.get("last_month_ror_pct")
#     tile_ref_month = None
#     if tile_last_ror is not None:
#         for t in trend:
#             if t.get("recovery_percentage") is not None and abs(t["recovery_percentage"] - tile_last_ror) < 1e-4:
#                 tile_ref_month = t["year_month"]
#                 break
#     if tile_ref_month is None and len(trend) >= 2:
#         tile_ref_month = trend[-2]["year_month"]

#     tile_lags = (tile_ref_month != analysis_month)

#     # MTD pacing helpers
#     mtd        = overview.get("mtd_pacing") or {}
#     pacing_day = mtd.get("tile_anchor_day") or mtd.get("latest_day_of_month")

#     cm     = mtd.get("CM") or {}
#     pm     = mtd.get("PM_same_day") or {}
#     pm_end = mtd.get("PM_month_end") or {}
#     pm1    = mtd.get("PM+1") or mtd.get("PM1") or {}

#     def _pct(val, decimals=4):
#         if val is None:
#             return "n/a"
#         return f"{round(val * 100, decimals)}%"

#     def _mio(val):
#         return f"₹{val}m" if val is not None else "n/a"

#     # Tile lag note
#     tile_lag_note = (
#         f"  NOTE: tile last_month refers to {tile_ref_month} (RoR {_pct(tile_last_ror)}), "
#         f"NOT {analysis_month}. The tile pipeline has not yet rolled to {analysis_month}. "
#         f"Use portfolio_trend for {analysis_month} closed performance "
#         f"(RoR {_pct(analysis_month_ror)}). Do NOT use tile last_month figures "
#         f"as {analysis_month} benchmarks.\n"
#     ) if tile_lags else (
#         f"  Tile last_month matches portfolio_trend latest: {analysis_month} "
#         f"(RoR {_pct(tile_last_ror)}).\n"
#     )

#     # MTD block
#     pipeline_note = mtd.get("pipeline_note", "")
#     if pipeline_note:
#         mtd_block = (
#             f"MTD NOTE: {pipeline_note}\n"
#             f"  Settled reference ({mtd.get('settled_reference_month', {}).get('year_month', '?')} "
#             f"day {pacing_day}): RoR {_pct(mtd.get('settled_reference_month', {}).get('recovery_pct_of_bom'))}, "
#             f"recovery {_mio(mtd.get('settled_reference_month', {}).get('recovery_mio'))}\n"
#             f"  Prior month full close ({pm_end.get('year_month', '?')}): "
#             f"RoR {_pct(pm_end.get('recovery_pct_of_bom'))}\n"
#         )
#     else:
#         mtd_block = (
#             f"MTD pacing (all figures at day {pacing_day} — tile anchor day):\n"
#             f"  Current month  ({cm.get('year_month', '?')} day {pacing_day}): "
#             f"RoR {_pct(cm.get('recovery_pct_of_bom'))}, "
#             f"recovery {_mio(cm.get('recovery_mio'))}\n"
#             f"  Prior month same day ({pm.get('year_month', '?')} day {pacing_day}): "
#             f"RoR {_pct(pm.get('recovery_pct_of_bom'))}, "
#             f"recovery {_mio(pm.get('recovery_mio'))}\n"
#             f"  Prior month full close ({pm_end.get('year_month', '?')}): "
#             f"RoR {_pct(pm_end.get('recovery_pct_of_bom'))}\n"
#             f"  PM+1 same day ({pm1.get('year_month', '?')} day {pacing_day}): "
#             f"RoR {_pct(pm1.get('recovery_pct_of_bom'))}\n"
#             f"  Max data available through day {mtd.get('latest_day_of_month', '?')} "
#             f"(do not cite figures beyond day {pacing_day} — tile anchor).\n"
#         )

#     context_note = (
#         f"Analysis context — read before writing:\n"
#         f"Latest closed portfolio month: {analysis_month} "
#         f"(RoR {_pct(analysis_month_ror)} from portfolio_trend — primary reference).\n"
#         f"{tile_lag_note}"
#         f"{mtd_block}"
#         f"Never cite a recovery figure for any day not listed above.\n"
#         f"Never use 'last month' without naming the month explicitly.\n"
#         f"Do not output a title, header, or bullet line. Start directly with **Verdict**:\n"
#     )

#     user_msg = (
#         f"Give me a recovery overview of {product_name} (group_key: {group_key}).\n\n"
#         f"{context_note}"
#     )

#     messages = [
#         {"role": "system", "content": CRO_RECOVERY_SKILL_PROMPT},
#         {"role": "user",   "content": user_msg},
#         {
#             "role": "assistant",
#             "content": None,
#             "tool_calls": [{
#                 "id":   synthetic_call_id,
#                 "type": "function",
#                 "function": {
#                     "name":      "getRecoveryOverview",
#                     "arguments": json.dumps({"product_name": product_name, "group_key": group_key}),
#                 },
#             }],
#         },
#         {
#             "role":         "tool",
#             "tool_call_id": synthetic_call_id,
#             "content":      json.dumps(overview, default=str),
#         },
#     ]

#     endpoint    = os.environ["AZURE_OPENAI_ENDPOINT"].rstrip("/")
#     deployment  = os.environ["AZURE_OPENAI_DEPLOYMENT"]
#     api_version = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
#     api_key     = os.environ["AZURE_OPENAI_API_KEY"]
#     url         = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"

#     resp = requests.post(
#         url,
#         headers={"api-key": api_key, "Content-Type": "application/json"},
#         json={"messages": messages, "max_completion_tokens": 8000},
#         timeout=120,
#     )
#     resp.raise_for_status()
#     data    = resp.json()
#     content = (data["choices"][0]["message"].get("content") or "").strip()

#     if content:
#         content = _normalise_brief_labels(content)
#         content = _clean_brief(content)
#     return content

# # COMMAND ----------
# # MAGIC %md ## 6. Per-product worker + batch runner

# # COMMAND ----------

# import pandas as pd
# from concurrent.futures import ThreadPoolExecutor, as_completed


# def process_product(group_key: str, query_key: str) -> dict:
#     display_name = group_key
#     overview = get_local_product_overview(query_key, group_key)
#     if overview is None:
#         return {
#             "product_name": display_name,
#             "group_key":    group_key,
#             "query_key":    query_key,
#             "insight_text": f"Error: could not fetch product overview for {query_key}",
#             "status":       "error",
#             "error":        f"could not fetch product overview for {query_key}",
#         }

#     brief    = generate_brief(group_key, display_name, overview)
#     is_error = (not brief) or brief.startswith("Error:")
#     return {
#         "product_name": display_name,
#         "group_key":    group_key,
#         "query_key":    query_key,
#         "insight_text": brief,
#         "status":       "error" if is_error else "success",
#         "error":        brief if is_error else None,
#     }


# def run_batch_analysis(products=None, concurrency=CONCURRENCY) -> list[dict]:
#     print("🔍 Fetching product list...")
#     product_map = fetch_products_from_db()

#     if products is not None:
#         requested = {p.upper() for p in products}
#         product_map = {
#             gk: qk for gk, qk in product_map.items()
#             if gk.upper() in requested or qk.upper() in requested
#         }
#         found   = {gk.upper() for gk in product_map} | {qk.upper() for qk in product_map.values()}
#         missing = requested - found
#         if missing:
#             print(f"⚠️  Not found in DB: {missing}")

#     product_list = list(product_map.keys())
#     total = len(product_list)

#     print("=" * 60)
#     print(f"BATCH RECOVERY ANALYSIS — {total} products, {concurrency} workers")
#     print("=" * 60)

#     completed = 0
#     records: list[dict] = []

#     with ThreadPoolExecutor(max_workers=concurrency) as executor:
#         futures = {
#             executor.submit(process_product, gk, product_map[gk]): gk
#             for gk in product_list
#         }
#         for future in as_completed(futures):
#             pn = futures[future]
#             completed += 1
#             try:
#                 record = future.result()
#                 records.append(record)
#                 brief  = record.get("insight_text", "") or ""
#                 status = "✅" if record.get("status") == "success" else "❌"
#                 print(f"[{completed}/{total}] {status} {pn} ({len(brief)} chars)")
#             except Exception as e:
#                 records.append({
#                     "product_name": pn,
#                     "group_key":    pn,
#                     "query_key":    pn,
#                     "insight_text": f"Error: {e}",
#                     "status":       "error",
#                     "error":        str(e),
#                 })
#                 print(f"[{completed}/{total}] ❌ {pn} — {e}")

#     success = sum(1 for r in records if r.get("status") == "success")
#     print("=" * 60)
#     print(f"✅ {success}/{total} products completed successfully")
#     print("=" * 60)
#     return records

# # COMMAND ----------
# # MAGIC %md ## 7. Push to PostgreSQL

# # COMMAND ----------

# from datetime import timezone
# from psycopg2.extras import execute_batch


# def normalize_product_key(gk: str) -> str:
#     """B2B_B2B → B2B; asymmetric keys stay as-is."""
#     parts = gk.rsplit("_", 1)
#     if len(parts) == 2 and parts[0].upper() == parts[1].upper():
#         return parts[0]
#     return gk


# def push_records_to_db(records: list[dict], dataset: str = "recovery", db_config: dict | None = None) -> dict:
#     """
#     Per-product delete + insert into the insights table.
#     Skips records with status != 'success'.
#     """
#     dataset_key = dataset.strip().lower()
#     if dataset_key == "recovery":
#         table, content_col = "recovery_diagnostics.portfolio_ai_insights", "portfolio"
#     elif dataset_key == "collection":
#         table, content_col = "collections_diagnostics.portfolio_ai_insights", "hotspot"
#     else:
#         raise ValueError("dataset must be 'recovery' or 'collection'")

#     rows = [
#         (
#             normalize_product_key(str(r.get("product_name", "")).strip()),
#             str(r.get("insight_text", "")).strip(),
#         )
#         for r in records
#         if (r.get("status") or "success").lower() == "success"
#            and r.get("product_name") and r.get("insight_text")
#     ]

#     if not rows:
#         print("⚠️  No successful records to push.")
#         return {"inserted": 0, "deleted": 0, "processed": 0, "table": table}

#     cfg          = db_config or DB_CONFIG
#     generated_at = datetime.now(timezone.utc)
#     delete_sql   = f"DELETE FROM {table} WHERE product_name = %s"
#     insert_sql   = (
#         f"INSERT INTO {table} (product_name, {content_col}, generated_at_utc) "
#         f"VALUES (%s, %s, %s)"
#     )

#     conn = psycopg2.connect(**cfg)
#     deleted = 0
#     try:
#         with conn.cursor() as cur:
#             for product_name, _ in rows:
#                 cur.execute(delete_sql, (product_name,))
#                 deleted += cur.rowcount
#             execute_batch(
#                 cur,
#                 insert_sql,
#                 [(p, t, generated_at) for p, t in rows],
#                 page_size=200,
#             )
#         conn.commit()
#     finally:
#         conn.close()

#     result = {
#         "inserted":         len(rows),
#         "deleted":          deleted,
#         "processed":        len(rows),
#         "table":            table,
#         "generated_at_utc": generated_at.isoformat(),
#     }
#     print("Push result:", result)
#     return result

# # COMMAND ----------
# # MAGIC %md ## 8. Run

# # COMMAND ----------

# # ── Step 1: Run analysis ───────────────────────────────────────────────────────
# records = run_batch_analysis(products=PRODUCTS, concurrency=CONCURRENCY)
# df      = pd.DataFrame(records)

# print(f"\nGenerated rows: {len(df)}")
# display(df[["product_name", "status", "insight_text"]].head(20))

# # COMMAND ----------

# # ── Step 2: Push to DB ─────────────────────────────────────────────────────────
# push_result = push_records_to_db(records, dataset="recovery", db_config=DB_CONFIG)
# print(push_result)

# COMMAND ----------

# MAGIC %md
# MAGIC Optimized Version

# COMMAND ----------

# Databricks notebook source
# recovery_insights_job.py  (INSTRUMENTED + OPTIMIZED)
#
# Ported from the collections job. What changed vs the original recovery code:
#   #1  Zero instrumentation          -> RUN_ID, per-phase db timing, db_ms/llm_ms,
#                                        token + cached + reasoning accounting, OTel
#   #2  requests.post                 -> AzureOpenAI SDK (retries, timeout, token usage)
#   #3  No reasoning_effort           -> "low"  (measured 2x faster than medium)
#   #4  No prompt caching             -> prompt_cache_key = "cro-recovery-v1"
#   #5  New DB connection per product -> ThreadedConnectionPool
#   #6  4x portfolio_value queries    -> 1 batched query, split in pandas
#   #7  CONCURRENCY 10                -> 30
#   #8  DELETE loop in push           -> DELETE ... WHERE product_name = ANY(%s)
#   #9  No empty-records guard        -> added
#
# NOT ported (did not apply):
#   - LOWER(TRIM(...)) removal — recovery already used plain `=`
#   - N+1 hotspot batching — recovery has no hotspot loop
#
# NO business logic / prompt changes.

# COMMAND ----------

# =============================================================================
# CLUSTER LIBRARIES  (install on the cluster; do NOT %pip install here)
# =============================================================================
#   psycopg2-binary
#   openai
#   azure-identity
#   azure-keyvault-secrets
#   azure-monitor-opentelemetry
#   opentelemetry-instrumentation-openai-v2
#
# %pip does not reach the already-running Python session, which is why OTel
# silently failed with "No module named 'azure.monitor'" on every run.

# COMMAND ----------

# =============================================================================
# CELL 1 — CONFIG
# =============================================================================

KEY_VAULT_URL            = "https://RiskubeProd-KV.vault.azure.net/"
DB_URL_SECRET_NAME       = "cl01-dev-db-url"
AOAI_API_KEY_SECRET_NAME = "azure-openai-api-key"

AZURE_OPENAI_ENDPOINT    = "https://genai-monish-openai.cognitiveservices.azure.com"
AZURE_OPENAI_DEPLOYMENT  = "gpt-5-mini"
AZURE_OPENAI_API_VERSION = "2024-12-01-preview"

PRODUCTS    = None   # None = all products from DB; e.g. ["RLAP", "GEL"]
CONCURRENCY = 30

# --- LLM config --------------------------------------------------------------
MAX_COMPLETION_TOKENS = 8000
# gpt-5-mini is a reasoning model — this cap covers reasoning tokens AND visible
# output. Lowering it to 1500 on the collections job produced 0-char briefs on
# all 65 products. Do not lower.

REASONING_EFFORT      = "low"    # none | minimal | low | medium | high
# Measured on collections: medium = 37-65s/product with ~4k reasoning tokens
# discarded per call; low = 15-20s/product. Same model, same 4-para output shape.

PROMPT_CACHE_KEY      = "cro-recovery-v1"   # distinct from the collections key

LLM_MAX_RETRIES       = 3
LLM_TIMEOUT_S         = 120

# --- DB config ---------------------------------------------------------------
DB_POOL_MIN = 2
DB_POOL_MAX = CONCURRENCY + 2
# Check Postgres max_connections before raising CONCURRENCY further.

# --- Observability config ----------------------------------------------------
APPINSIGHTS_CONNECTION_STRING = "InstrumentationKey=cd61b329-7ff0-4d50-a7f2-8a84427aae55;IngestionEndpoint=https://southindia-0.in.applicationinsights.azure.com/;LiveEndpoint=https://southindia.livediagnostics.monitor.azure.com/;ApplicationId=325aaeb3-21b8-4e5f-b8dc-049273776aeb"

ENABLE_OTEL             = True
CAPTURE_MESSAGE_CONTENT = False
OTEL_SERVICE_NAME       = "recovery-insights-job"

# COMMAND ----------

# =============================================================================
# CELL 2 — LOAD SECRETS
# =============================================================================

import os
from urllib.parse import urlparse

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient


def _kv_client() -> SecretClient:
    return SecretClient(vault_url=KEY_VAULT_URL, credential=DefaultAzureCredential())


def load_aoai_env() -> None:
    kv = _kv_client()
    os.environ["AZURE_OPENAI_ENDPOINT"]    = AZURE_OPENAI_ENDPOINT
    os.environ["AZURE_OPENAI_API_KEY"]     = kv.get_secret(AOAI_API_KEY_SECRET_NAME).value
    os.environ["AZURE_OPENAI_API_VERSION"] = AZURE_OPENAI_API_VERSION
    os.environ["AZURE_OPENAI_DEPLOYMENT"]  = AZURE_OPENAI_DEPLOYMENT
    print("✅ AOAI env loaded")


def load_db_env() -> dict:
    kv     = _kv_client()
    db_url = kv.get_secret(DB_URL_SECRET_NAME).value
    parsed = urlparse(db_url)

    cfg = {
        "host":     parsed.hostname or "",
        "port":     parsed.port or 5432,
        "database": (parsed.path or "").lstrip("/"),
        "user":     parsed.username or "",
        "password": parsed.password or "",
    }
    os.environ["DB_HOST"]     = cfg["host"]
    os.environ["DB_PORT"]     = str(cfg["port"])
    os.environ["DB_NAME"]     = cfg["database"]
    os.environ["DB_USER"]     = cfg["user"]
    os.environ["DB_PASSWORD"] = cfg["password"]

    print(f"✅ DB env loaded — host={cfg['host']}  db={cfg['database']}  user={cfg['user']}")
    return cfg


print("Loading secrets...")
load_aoai_env()
DB_CONFIG = load_db_env()

# COMMAND ----------

# =============================================================================
# CELL 2b — OBSERVABILITY SETUP
# =============================================================================

import logging
import time
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-5s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
    force=True,
)
log = logging.getLogger("recovery_job")
log.setLevel(logging.INFO)

# ---- RUN_ID: stamped on every span so runs are distinguishable in Foundry ----
RUN_ID = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:6]}"
log.info(f"RUN_ID = {RUN_ID}")

_OTEL_READY = False
_tracer     = None
_otel_ctx   = None

if ENABLE_OTEL:
    try:
        os.environ.setdefault("OTEL_SERVICE_NAME", OTEL_SERVICE_NAME)

        from azure.monitor.opentelemetry import configure_azure_monitor
        from opentelemetry import trace, context as _otel_ctx
        from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor

        if CAPTURE_MESSAGE_CONTENT:
            os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "true"

        configure_azure_monitor(
            connection_string=APPINSIGHTS_CONNECTION_STRING,
            instrumentation_options={
                "psycopg2": {"enabled": False},
                "django":   {"enabled": False},
                "flask":    {"enabled": False},
                "fastapi":  {"enabled": False},
                "requests": {"enabled": False},
                "urllib":   {"enabled": False},
                "urllib3":  {"enabled": False},
            },
        )
        OpenAIInstrumentor().instrument()
        _tracer     = trace.get_tracer("recovery_job")
        _OTEL_READY = True
        log.info("OTel configured ✅  traces → Foundry / App Insights")
    except Exception as e:
        log.warning(f"OTel setup failed ({e}); continuing with structured logs only")
        log.warning("  → install azure-monitor-opentelemetry as a CLUSTER library, not %pip")
else:
    log.info("OTel disabled by config; structured logs only")


@contextmanager
def span(name: str, **attrs):
    """OTel span (if configured) + always-on timer. Never raises on telemetry
    issues. RUN_ID injected automatically so every span is filterable by run."""
    attrs.setdefault("run_id", RUN_ID)
    start = time.perf_counter()
    if _OTEL_READY and _tracer is not None:
        with _tracer.start_as_current_span(name) as sp:
            try:
                for k, v in attrs.items():
                    sp.set_attribute(k, v)
            except Exception:
                pass
            try:
                yield sp
            finally:
                _emit_timing(name, start, attrs)
    else:
        try:
            yield None
        finally:
            _emit_timing(name, start, attrs)


def _emit_timing(name, start, attrs):
    dur_ms = (time.perf_counter() - start) * 1000.0
    tail   = " ".join(f"{k}={v}" for k, v in attrs.items() if k not in ("self", "run_id"))
    log.info(f"⏱  {name} took {dur_ms:8.1f} ms   {tail}")


def _record_tokens(sp, prompt_t, completion_t, total_t):
    if sp is not None:
        try:
            sp.set_attribute("gen_ai.usage.input_tokens",  int(prompt_t or 0))
            sp.set_attribute("gen_ai.usage.output_tokens", int(completion_t or 0))
            sp.set_attribute("gen_ai.usage.total_tokens",  int(total_t or 0))
        except Exception:
            pass
    log.info(f"🔢 tokens  in={prompt_t}  out={completion_t}  total={total_t}")


def _with_context(fn, *args, **kwargs):
    """Makes worker-thread spans nest under the batch span."""
    if _OTEL_READY and _otel_ctx is not None:
        parent = _otel_ctx.get_current()
        def _runner():
            token = _otel_ctx.attach(parent)
            try:
                return fn(*args, **kwargs)
            finally:
                _otel_ctx.detach(token)
        return _runner
    return lambda: fn(*args, **kwargs)


class PhaseTimer:
    """Accumulates named phase durations for one product's DB fetch."""
    def __init__(self):
        self.phases = {}

    @contextmanager
    def __call__(self, name):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.phases[name] = round((time.perf_counter() - t0) * 1000.0, 1)

    def summary(self):
        return " ".join(f"{k}={v}ms" for k, v in self.phases.items())


# ---- Token accounting rollup -------------------------------------------------
_TOKENS_LOCK = threading.Lock()
TOKEN_TOTALS = {"prompt": 0, "completion": 0, "total": 0,
                "cached": 0, "reasoning": 0, "calls": 0}

def _add_tokens(prompt_t, completion_t, total_t, cached_t=None, reasoning_t=None):
    with _TOKENS_LOCK:
        TOKEN_TOTALS["prompt"]     += int(prompt_t or 0)
        TOKEN_TOTALS["completion"] += int(completion_t or 0)
        TOKEN_TOTALS["total"]      += int(total_t or 0)
        TOKEN_TOTALS["cached"]     += int(cached_t or 0)
        TOKEN_TOTALS["reasoning"]  += int(reasoning_t or 0)
        TOKEN_TOTALS["calls"]      += 1

# COMMAND ----------

# =============================================================================
# CELL 3 — DB UTILITIES  (pooled)
# =============================================================================

import traceback
import psycopg2
from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import execute_batch

_SEARCH_PATH = (
    "-c search_path=mtd_recovery,recovery,recovery_portfolio,"
    "recovery_mix_impact,recovery_vintage,recovery_home,"
    "recovery_daily_payments,recovery_diagnostics"
)

_DB_KW = dict(
    host=os.getenv("DB_HOST"),
    port=os.getenv("DB_PORT", "5432"),
    dbname=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    options=_SEARCH_PATH,
)

# One pool for the whole job — no TCP/SSL/auth handshake per product.
db_pool = ThreadedConnectionPool(minconn=DB_POOL_MIN, maxconn=DB_POOL_MAX, **_DB_KW)
log.info(f"DB pool created ✅  min={DB_POOL_MIN} max={DB_POOL_MAX}")


@contextmanager
def db_conn():
    """Borrow a pooled connection; always return it, even on error."""
    conn = db_pool.getconn()
    try:
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        db_pool.putconn(conn)


def _q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_products_from_db() -> dict:
    """Returns {group_key: query_key} from recovery_home.v1_recovery_tile."""
    with span("db.fetch_products"):
        with db_conn() as conn:
            rows = _q(conn, """
                SELECT DISTINCT product_group, group_key
                FROM recovery_home.v1_recovery_tile
                WHERE group_key IS NOT NULL
                ORDER BY group_key
            """)
        return {r["group_key"]: r["group_key"] for r in rows}

# COMMAND ----------

# =============================================================================
# CELL 4 — DATA PRE-FETCH (per product)
#
# OPT #6: the original ran 4 separate queries against portfolio_value (filter =
# 'all' / 'pos_bin' / 'wo_mob_bin' / 'state_mapped'), each with its own
# MAX(datetime) latest/prev CTE over the same table. Collapsed into ONE query
# using DENSE_RANK() over filter, then split in Python.
# Verified: 1 query @ 1.8ms replaces 4 @ ~1.7ms each, same rows out.
# =============================================================================

from datetime import date


def _fmt_month(val):
    if val is None:
        return None
    return val.strftime("%b-%y") if hasattr(val, "strftime") else str(val)


def _mio(v):
    return round(v / 1e6, 2) if v else None


def _pct6(v):
    return round(v, 6) if v else None


def _mtd_at_day(rows, status, day):
    pts = [r for r in rows if r["date_status"] == status and r["date_index"] == day]
    if not pts:
        return None
    r = pts[0]
    return {
        "day_of_month":        day,
        "year_month":          r["year_month"],
        "recovery_mio":        round(r["total_recovery"] / 1e6, 3) if r["total_recovery"] else None,
        "recovery_pct_of_bom": _pct6(r["recovery_percentage"]),
        "bom_pos_mio":         _mio(r["total_balance"]),
    }


def _delta_pp(cur, prev):
    return round(cur - prev, 6) if (cur and prev) else None


def get_local_product_overview(product_name: str, group_key: str):
    gk, pn = group_key.strip(), product_name.strip()
    ph = PhaseTimer()

    try:
        with db_conn() as conn:

            # ── 1. Recovery tile ──────────────────────────────────────────────
            with ph("tile"):
                tile_rows = _q(conn, """
                    SELECT product_group, group_key,
                           last_month_pos_mn, last_mtd_pos_mn, current_mtd_pos_mn, pos_change_pct,
                           last_month_recovery_mn, last_mtd_recovery_mn, current_mtd_recovery_mn,
                           recovery_change_pct,
                           last_month_ror_pct, last_mtd_ror_pct, current_mtd_ror_pct, ror_change_pct
                    FROM recovery_home.v1_recovery_tile
                    WHERE group_key = %s LIMIT 1
                """, (gk,))
            recovery_tile = dict(tile_rows[0]) if tile_rows else None

            # ── 2. portfolio_value — ALL FOUR FILTERS IN ONE QUERY ────────────
            # dr = 1 is the latest month for that filter, dr = 2 the previous.
            # 'all' needs 6 months of trend; the rest need current + prev only.
            with ph("portfolio_value_batched"):
                pv_rows = _q(conn, """
                    WITH ranked AS (
                        SELECT filter, subsegment, year_month, datetime,
                               total_balance, total_recovery, recovery_percentage,
                               DENSE_RANK() OVER (
                                   PARTITION BY filter ORDER BY datetime DESC
                               ) AS dr
                        FROM recovery_portfolio.portfolio_value
                        WHERE product_name = %s
                          AND filter IN ('all', 'pos_bin', 'wo_mob_bin', 'state_mapped')
                    )
                    SELECT filter, subsegment, year_month, dr,
                           total_balance, total_recovery, recovery_percentage
                    FROM ranked
                    WHERE (filter = 'all'  AND dr <= 6)
                       OR (filter <> 'all' AND dr <= 2)
                    ORDER BY filter, dr, total_balance DESC
                """, (pn,))

            def _pv(flt, rank):
                return [r for r in pv_rows if r["filter"] == flt and r["dr"] == rank]

            def _prev_lookup(flt):
                return {r["subsegment"]: r["recovery_percentage"] for r in _pv(flt, 2)}

            # --- 2a. Portfolio trend (6 months, oldest → newest) --------------
            trend_rows = sorted(
                [r for r in pv_rows if r["filter"] == "all" and r["subsegment"] == "all"],
                key=lambda r: r["dr"], reverse=True,
            )
            portfolio_trend = [
                {
                    "year_month":          r["year_month"],
                    "total_balance_mio":   _mio(r["total_balance"]),
                    "total_recovery_mio":  _mio(r["total_recovery"]),
                    "recovery_percentage": _pct6(r["recovery_percentage"]),
                }
                for r in trend_rows
            ]

            # --- 2b. POS mix (top 8 by balance, with prev-month delta) --------
            pos_cur   = _pv("pos_bin", 1)
            pos_prev  = _prev_lookup("pos_bin")
            pos_total = sum(r["total_balance"] or 0 for r in pos_cur)
            pos_mix = [
                {
                    "subsegment":          r["subsegment"],
                    "total_balance_mio":   _mio(r["total_balance"]),
                    "recovery_percentage": _pct6(r["recovery_percentage"]),
                    "recovery_pct_prev":   _pct6(pos_prev.get(r["subsegment"])),
                    "delta_pp":            _delta_pp(r["recovery_percentage"],
                                                     pos_prev.get(r["subsegment"])),
                    "contribution_pct":    round(r["total_balance"] / pos_total * 100, 2)
                                           if (r["total_balance"] and pos_total) else None,
                }
                for r in pos_cur[:8]
            ]

            # --- 2c. WO MOB vintage mix --------------------------------------
            vm_cur   = sorted(_pv("wo_mob_bin", 1), key=lambda r: str(r["subsegment"]))
            vm_prev  = _prev_lookup("wo_mob_bin")
            vm_total = sum(r["total_balance"] or 0 for r in vm_cur)
            vintage_mix = [
                {
                    "year_month":        r["year_month"],
                    "bucket":            r["subsegment"],
                    "balance_mio":       _mio(r["total_balance"]),
                    "contribution_pct":  round(r["total_balance"] / vm_total * 100, 2)
                                         if (r["total_balance"] and vm_total) else None,
                    "recovery_pct":      _pct6(r["recovery_percentage"]),
                    "recovery_pct_prev": _pct6(vm_prev.get(r["subsegment"])),
                    "delta_pp":          _delta_pp(r["recovery_percentage"],
                                                   vm_prev.get(r["subsegment"])),
                }
                for r in vm_cur
            ]

            # --- 2d. State breakdown (top 8 by balance) ----------------------
            st_cur  = _pv("state_mapped", 1)
            st_prev = _prev_lookup("state_mapped")
            state_breakdown = [
                {
                    "state":             r["subsegment"],
                    "balance_mio":       _mio(r["total_balance"]),
                    "recovery_pct":      _pct6(r["recovery_percentage"]),
                    "recovery_pct_prev": _pct6(st_prev.get(r["subsegment"])),
                    "delta_pp":          _delta_pp(r["recovery_percentage"],
                                                   st_prev.get(r["subsegment"])),
                }
                for r in st_cur[:8]
            ]

            # ── 3. Mix impact (last 3 months) ─────────────────────────────────
            with ph("mix_impact"):
                mix_rows = _q(conn, """
                    SELECT year_month, filter, subsegment, total_balance, total_recovery,
                           recovery_percentage, percentage_contribution, all_balance
                    FROM recovery_mix_impact.mix_impact_value
                    WHERE product_name = %s AND filter IN ('pos_bin', 'wo_mob_bin')
                    ORDER BY year_month DESC, filter, total_balance DESC LIMIT 24
                """, (pn,))
            mix_impact = [
                {
                    "year_month":              r["year_month"],
                    "filter":                  r["filter"],
                    "subsegment":              r["subsegment"],
                    "total_balance_mio":       _mio(r["total_balance"]),
                    "recovery_percentage":     _pct6(r["recovery_percentage"]),
                    "percentage_contribution": _pct6(r["percentage_contribution"]),
                }
                for r in mix_rows
            ]

            # ── 4. Vintage curves ─────────────────────────────────────────────
            with ph("vintage_curves"):
                vcurve_rows = _q(conn, """
                    SELECT quarter, month, percentage_value
                    FROM recovery_vintage.vintage
                    WHERE product_name = %s AND filter = 'ALL' AND subsegment = 'ALL'
                      AND quarter IS NOT NULL AND percentage_value IS NOT NULL
                    ORDER BY quarter, CAST(SUBSTRING(month FROM 2) AS INTEGER)
                """, (pn,))
            vcurves: dict = {}
            for r in vcurve_rows:
                vcurves.setdefault(r["quarter"], []).append({
                    "month": r["month"],
                    "cumulative_recovery_pct": _pct6(r["percentage_value"]),
                })
            vintage_curves = [{"quarter": q, "data": pts} for q, pts in vcurves.items()]

            # ── 5. MTD daily pacing ───────────────────────────────────────────
            # 324K rows — by far the biggest table in this job. Was a Parallel
            # Seq Scan at 48.6ms / 9,546 buffers before idx_mtdrp_gk_filter.
            with ph("mtd_pacing"):
                mtd_rows = _q(conn, """
                    SELECT date_index, date_status, year_month,
                           total_balance, total_recovery, recovery_percentage
                    FROM mtd_recovery.recovery_portfolio
                    WHERE group_key = %s
                      AND filter = 'all' AND subsegment = 'all'
                      AND "Metrics" = 'Value'
                      AND date_status IN ('current', 'previous', 'PM+1')
                    ORDER BY date_status, date_index
                """, (gk,))

        # ---- MTD derivation (no DB access below this line) -------------------
        cm_days     = [r["date_index"] for r in mtd_rows if r["date_status"] == "current"]
        latest_day  = max(cm_days, default=None)
        pm_days     = [r["date_index"] for r in mtd_rows if r["date_status"] == "previous"]
        pm_last_day = max(pm_days, default=latest_day)

        # Derive the day the tile is anchored to by matching current_mtd_ror_pct
        tile_current_ror = (recovery_tile or {}).get("current_mtd_ror_pct")
        pacing_day = None
        if tile_current_ror is not None:
            for r in mtd_rows:
                if (r["date_status"] == "current"
                        and r["recovery_percentage"] is not None
                        and abs(r["recovery_percentage"] - tile_current_ror) < 1e-6):
                    pacing_day = r["date_index"]
                    break
        if pacing_day is None:
            pacing_day = latest_day

        today             = date.today()
        cm_year_months    = {r["year_month"] for r in mtd_rows if r["date_status"] == "current"}
        cm_year_month_str = next(iter(cm_year_months), None)
        db_current_is_closed = False
        if cm_year_month_str:
            try:
                db_dt = datetime.strptime(cm_year_month_str, "%b %Y")
                if db_dt.month != today.month or db_dt.year != today.year:
                    db_current_is_closed = True
            except ValueError:
                pass

        if db_current_is_closed:
            mtd_pacing = {
                "latest_day_of_month": pm_last_day,
                "tile_anchor_day":     pacing_day,
                "pipeline_note": (
                    f"DB 'current' label is {cm_year_month_str} which is a closed month "
                    f"(today is {today.strftime('%d %b %Y')}). Pipeline has not rolled to "
                    f"{today.strftime('%B %Y')} yet. Treat {cm_year_month_str} as the settled "
                    f"reference month. No live MTD data available for {today.strftime('%B %Y')}."
                ),
                "settled_reference_month": _mtd_at_day(mtd_rows, "current", pacing_day),
                "PM_same_day":             None,
                "PM_month_end":            _mtd_at_day(mtd_rows, "previous", pm_last_day),
                "PM1":                     _mtd_at_day(mtd_rows, "PM+1", pacing_day),
                "CM":                      None,
            }
        else:
            mtd_pacing = {
                "latest_day_of_month": latest_day,
                "tile_anchor_day":     pacing_day,
                "CM":           _mtd_at_day(mtd_rows, "current",  pacing_day),
                "PM_same_day":  _mtd_at_day(mtd_rows, "previous", pacing_day),
                "PM_month_end": _mtd_at_day(mtd_rows, "previous", pm_last_day),
                "PM1":          _mtd_at_day(mtd_rows, "PM+1",     pacing_day),
            }

        log.info(f"🔎 db phases [{gk}]  {ph.summary()}")

        return {
            "recovery_tile":   recovery_tile,
            "portfolio_trend": portfolio_trend,
            "pos_mix":         pos_mix,
            "vintage_mix":     vintage_mix,
            "mix_impact":      mix_impact,
            "vintage_curves":  vintage_curves,
            "mtd_pacing":      mtd_pacing,
            "state_breakdown": state_breakdown,
        }

    except Exception as e:
        log.error(f"❌ DB error for {product_name}: {e}")
        traceback.print_exc()
        return None

# COMMAND ----------

# =============================================================================
# CELL 5 — LLM BRIEF GENERATION
# =============================================================================

import json
import re
from openai import AzureOpenAI

# ── System prompt (UNCHANGED) ──────────────────────────────────────────────────

CRO_RECOVERY_SKILL_PROMPT = """
# Recovery Portfolio Overview

Brief a recovery/collections manager in under 60 seconds. Give them everything they need to understand the recovery portfolio without opening a single dashboard. Verdict first. Cover portfolio balance, recovery rate direction, vintage performance, mix shift, daily pacing, and highest-risk segments — but only surface numbers that explain something non-obvious.

Your job is not to narrate the dashboard. A manager can read numbers themselves. Your job is to tell them what the numbers mean, whether the signals agree with each other, and what is actually at risk going forward.

---

## Data Dictionary

### Recovery Tile → `response.recovery_tile`

The tile now reports on a current-month-to-date (MTD) basis alongside last month actuals.
All balance and recovery figures are in INR Mn.

| Field | Meaning |
|---|---|
| `last_month_pos_mn` | Full prior month write-off POS (INR Mn) — the closed baseline |
| `last_mtd_pos_mn` | Prior month POS as of the same day-of-month as today (apples-to-apples MTD anchor) |
| `current_mtd_pos_mn` | Current month POS as of today |
| `pos_change_pct` | % change in POS: current_mtd vs last_mtd |
| `last_month_recovery_mn` | Full prior month recovery collected (INR Mn) |
| `last_mtd_recovery_mn` | Prior month recovery as of same day-of-month (MTD anchor) |
| `current_mtd_recovery_mn` | Current month recovery collected so far (INR Mn) |
| `recovery_change_pct` | % change in recovery: current_mtd vs last_mtd |
| `last_month_ror_pct` | Full prior month Rate of Recovery — use as the settled benchmark |
| `last_mtd_ror_pct` | Prior month RoR as of same day-of-month |
| `current_mtd_ror_pct` | Current month RoR so far |
| `ror_change_pct` | pp change in RoR: current_mtd vs last_mtd |

**Primary headline signals:**
- `current_mtd_ror_pct` vs `last_mtd_ror_pct` — is this month's rate running ahead or behind the same point last month?
- `last_month_ror_pct` — the fully settled prior month baseline; use as the target the current month is tracking toward.
- `current_mtd_pos_mn` vs `last_mtd_pos_mn` — is the recoverable book growing or shrinking MTD?

**Do not compare `current_mtd_recovery_mn` to `last_month_recovery_mn` directly** — one is partial-month, one is full-month. Always compare MTD-to-MTD or use RoR (which normalises for book size and timing).

---

### Portfolio Trend → `response.portfolio_trend`

6-month trend, oldest → newest. Each entry:

| Field | Meaning |
|---|---|
| `year_month` | Month label (e.g. "Mar 2026") |
| `total_balance` | Total write-off POS under recovery (INR Mio) |
| `total_recovery` | Total recovery collected that month (INR Mio) |
| `recovery_percentage` | Recovery rate for that month (%) |

**Use portfolio_trend to:**
- State whether the recoverable book is growing (more write-offs being added) or shrinking (book running off)
- Identify the direction and velocity of recovery rate changes over 6 months — is it improving, deteriorating, or volatile?
- Detect divergence: book growing fast while recovery rate is falling = dilution by fresh/lower-quality write-offs

---

### POS Mix → `response.pos_mix`

Latest month breakdown of the write-off book by POS band (product-specific bins like 0-50K, 50K-75K, 75K-1.0L, 1.0L+).

| Field | Meaning |
|---|---|
| `subsegment` | POS band label |
| `total_balance` | POS in this band (INR Mio) |
| `recovery_percentage` | Recovery rate for this band (%) |
| `contribution_pct` | This band's share of total write-off book (%) |

**Recovery rate gradient:** Smaller ticket sizes (0-50K) generally recover at higher rates; larger tickets (1.0L+) at lower rates. A mix shift toward smaller tickets is recovery-positive; a shift toward larger tickets is recovery-negative. Always state which direction the mix is moving and what it implies for the blended rate.

---

### Vintage Mix (WO MOB) → `response.vintage_mix`

V1 = written off 0–6 months ago (freshest), V2 = 7–12 months ago, ... V6 = oldest. Latest month only.

| Field | Meaning |
|---|---|
| `bucket` | V1 through V6 |
| `balance_mio` | POS in this vintage bucket (INR Mio) |
| `contribution_pct` | This bucket's share of the total write-off book (%) |
| `recovery_pct` | Recovery rate this month (%) |
| `recovery_pct_prev` | Recovery rate prior month (%) — use to compute MoM delta per bucket |

**Vintage interpretation:**
- V1 (fresh write-offs) typically recovers best early — high V1 contribution is recovery-positive if the rate holds
- V2–V3 = mid-aging, where recovery rate decay is most visible
- V4–V6 (old/stale write-offs) = usually lowest recovery rates — high contribution here drags the blended rate
- A growing V6 share with low RoR signals the book is aging without being resolved — structural drag
- Compare V1 RoR vs V2 RoR vs V3 RoR: a sharp drop from V1 to V2 means the fresh recovery window closes fast

---

### Mix Impact → `response.mix_impact`

Last 3 months. Shows whether changes in the blended recovery rate are driven by the mix shifting OR by genuine rate improvement within segments.

| Field | Meaning |
|---|---|
| `year_month` | Month |
| `subsegment` | POS band or vintage bucket |
| `recovery_percentage` | This segment's RoR that month |
| `percentage_contribution` | This segment's share of the book that month (%) |

**How to read mix impact:**
- If a low-RoR segment's `percentage_contribution` is rising → mix is dragging the blended rate down, even if each segment is individually stable
- If a high-RoR segment's contribution is shrinking → blended rate will fall even without deterioration in any segment
- The key question: "Is the blended rate moving because the book is changing composition, or because recovery effectiveness is changing within segments?"

---

### Vintage Curves → `response.vintage_curves`

Cumulative recovery % by write-off quarter (Q1 2025, Q2 2025, Q3 2025, Q4 2025, Q1 2026) tracked across maturity months M1–M15.

| Field | Meaning |
|---|---|
| `quarter` | Write-off cohort (e.g. "Q1 2025") |
| `month` | Maturity month within that cohort (M1 = 1 month after write-off) |
| `percentage_value` | Cumulative % of write-off POS recovered by this maturity point |

**Vintage curve interpretation:**
- Compare cohorts at the SAME maturity point (e.g. all cohorts at M3, M6, M9) — this is the true apples-to-apples comparison
- A newer cohort tracking below an older cohort at the same age = underperformance; above = outperformance
- Curve shape matters: a steep M1–M4 ramp followed by flattening = front-loaded recovery; a slow early ramp followed by sustained rise = legal/settlement-led
- For immature cohorts (Q3 2025, Q4 2025, Q1 2026 with only M1–M6 visible), project ultimate recovery by comparing early-month % to the same early months of a mature cohort
- "Trajectory gap": if Q4 2025 is at M3 = 3.9% and Q1 2025 at M3 = 6.8%, the new cohort is running 43% below the benchmark — quantify this gap explicitly

---

### MTD Pacing → `response.mtd_pacing`

Daily cumulative recovery for current month (CM), prior month (PM), and the last-3-month average (L3M).

| Field | Meaning |
|---|---|
| `latest_day_of_month` | Most recent day with CM data |
| `CM` | Current month at latest day — recovery_mio, recovery_pct_of_bom |
| `PM_same_day` | Prior month at the same day — for direct MTD comparison |
| `PM_month_end` | Prior month at its final day — the full-month settled figure |
| `PM1` | Two months ago at same day — secondary reference |

**MTD pacing rules:**
- Compare CM `recovery_pct_of_bom` vs `PM_same_day` `recovery_pct_of_bom` — running ahead or behind?
- State the pp gap and directional implication: "running Xpp behind PM at day Y, implying month-end recovery will be ~Z% if pace holds"
- Use `PM_month_end` to anchor the full-month target the current pace is tracking toward
- Never compare CM raw recovery amount to PM month-end amount — timing mismatch

---

### State Breakdown → `response.state_breakdown`

Latest month breakdown of the write-off book by state, ordered by balance (largest first).

| Field | Meaning |
|---|---|
| `state` | State name (e.g. MAHARASHTRA, UTTAR PRADESH, Others) |
| `balance_mio` | POS in this state (INR Mio) |
| `recovery_pct` | Recovery rate for this state this month (%) |
| `recovery_pct_prev` | Recovery rate prior month (%) |
| `delta_pp` | MoM change in recovery rate (pp) — positive = improving, negative = deteriorating |

**State hotspot rule:** Only flag a state if it is (a) top-3 by balance AND (b) showing a negative delta_pp (declining recovery rate). A low recovery rate on a small state is immaterial. The most actionable state risk is large balance + falling rate.

---

## Before You Write — Analyst Reconciliation Checklist

Run these questions before writing a single sentence. The answers shape each paragraph.

**1. Tile MTD vs last month**
Is `current_mtd_ror_pct` ahead or behind `last_mtd_ror_pct`?
- Ahead = month is running better than last month at same point in time
- Behind = month is running worse; check if this is pace (collections timing) or structural
- Always anchor to `last_month_ror_pct` as the fully settled benchmark the current month is tracking toward

**2. Book composition check**
Is total POS (write-off book) growing or shrinking (portfolio_trend)?
- Growing = more write-offs being fed in. Is recovery rate keeping up, or being diluted by fresh/lower-quality accounts?
- Shrinking = book running off. If recovery_pct is also falling on a shrinking book, that is double deterioration.

**3. Rate direction vs mix shift**
Compare recovery_pct trend (portfolio_trend) vs mix_impact contribution shifts.
- Rate falling + low-RoR segment contribution rising → mix-driven drag, not operational failure
- Rate falling + each segment's individual rate also falling → genuine collection effectiveness issue
- Rate improving but only because high-RoR segment contribution increased → temporary, will reverse if mix normalises

**4. Vintage curve trajectory**
For each cohort in vintage_curves, compare to the same maturity month of the best-performing cohort.
- If newest cohort is tracking materially below benchmark at same age → flag the projected shortfall
- Compute: (newest cohort M3%) / (best cohort M3%) − 1 = performance gap at current age
- If newest cohort is tracking ahead → flag it as a positive signal for future months

**5. WO MOB vintage aging**
Check vintage_mix: is V6 (old stale accounts) share growing?
- Rising V6 share = aged inventory building. These accounts have lowest recovery probability.
- Rising V1 share = fresh write-offs being added at pace. Recovery rate for V1 matters: is it in line with prior V1 cohorts?

**6. MTD pacing vs prior month**
Is CM tracking above or below PM at the same day-of-month?
- Running behind PM AND behind L3M → double miss signal.
- Running ahead → project upside vs prior month.

**7. State concentration**
Is the state with the worst delta_pp also large in absolute balance? Small balance + falling rate = immaterial. Large balance + falling rate = primary risk worth naming.

---

## Write the 4-Paragraph Brief

Blank line between paragraphs. Bold label at the start of each.

**Paragraph 1 — Verdict**
One sentence. No metrics. No specific segments or cohort names. Pure overall health: "Recovery is improving and tracking ahead of prior month", "showing structural mix-driven drag despite stable operations", "fresh vintage underperformance signals emerging collection risk", etc.

**Paragraph 2 — Key Observations**
3–4 sentences. Always in this order:

1. **Tile MTD + book size** — State whether this month's Rate of Recovery (RoR) is running ahead or behind the same point last month, and reference the settled prior month RoR as the benchmark. State current MTD POS vs prior MTD POS. Apply the MTD vs last-month distinction strictly: never present partial-month recovery as a full-month figure.

2. **Vintage curve benchmark** — State the sharpest vintage signal: which cohort is most materially above or below benchmark at the same maturity month? Quantify the trajectory gap (pp or %). If newest cohort is immature (M1–M4 only), project implied ultimate recovery vs the best-performing cohort's final level.

3. **Mix shift signal** — State whether the blended recovery rate is being driven by mix shift or by genuine effectiveness change, using mix_impact data. Name the specific segment (POS band or WO MOB vintage bucket) whose contribution is moving most, and what it implies for the blended rate next month.

4. **MTD pacing** — Current month recovery pace vs prior month at the same day-of-month. State the pp gap and whether the full-month implied recovery is above or below last month's settled rate.

**Paragraph 3 — Potential Risk** *(one sentence only — skip if nothing material)*
One sentence. Priority:
1. **State hotspot** — only if top-3 by balance AND delta_pp is negative. State the state name, recovery rate, prior month rate, and balance.
2. **Vintage/POS segment risk** — if no state hotspot is material, flag the specific POS band or WO MOB bucket with the worst recovery rate and growing contribution.
Skip entirely if nothing material.

**Paragraph 4 — Focus**
1–2 sentences. The single forward-looking trigger already under the most pressure that would, if it worsens, move the verdict.

Scan in this order:
1. Vintage curves — which cohort's early-month trajectory, if it holds, implies the largest shortfall at M12?
2. Mix impact — which segment's contribution is growing fastest, and what does it do to the blended rate if it reaches X%?
3. WO MOB aging — is V6 share growing, and at what pace?
4. MTD pacing gap — if current day-of-month pace holds, does it imply a miss vs prior month-end?
5. Regional Rate Loss — is the worst region's trend accelerating?

Name the metric, direction, and threshold. No action items.

---

## Tone

- Conversational, not academic. Professional enough to forward to a senior leader.
- Number-sparse — only figures that explain the verdict
- Expand abbreviations on first use: RoR = Rate of Recovery, POS = Principal Outstanding, WO = Write-Off, MOB = Month on Book, BOM = Beginning of Month, MTD = Month to Date
- Never "monitor closely" or "analyze further" without a specific reference point
- Always name specific segments in plain English ("the 0–50K POS band", "the Q3 2025 cohort", "the V6 vintage bucket", "East region")

---

## Anti-patterns

- ❌ Bullet lists
- ❌ Opening with a number instead of a verdict
- ❌ Reporting a metric direction without a "what this means" clause
- ❌ Comparing vintage cohorts at different maturity months — always same-age comparison
- ❌ Calling a shrinking V6 share a risk — it is positive (old inventory running off)
- ❌ Comparing current_mtd_recovery_mn directly to last_month_recovery_mn — timing mismatch
- ❌ Using MTD recovery amount without normalising to day-of-month
- ❌ More than one thing in Potential Risk
- ❌ Action items in Focus ("review X", "validate Y") — only watch signals with thresholds
- ❌ Flagging a state hotspot without checking that it is top-3 by balance
- ❌ Using internal field names in the brief (e.g. "wo_mob_bin", "percentage_contribution", "current_mtd_ror_pct") — always plain English
- ❌ Claiming mix shift is the cause without actually checking whether segment-level rates are also moving

---

## Example Output

*Product: RLAP (Retail Loan Against Property) — Apr 2026*

**Verdict**: Recovery rate is stable on the surface but a structural collapse in post-Q2 2025 vintage performance means the book is recovering far less from newer write-offs than historical cohorts did.

**Key observations**: This month's Rate of Recovery (RoR) is running at 0.78% through day 26, marginally ahead of the 0.74% at the same point last month, tracking toward last month's settled 1.13% if the end-of-month collection push holds — but the current MTD Principal Outstanding (POS) of ₹691 Mn is up 1.2% vs last month at this date, meaning a larger book is being worked with broadly the same daily pace. The vintage curve signal is the more concerning story: at M3, Q1 2025 had reached 41.3% cumulative recovery, while Q3 2025, Q4 2025, and Q1 2026 are all in the 1.9–3.8% range at the same age, a structural break that implies terminal recovery of 5–8% vs Q1 2025's 51%. The V6 vintage bucket (write-offs 18+ Months on Book) has grown to 25% of the book at a 0.79% RoR, while the blended rate improvement over six months is being driven by older high-recovery cohorts running off rather than genuine improvement in collection effectiveness within any segment. The current month is running at 0.54% of POS by day 26 vs 0.49% at the same point last month — 5 basis points ahead — suggesting the month will close near or slightly above last month's level if pace holds.

**Potential Risk**: Andhra Pradesh holds ₹102 Mio — the second-largest state exposure — and its RoR has fallen from 2.08% to 1.03% month-on-month, a 1.05pp drop that is the sharpest balance-weighted geographic drag on the blended rate this month.

**Focus**: Watch the Q1 2026 cohort at M6 (due next month): Q3 2025 reached 5.8% and Q4 2025 reached 7.3% at M6, both well below Q1 2025's 44.4% at the same age — if Q1 2026 comes in below 6% at M6, it confirms the structural break is not a one-quarter anomaly and the terminal recovery gap on 2025–2026 vintages will widen further.
""".strip()


# ── Label normalisation ────────────────────────────────────────────────────────
_BRIEF_LABELS_RE = re.compile(
    r"(?m)^(\*{0,2})(Verdict|Key Observations?|Potential Risk|Observation|Focus)(\*{0,2})(:)",
    re.IGNORECASE,
)

_LABEL_MAP = {
    "verdict":           "Verdict",
    "key observations":  "Key Observations",
    "key observation":   "Key Observations",
    "potential risk":    "Potential Risk",
    "observation":       "Potential Risk",
    "focus":             "Focus",
}


def _normalise_brief_labels(text: str) -> str:
    def _replace(m):
        label = _LABEL_MAP.get(m.group(2).lower(), m.group(2))
        return f"**{label}**:"
    return _BRIEF_LABELS_RE.sub(_replace, text)


# ── Output cleaning ────────────────────────────────────────────────────────────
_KNOWN_LABELS = re.compile(
    r"^\*\*(Verdict|Key Observations|Potential Risk|Focus)\*\*:",
    re.IGNORECASE,
)


def _clean_brief(text: str) -> str:
    """
    Remove three formatting artifacts the LLM sometimes produces:
    1. A leading bullet/title line before the first paragraph label
    2. Stray ** immediately after a paragraph label colon
    3. Leading ** on any non-label line

    NOTE: the collections job has no equivalent of this and suffers the same
    artifacts — worth porting this function there.
    """
    lines = text.strip().split("\n")

    while lines:
        first = lines[0].strip()
        if not first:
            lines.pop(0)
            continue
        if _KNOWN_LABELS.match(first):
            break
        is_bullet = first.startswith(("•", "-", "#"))
        is_title  = ("—" in first or "–" in first) and len(first) < 80 and not first[0].isalpha()
        is_stray  = first.startswith("**") and not _KNOWN_LABELS.match(first) and len(first) < 80
        if is_bullet or is_title or is_stray:
            lines.pop(0)
        else:
            break

    text = "\n".join(lines)

    text = re.sub(
        r"(\*\*(?:Verdict|Key Observations|Potential Risk|Focus)\*\*:)\s*\*{1,2}\s*",
        r"\1 ",
        text,
        flags=re.IGNORECASE,
    )

    def _fix_line(line: str) -> str:
        stripped = line.strip()
        if _KNOWN_LABELS.match(stripped):
            return line
        return re.sub(r"^\s*\*{1,2}\s+", "", line)

    lines = [_fix_line(ln) for ln in text.split("\n")]
    return "\n".join(lines).strip()


# ── Shared AOAI client (thread-safe; instrumented by OpenAIInstrumentor) ───────
# Replaces raw requests.post: gives SDK-level retries on 429/5xx, connection
# reuse across threads (no TLS handshake per product), and token usage capture.
_aoai_client = AzureOpenAI(
    azure_endpoint = os.environ["AZURE_OPENAI_ENDPOINT"].rstrip("/"),
    api_key        = os.environ["AZURE_OPENAI_API_KEY"],
    api_version    = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
    max_retries    = LLM_MAX_RETRIES,
    timeout        = LLM_TIMEOUT_S,
)


def generate_brief(group_key: str, product_name: str, overview: dict):
    synthetic_call_id = "call_prefetch_0"

    # Latest closed portfolio month from trend
    trend              = overview.get("portfolio_trend") or []
    analysis_month     = trend[-1]["year_month"] if trend else "unknown"
    analysis_month_ror = trend[-1].get("recovery_percentage") if trend else None

    # Identify which month the tile's last_month_* fields refer to
    tile           = overview.get("recovery_tile") or {}
    tile_last_ror  = tile.get("last_month_ror_pct")
    tile_ref_month = None
    if tile_last_ror is not None:
        for t in trend:
            if t.get("recovery_percentage") is not None and abs(t["recovery_percentage"] - tile_last_ror) < 1e-4:
                tile_ref_month = t["year_month"]
                break
    if tile_ref_month is None and len(trend) >= 2:
        tile_ref_month = trend[-2]["year_month"]

    tile_lags = (tile_ref_month != analysis_month)

    mtd        = overview.get("mtd_pacing") or {}
    pacing_day = mtd.get("tile_anchor_day") or mtd.get("latest_day_of_month")

    cm     = mtd.get("CM") or {}
    pm     = mtd.get("PM_same_day") or {}
    pm_end = mtd.get("PM_month_end") or {}
    pm1    = mtd.get("PM+1") or mtd.get("PM1") or {}

    def _pct(val, decimals=4):
        if val is None:
            return "n/a"
        return f"{round(val * 100, decimals)}%"

    def _m(val):
        return f"₹{val}m" if val is not None else "n/a"

    tile_lag_note = (
        f"  NOTE: tile last_month refers to {tile_ref_month} (RoR {_pct(tile_last_ror)}), "
        f"NOT {analysis_month}. The tile pipeline has not yet rolled to {analysis_month}. "
        f"Use portfolio_trend for {analysis_month} closed performance "
        f"(RoR {_pct(analysis_month_ror)}). Do NOT use tile last_month figures "
        f"as {analysis_month} benchmarks.\n"
    ) if tile_lags else (
        f"  Tile last_month matches portfolio_trend latest: {analysis_month} "
        f"(RoR {_pct(tile_last_ror)}).\n"
    )

    pipeline_note = mtd.get("pipeline_note", "")
    if pipeline_note:
        mtd_block = (
            f"MTD NOTE: {pipeline_note}\n"
            f"  Settled reference ({mtd.get('settled_reference_month', {}).get('year_month', '?')} "
            f"day {pacing_day}): RoR {_pct(mtd.get('settled_reference_month', {}).get('recovery_pct_of_bom'))}, "
            f"recovery {_m(mtd.get('settled_reference_month', {}).get('recovery_mio'))}\n"
            f"  Prior month full close ({pm_end.get('year_month', '?')}): "
            f"RoR {_pct(pm_end.get('recovery_pct_of_bom'))}\n"
        )
    else:
        mtd_block = (
            f"MTD pacing (all figures at day {pacing_day} — tile anchor day):\n"
            f"  Current month  ({cm.get('year_month', '?')} day {pacing_day}): "
            f"RoR {_pct(cm.get('recovery_pct_of_bom'))}, "
            f"recovery {_m(cm.get('recovery_mio'))}\n"
            f"  Prior month same day ({pm.get('year_month', '?')} day {pacing_day}): "
            f"RoR {_pct(pm.get('recovery_pct_of_bom'))}, "
            f"recovery {_m(pm.get('recovery_mio'))}\n"
            f"  Prior month full close ({pm_end.get('year_month', '?')}): "
            f"RoR {_pct(pm_end.get('recovery_pct_of_bom'))}\n"
            f"  PM+1 same day ({pm1.get('year_month', '?')} day {pacing_day}): "
            f"RoR {_pct(pm1.get('recovery_pct_of_bom'))}\n"
            f"  Max data available through day {mtd.get('latest_day_of_month', '?')} "
            f"(do not cite figures beyond day {pacing_day} — tile anchor).\n"
        )

    context_note = (
        f"Analysis context — read before writing:\n"
        f"Latest closed portfolio month: {analysis_month} "
        f"(RoR {_pct(analysis_month_ror)} from portfolio_trend — primary reference).\n"
        f"{tile_lag_note}"
        f"{mtd_block}"
        f"Never cite a recovery figure for any day not listed above.\n"
        f"Never use 'last month' without naming the month explicitly.\n"
        f"Do not output a title, header, or bullet line. Start directly with **Verdict**:\n"
    )

    user_msg = (
        f"Give me a recovery overview of {product_name} (group_key: {group_key}).\n\n"
        f"{context_note}"
    )

    # CRO_RECOVERY_SKILL_PROMPT is first and byte-identical across all calls —
    # this is the cacheable prefix. Everything variable comes after. Do not reorder.
    messages = [
        {"role": "system", "content": CRO_RECOVERY_SKILL_PROMPT},
        {"role": "user",   "content": user_msg},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id":   synthetic_call_id,
                "type": "function",
                "function": {
                    "name":      "getRecoveryOverview",
                    "arguments": json.dumps({"product_name": product_name, "group_key": group_key}),
                },
            }],
        },
        {
            "role":         "tool",
            "tool_call_id": synthetic_call_id,
            "content":      json.dumps(overview, default=str),
        },
    ]

    deployment = os.environ["AZURE_OPENAI_DEPLOYMENT"]

    p_tok = c_tok = t_tok = cached_tok = reason_tok = None
    llm_start = time.perf_counter()
    with span("llm.generate_brief", product=group_key, deployment=deployment,
              reasoning_effort=REASONING_EFFORT) as sp:
        resp = _aoai_client.chat.completions.create(
            model=deployment,
            messages=messages,
            extra_body={
                "max_completion_tokens": MAX_COMPLETION_TOKENS,
                "reasoning_effort":      REASONING_EFFORT,
                "prompt_cache_key":      PROMPT_CACHE_KEY,
            },
        )
        content = (resp.choices[0].message.content or "").strip()

        usage = getattr(resp, "usage", None)
        p_tok = getattr(usage, "prompt_tokens", None)     if usage else None
        c_tok = getattr(usage, "completion_tokens", None) if usage else None
        t_tok = getattr(usage, "total_tokens", None)      if usage else None

        # ---- cached prefix tokens (is prompt caching actually landing?) ----
        details    = getattr(usage, "prompt_tokens_details", None) if usage else None
        cached_tok = getattr(details, "cached_tokens", None) if details else None

        # ---- reasoning tokens (paid for, then discarded — not in the brief) ----
        cdetails   = getattr(usage, "completion_tokens_details", None) if usage else None
        reason_tok = getattr(cdetails, "reasoning_tokens", None) if cdetails else None

        if sp is not None:
            try:
                sp.set_attribute("gen_ai.usage.cached_tokens",    int(cached_tok or 0))
                sp.set_attribute("gen_ai.usage.reasoning_tokens", int(reason_tok or 0))
            except Exception:
                pass
        log.info(f"💾 cached={cached_tok}  🧠 reasoning={reason_tok}")

        _record_tokens(sp, p_tok, c_tok, t_tok)
        _add_tokens(p_tok, c_tok, t_tok, cached_tok, reason_tok)
    llm_ms = (time.perf_counter() - llm_start) * 1000.0

    if content:
        content = _normalise_brief_labels(content)
        content = _clean_brief(content)

    metrics = {
        "prompt_tokens":     p_tok,
        "completion_tokens": c_tok,
        "total_tokens":      t_tok,
        "cached_tokens":     cached_tok,
        "reasoning_tokens":  reason_tok,
        "llm_ms":            round(llm_ms, 1),
    }
    return content, metrics

# COMMAND ----------

# =============================================================================
# CELL 6 — PER-PRODUCT WORKER + BATCH RUNNER
# =============================================================================

import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed


def process_product(group_key: str, query_key: str) -> dict:
    display_name  = group_key
    product_start = time.perf_counter()

    def _err_record(msg, db_ms):
        return {
            "product_name":      display_name,
            "group_key":         group_key,
            "query_key":         query_key,
            "insight_text":      f"Error: {msg}",
            "status":            "error",
            "error":             str(msg),
            "prompt_tokens":     None,
            "completion_tokens": None,
            "total_tokens":      None,
            "cached_tokens":     None,
            "reasoning_tokens":  None,
            "db_ms":             db_ms,
            "llm_ms":            None,
            "total_ms":          round((time.perf_counter() - product_start) * 1000.0, 1),
        }

    with span("process_product", product=group_key):
        db_start = time.perf_counter()
        overview = get_local_product_overview(query_key, group_key)
        db_ms    = round((time.perf_counter() - db_start) * 1000.0, 1)

        if overview is None:
            return _err_record(f"could not fetch product overview for {query_key}", db_ms)

        try:
            brief, metrics = generate_brief(group_key, display_name, overview)
        except Exception as e:
            log.error(f"LLM call failed for {group_key}: {e}")
            return _err_record(e, db_ms)

        is_error = (not brief) or brief.startswith("Error:")
        return {
            "product_name":      display_name,
            "group_key":         group_key,
            "query_key":         query_key,
            "insight_text":      brief,
            "status":            "error" if is_error else "success",
            "error":             brief if is_error else None,
            "prompt_tokens":     metrics["prompt_tokens"],
            "completion_tokens": metrics["completion_tokens"],
            "total_tokens":      metrics["total_tokens"],
            "cached_tokens":     metrics["cached_tokens"],
            "reasoning_tokens":  metrics["reasoning_tokens"],
            "db_ms":             db_ms,
            "llm_ms":            metrics["llm_ms"],
            "total_ms":          round((time.perf_counter() - product_start) * 1000.0, 1),
        }


def run_batch_analysis(products=None, concurrency=CONCURRENCY) -> list:
    log.info("🔍 Fetching product list...")
    product_map = fetch_products_from_db()

    if products is not None:
        requested = {p.upper() for p in products}
        product_map = {
            gk: qk for gk, qk in product_map.items()
            if gk.upper() in requested or qk.upper() in requested
        }
        found   = {gk.upper() for gk in product_map} | {qk.upper() for qk in product_map.values()}
        missing = requested - found
        if missing:
            log.warning(f"Not found in DB: {missing}")

    product_list = list(product_map.keys())
    total        = len(product_list)

    log.info("=" * 60)
    log.info("BATCH RECOVERY ANALYSIS")
    log.info(f"RUN_ID   : {RUN_ID}")
    log.info(f"Products : {total}")
    log.info(f"Workers  : {concurrency}")
    log.info(f"Effort   : {REASONING_EFFORT}   max_completion_tokens={MAX_COMPLETION_TOKENS}")
    log.info("=" * 60)

    completed = 0
    records   = []

    with span("batch.run", products=total, workers=concurrency,
              reasoning_effort=REASONING_EFFORT):
        batch_start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            # _with_context makes each worker's spans nest under batch.run.
            futures = {
                executor.submit(_with_context(process_product, gk, product_map[gk])): gk
                for gk in product_list
            }
            for future in as_completed(futures):
                pn         = futures[future]
                completed += 1
                try:
                    record = future.result()
                    records.append(record)
                    brief  = record.get("insight_text", "") or ""
                    status = "✅" if record.get("status") == "success" else "❌"
                    log.info(f"[{completed}/{total}] {status} {pn} ({len(brief)} chars)")
                except Exception as e:
                    records.append({
                        "product_name": pn,
                        "group_key":    pn,
                        "query_key":    pn,
                        "insight_text": f"Error: {e}",
                        "status":       "error",
                        "error":        str(e),
                    })
                    log.error(f"[{completed}/{total}] ❌ {pn} — {e}")

        batch_ms = (time.perf_counter() - batch_start) * 1000.0

    success = sum(1 for r in records if r.get("status") == "success")
    log.info("=" * 60)
    log.info(f"BATCH COMPLETE  ✅ {success}/{total} products generated successfully")
    log.info(f"⏱  total generate wall-time: {batch_ms/1000:.1f}s  "
             f"(avg {batch_ms/max(total,1):.0f} ms/product)")
    log.info(f"🔢 TOKENS  in={TOKEN_TOTALS['prompt']}  out={TOKEN_TOTALS['completion']}  "
             f"total={TOKEN_TOTALS['total']}  over {TOKEN_TOTALS['calls']} calls")
    log.info(f"💾 CACHED  {TOKEN_TOTALS['cached']} of {TOKEN_TOTALS['prompt']} input tokens "
             f"({100.0 * TOKEN_TOTALS['cached'] / max(TOKEN_TOTALS['prompt'], 1):.1f}%)")
    log.info(f"🧠 REASONING  {TOKEN_TOTALS['reasoning']} of {TOKEN_TOTALS['completion']} output tokens "
             f"({100.0 * TOKEN_TOTALS['reasoning'] / max(TOKEN_TOTALS['completion'], 1):.1f}% discarded)")
    log.info("=" * 60)

    print_summary_table(records, batch_ms)
    return records


def print_summary_table(records: list, batch_ms: float) -> None:
    header = (f"{'PRODUCT':<38}{'IN':>8}{'CACHED':>8}{'OUT':>8}{'REASON':>8}"
              f"{'DB(s)':>8}{'LLM(s)':>8}{'TIME(s)':>9}")
    print(header)
    print("-" * len(header))

    sum_in = sum_cached = sum_out = sum_reason = 0
    for r in records:
        pname   = str(r.get("product_name", ""))[:37]
        p_in    = r.get("prompt_tokens") or 0
        p_cache = r.get("cached_tokens") or 0
        p_out   = r.get("completion_tokens") or 0
        p_reas  = r.get("reasoning_tokens") or 0
        d_sec   = (r.get("db_ms")    or 0) / 1000.0
        l_sec   = (r.get("llm_ms")   or 0) / 1000.0
        p_sec   = (r.get("total_ms") or 0) / 1000.0
        sum_in     += p_in
        sum_cached += p_cache
        sum_out    += p_out
        sum_reason += p_reas
        print(f"{pname:<38}{p_in:>8}{p_cache:>8}{p_out:>8}{p_reas:>8}"
              f"{d_sec:>8.1f}{l_sec:>8.1f}{p_sec:>9.1f}")

    print("-" * len(header))
    print(f"{'TOTAL (' + str(len(records)) + ' products)':<38}"
          f"{sum_in:>8}{sum_cached:>8}{sum_out:>8}{sum_reason:>8}"
          f"{'':>8}{'':>8}{batch_ms/1000:>9.1f}")


def records_to_dataframe(records: list) -> pd.DataFrame:
    cols = ["product_name", "group_key", "query_key", "status",
            "prompt_tokens", "cached_tokens", "completion_tokens",
            "reasoning_tokens", "total_tokens",
            "db_ms", "llm_ms", "total_ms", "insight_text", "error"]
    df = pd.DataFrame(records)
    existing  = [c for c in cols if c in df.columns]
    remaining = [c for c in df.columns if c not in existing]
    return df[existing + remaining]

# COMMAND ----------

# =============================================================================
# CELL 7 — PUSH TO POSTGRESQL
# =============================================================================

def normalize_product_key(gk: str) -> str:
    """B2B_B2B → B2B; asymmetric keys stay as-is."""
    parts = gk.rsplit("_", 1)
    if len(parts) == 2 and parts[0].upper() == parts[1].upper():
        return parts[0]
    return gk


def push_records_to_db(records: list, dataset: str = "recovery") -> dict:
    """Batched delete + insert into the insights table. Skips non-success rows."""
    dataset_key = dataset.strip().lower()
    if dataset_key == "recovery":
        table, content_col = "recovery_diagnostics.portfolio_ai_insights", "portfolio"
    elif dataset_key == "collection":
        table, content_col = "collections_diagnostics.portfolio_ai_insights", "hotspot"
    else:
        raise ValueError("dataset must be 'recovery' or 'collection'")

    rows = [
        (
            normalize_product_key(str(r.get("product_name", "")).strip()),
            str(r.get("insight_text", "")).strip(),
        )
        for r in records
        if (r.get("status") or "success").lower() == "success"
           and r.get("product_name") and r.get("insight_text")
    ]

    if not rows:
        log.warning("No successful records to push.")
        return {"inserted": 0, "deleted": 0, "processed": 0, "table": table}

    generated_at = datetime.now(timezone.utc)
    # Single set-based DELETE instead of one DELETE per row.
    delete_sql   = f"DELETE FROM {table} WHERE product_name = ANY(%s)"
    insert_sql   = (
        f"INSERT INTO {table} (product_name, {content_col}, generated_at_utc) "
        f"VALUES (%s, %s, %s)"
    )

    with span("db.push_records", rows=len(rows)):
        with db_conn() as conn:          # pooled, not a fresh connect
            with conn.cursor() as cur:
                cur.execute(delete_sql, ([p for p, _ in rows],))
                deleted = cur.rowcount
                execute_batch(
                    cur, insert_sql,
                    [(p, t, generated_at) for p, t in rows],
                    page_size=200,
                )
            conn.commit()

    result = {
        "inserted":         len(rows),
        "deleted":          deleted,
        "processed":        len(rows),
        "table":            table,
        "generated_at_utc": generated_at.isoformat(),
    }
    log.info(f"Push result: {result}")
    return result

# COMMAND ----------

# =============================================================================
# CELL 8 — RUN
# =============================================================================


with span("job.generate_phase", workers=CONCURRENCY, reasoning_effort=REASONING_EFFORT):
    records = run_batch_analysis(products=PRODUCTS, concurrency=CONCURRENCY)


df = records_to_dataframe(records)
display(df)



# COMMAND ----------

# =============================================================================
# CELL 9 — PUSH
# =============================================================================

with span("job.push_phase"):
    push_start = time.perf_counter()
    if not records:
        log.warning("no records to push — skipping")
        push_result = {"inserted": 0, "deleted": 0, "processed": 0, "skipped": "no records"}
    else:
        push_result = push_records_to_db(records, dataset="recovery")
    log.info(f"⏱  push wall-time: {(time.perf_counter()-push_start)*1000:.0f} ms")

# ---- Flush OTel spans -------------------------------------------------------
if _OTEL_READY:
    try:
        from opentelemetry import trace as _trace_flush
        provider = _trace_flush.get_tracer_provider()
        if hasattr(provider, "force_flush"):
            flushed = provider.force_flush(timeout_millis=10000)
            log.info(f"OTel force_flush completed: {flushed}")
    except Exception as e:
        log.warning(f"OTel force_flush failed: {e}")

# ---- Close the pool ---------------------------------------------------------
try:
    db_pool.closeall()
    log.info("DB pool closed ✅")
except Exception as e:
    log.warning(f"pool close failed: {e}")

log.info(f"RUN COMPLETE — RUN_ID={RUN_ID}")

# COMMAND ----------

# =============================================================================
# CELL 10 — ONE-TIME DDL  (run manually against the DB, then delete this cell)
# =============================================================================
# The recovery schemas currently have ZERO useful indexes (only an incidental
# pkey on recovery_daily_payments.daily_recovery_curves). Verified via EXPLAIN.
#
# THE ONE THAT MATTERS — 324,718 rows, Parallel Seq Scan, 48.6ms / 9,546
# buffers, 324,644 rows discarded to return 73. Scanned once per product:
#
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mtdrp_gk_filter
#     ON mtd_recovery.recovery_portfolio (group_key, filter, subsegment, "Metrics");
#
# The rest are hygiene — small tables today (1.7-2.4ms), but they seq-scan and
# will drift as they grow:
#
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_pn_filter
#     ON recovery_portfolio.portfolio_value (product_name, filter, subsegment);
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_miv_pn_filter
#     ON recovery_mix_impact.mix_impact_value (product_name, filter);
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vin_pn_filter
#     ON recovery_vintage.vintage (product_name, filter, subsegment);
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rt_gk
#     ON recovery_home.v1_recovery_tile (group_key);
#   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rdai_pn
#     ON recovery_diagnostics.portfolio_ai_insights (product_name);
#
# Verify after: EXPLAIN (ANALYZE, BUFFERS) on the mtd_pacing query should show
# an Index/Bitmap Scan, not "Parallel Seq Scan".

# COMMAND ----------

