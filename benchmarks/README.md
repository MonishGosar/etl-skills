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

Validation: 47 repository tests, packed-install verification and the benchmark
TypeScript check pass. Full `npm run verify` remains blocked by seven existing
Pi extension TS2322 errors with the current optional Pi SDK. The same errors
were reproduced on the baseline checkout; this change does not fix SDK compatibility.

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
