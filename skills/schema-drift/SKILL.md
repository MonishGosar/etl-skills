---
name: schema-drift
description: Investigate Databricks missing columns, incompatible types, nullability changes, and suspected schema drift versus malformed data.
---

1. Establish the failing task, source revision and exact exception using `../diagnose-pipeline/SKILL.md` if not already known.
2. Collect expected schema from the transformation and actual input/target schemas via `etl_inspect` action `table` (`dbx_inspect` is the older Pi alias). Record capture time; current metadata does not prove the schema at failure time. Where available, use approved Pi SQL to inspect Delta history and historical versions.
3. Compare column names, nested paths, types, precision/scale and nullability. Produce a difference table with evidence and downstream impact. A missing field or rename requires an explicit mapping decision.
4. Distinguish schema incompatibility from malformed values using bounded aggregate diagnostics (invalid cast count, null count, row count). Prefer aggregates to raw records. Report unavailable evidence rather than inventing counts.
5. Propose the smallest transformation change with the required semantics. Numeric widening alone does not establish safety: check precision loss, rounding, overflow, null creation and downstream contracts. DOUBLE to DECIMAL needs a scale/rounding decision and data validation.
6. Before applying the proposal, use `../safe-repair/SKILL.md`. Completion requires a documented schema difference, supported diagnosis, proposed semantics and concrete validation criteria.
