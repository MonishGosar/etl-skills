# ETL Agent Tools roadmap

[Back to the README](../README.md)

These are planned improvements and evaluation targets. Current functionality is described in the [README](../README.md#what-you-can-do-today).

## Development priorities

Existing products already investigate data/code changes and lineage, expose MCP tools, and advertise proposed/verified fixes; see [Monte Carlo's troubleshooting documentation](https://docs.getmontecarlo.com/docs/troubleshooting-agent). The opportunity to test is a focused workflow that fits a small team's existing coding agent and resolves a specific class of incidents with less effort. Competitive advantage remains a hypothesis until comparable evaluations and customer pilots support it.

The following are the next steps beyond the implemented dbt artifact comparison and local reconciliation demo:

| Priority | Build next | Evidence required |
| --- | --- | --- |
| 1 | Extend dbt comparison to live source schemas, Git revisions and execution history across Airflow/Databricks. Automatically identify a compatible successful baseline. | Identify the first causal change with source evidence on multi-failure incidents, including misleading downstream errors. |
| 2 | Extend the supplied-patch demonstration to agent-proposed patches and general sandbox orchestration. Keep remote mutations behind their operation-specific confirmation gates. | Passing transformation tests plus reconciled row counts, unique transaction IDs and business totals; record failed repairs and unsafe actions. |
| 3 | Investigate successful jobs with incorrect outputs: duplicate transactions, stale inputs, missing partitions and faulty incremental logic. | Detect the injected data error and restore the expected data, even when job status is green. |
| 4 | Save reviewed incident evidence, accepted fixes and validation outcomes for later investigations. | Improve resolution on different incidents and projects without repeating an obsolete fix or exposing secrets. |

Start with **transaction reconciliation across dbt, Airflow and Databricks**: duplicate or missing transactions must reconcile after a proposed fix. Complete this workflow across the supported systems before expanding the provider list in [FUTURE_WORK.md](../FUTURE_WORK.md).

## How we would demonstrate an advantage

Create an initial evaluation of at least 100 independently reviewed incidents across three or more projects. Keep entire projects out of development, hide accepted causes/fixes, and include sanitized historical incidents alongside injected failures.

Compare the same model, repository access and time/token budget under logs-only, standard repository/provider tools, and ETL Agent Tools conditions. Score causal evidence and **correctly repaired, reconciled incidents** separately from category accuracy. Report unresolved cases/timeouts, median time to a validated fix, engineer edits, model cost per validated fix, and unsafe actions.

A proposed first-pilot goal is 25% lower median time to a validated fix than the strongest baseline, without reducing verified resolution success or weakening approval gates. This is a target, not a measured result. Claims against a commercial product require running comparable cases against that product; the current synthetic score does not establish market superiority.

The Pi SDK result-type incompatibilities are resolved by JSON-normalized structured results and pinned development SDKs. Complete the remaining live compatibility checks in [RELEASE_PLAN.md](../RELEASE_PLAN.md) before a commercial pilot.
