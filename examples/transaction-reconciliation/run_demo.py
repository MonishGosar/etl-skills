"""Exercise a known incremental repair using a disposable, local dbt/DuckDB project.

This is an integration demonstration with a supplied patch, not an autonomous
agent repair benchmark. It never uses the user's dbt profile or a remote warehouse.
"""

import argparse
import difflib
import importlib.metadata
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dbt", default="dbt")
    parser.add_argument("--keep-workspace", action="store_true")
    args = parser.parse_args()
    executable = shutil.which(args.dbt)
    if not executable:
        parser.error("Install the documented dbt-duckdb demo dependencies first.")
    workspace = Path(tempfile.mkdtemp(prefix="etl-reconciliation-"))
    try:
        project = workspace / "project"
        shutil.copytree(HERE / "project", project)
        profiles = workspace / "profiles"
        profiles.mkdir()
        database = workspace / "sandbox.duckdb"
        (profiles / "profiles.yml").write_text(
            "etl_reconciliation:\n  target: sandbox\n  outputs:\n    sandbox:\n"
            "      type: duckdb\n      threads: 1\n      path: "
            + json.dumps(str(database)) + "\n"
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith("DBT_")}
        env.update(DBT_PROFILES_DIR=str(profiles), DBT_SEND_ANONYMOUS_USAGE_STATS="false",
                   DBT_USE_COLORS="false", DO_NOT_TRACK="1")

        def run(command):
            result = subprocess.run(
                [executable, command, "--project-dir", str(project),
                 "--profiles-dir", str(profiles)],
                cwd=workspace, env=env, text=True, capture_output=True, timeout=180,
            )
            if command == "seed" and result.returncode:
                raise RuntimeError("dbt seed failed: " + result.stdout[-2000:])
            return result

        def snapshot(name):
            dest = workspace / name
            dest.mkdir()
            for filename in ["manifest.json", "run_results.json"]:
                shutil.copyfile(project / "target" / filename, dest / filename)
            return dest

        def metrics():
            with duckdb.connect(str(database), read_only=True) as db:
                row = db.execute(
                    "select count(*), count(distinct transaction_id), sum(amount_cents) "
                    "from main.ledger"
                ).fetchone()
            return dict(rows=row[0], distinct_transaction_ids=row[1], total_cents=row[2])

        expected = dict(rows=3, distinct_transaction_ids=3, total_cents=3000)
        run("seed")
        initial = run("build")
        if initial.returncode:
            raise RuntimeError("Initial dbt build failed: " + initial.stdout[-2000:])
        baseline = snapshot("baseline")
        assert metrics() == expected
        model = project / "models" / "ledger.sql"
        fixed = model.read_text()
        faulty = (HERE / "faulty-ledger.sql").read_text()
        model.write_text(faulty)
        broken = run("build")
        failed = snapshot("failed")
        results = json.loads((failed / "run_results.json").read_text())["results"]
        model_succeeded = any(r["unique_id"] == "model.etl_reconciliation.ledger"
                              and r["status"] == "success" for r in results)
        failed_tests = [r["unique_id"] for r in results if r["status"] == "fail"]
        if broken.returncode == 0 or not model_succeeded or not failed_tests:
            raise RuntimeError("Fault injection did not produce the intended successful-model/failed-data-test incident.")
        broken_metrics = metrics()
        assert broken_metrics == dict(rows=6, distinct_transaction_ids=3, total_cents=6000)
        print("Injected duplicate transactions: model succeeded; reconciliation tests failed.", flush=True)
        comparison_path = workspace / "comparison.json"
        subprocess.run(
            ["node", str(ROOT / "scripts" / "compare-dbt.mjs"), "--current", str(failed),
             "--baseline", str(baseline), "--output", str(comparison_path)],
            check=True, cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        comparison = json.loads(comparison_path.read_text())
        assert any(change["id"] == "model.etl_reconciliation.ledger"
                   and {"code", "configuration"}.issubset(change["kinds"])
                   and change["relation"] == "upstream" for change in comparison["changes"])
        model.write_text(fixed)
        repaired = run("build")
        if repaired.returncode:
            raise RuntimeError("Repaired dbt build failed: " + repaired.stdout[-2000:])
        repaired_metrics = metrics()
        assert repaired_metrics == expected
        replayed = run("build")
        if replayed.returncode:
            raise RuntimeError("Idempotence replay failed: " + replayed.stdout[-2000:])
        replayed_metrics = metrics()
        assert replayed_metrics == expected
        report = {
            "schema_version": 1, "benchmark": "dbt-duckdb-reconciliation-demo-v1",
            "versions": {name: importlib.metadata.version(name)
                         for name in ["dbt-core", "dbt-duckdb", "duckdb"]},
            "baseline": expected, "faulty": broken_metrics, "repaired": repaired_metrics,
            "replayed": replayed_metrics, "model_succeeded_during_incident": model_succeeded,
            "failed_data_tests": failed_tests, "comparison": comparison,
            "patch": "".join(difflib.unified_diff(faulty.splitlines(True), fixed.splitlines(True),
                                                  fromfile="faulty/ledger.sql", tofile="repaired/ledger.sql")),
            "checks": {"upstream_change_identified": True, "dbt_tests_pass_after_patch": True,
                       "transaction_ids_unique": True, "totals_reconciled": True,
                       "replay_idempotent": True},
            "limitations": "Supplied fixture patch in a disposable local DuckDB database. "
            "No autonomous patch generation, customer incident, Airflow/Databricks execution, "
            "remote repair, or production rollback is evaluated.",
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"checks": report["checks"], "faulty": broken_metrics,
                          "repaired": repaired_metrics, "replayed": replayed_metrics}, indent=2))
        if args.keep_workspace:
            print("Retained local demo workspace:", workspace)
    finally:
        if not args.keep_workspace:
            shutil.rmtree(workspace)


if __name__ == "__main__":
    main()
