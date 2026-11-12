# Incident diagnosis benchmark

This suite scores **cause-category classification**, primary subject selection,
immediate lineage, confidence restraint, secret redaction, and read-only behavior.
It is not an end-to-end root-cause or repair benchmark.

The 54 authored scenarios exercise the production dbt adapter with temporary
`run_results.json`/`manifest.json` artifacts and the production Airflow adapter
against mocked GET responses. They cover compilation, database, test, permission,
timeout, dependency, configuration, resource, and unknown failures. Databricks,
live Airflow, warehouse execution, model/tool selection, and repair are not scored.

## Recorded iteration

Baseline: `d89c6962f770e299f18f157040b52e2ed76ed03d`. The same fixture file was
used before and after the classifier change. Reports include its SHA256.

| Split | Baseline category accuracy | Improved category accuracy |
| --- | --- | --- |
| Development | 23/36 (63.9%) | 36/36 (100%) |
| Reserved wording | 13/18 (72.2%) | 18/18 (100%) |
| Combined | 36/54 (66.7%) | 54/54 (100%) |

The improvement recognizes standard Jinja, warehouse, permission, connection and
resource diagnostics. Termination signals without resource evidence now return
unknown/low confidence. This fixes a diagnosis error rather than encouraging a
capacity change without evidence. Redaction, subject and immediate-lineage
checks passed in both versions.

The reserved cases were frozen before the first run and were not used to tune
after seeing their results. They were authored with the development cases and
share error families. They are **not an independent or blind holdout**, and 100%
here does not establish production incident accuracy. Confidence is a heuristic
label, not a calibrated probability.

## Run and compare

```sh
npm ci
npm run typecheck:benchmarks
npm run benchmark -- --split dev --output benchmark-output/dev.json --gate
npm run benchmark -- --split holdout --output benchmark-output/holdout.json --gate
npm run benchmark -- --split dev --baseline benchmarks/results/improved.dev.json --gate
```

`--gate` requires at least 90% category accuracy, perfect confidence restraint,
subject/lineage/redaction/read-only checks, and no metric regression against an
optional matching baseline. Dataset/split mismatches fail rather than comparing
unrelated runs. CI compares against the checked-in improved results and uploads
JSON reports. Latency includes fixture IO; mocked HTTP counts are not agent tool
calls. No model cost is estimated.

The initial iteration passed 47 repository tests and packed verification but
exposed seven pre-existing Pi SDK result-type errors. The next implementation
normalizes structured results to JSON values and pins development SDK versions;
full `npm run verify` now passes, including the Pi extension type check.

## Change comparison and real local reconciliation

`etl_compare_runs` validates coherent successful/current artifacts and reports
code/configuration fingerprints, declared column metadata and dependencies.
Diagnosis uses upstream-most failing candidates rather than simply the first
failed result. Cycles and independent failures remain explicitly uncertain.
Comparison reads no log file and executes no dbt, Git, SQL or repair command.

The [dbt/DuckDB demo report](results/reconciliation-demo.json) records actual
dbt builds: a model succeeds while faulty append logic duplicates transactions
(6 rows, 6,000 cents); data tests detect the error. The comparison identifies the
changed upstream model. A supplied fixture patch restores 3 unique transactions
and 3,000 cents, with data tests and a repeated build passing. This is a known
local integration scenario, not an autonomous repair score or a customer incident.
See the [root README](../README.md#local-transaction-reconciliation-demo) for the
isolated environment and pinned dependency command.

## Next iteration

1. Replay sanitized incidents from different projects, with human-reviewed cause,
   evidence and accepted fix. Keep whole projects out of development data.
2. Add multi-failure, missing-artifact, misleading-downstream and successful-but-wrong
   output cases. Score the actual causal subject and supporting evidence separately
   from this broad error category.
3. Evaluate a coding agent on [Spider2-DBT](https://github.com/xlang-ai/Spider2/tree/main/spider2-dbt)
   with the same model, budgets and tasks under logs-only, current-tool and improved-tool
   conditions. The current read-only MCP is not a coding/repair executor. Use a
   disposable dbt project and output assertions; record success, unsafe actions,
   time, model tokens and cost. No Spider result is claimed by this suite.
