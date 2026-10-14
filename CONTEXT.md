# ETL Agent Tools project vocabulary

`/setup-etl-workspace` creates repository-specific configuration in `.etl-agent/project.md`. Keep credentials in environment variables or a secret manager.

- **Pipeline**: a Databricks Lakeflow Declarative Pipeline identified by a UUID.
- **Update**: one execution of a pipeline, identified by an update ID. An accepted update is not a successful update.
- **Sandbox**: an isolated pipeline, catalog/schema, storage location, and principal used for validation. A catalog default alone is not isolation.
- **Checkpoint**: recorded source revision, table versions, and validation thresholds. It is evidence, not an automatic backup.
- **Production repair**: an approved rerun of deployed code after sandbox validation and release verification.
- **dbt invocation**: one dbt command recorded by `run_results.json` and `manifest.json`. A failed node is a model, test, seed, or snapshot. Skipped downstream nodes are impact.
- **DAG run**: one Airflow DAG execution. Task instances in `upstream_failed` or `skipped` are impact of an earlier failed task.
- **Root-cause brief**: a read-only summary with the failed node or task, a scrubbed error excerpt, upstream and downstream impact, a cause category, and a suggested next step. The category is a hypothesis unless the excerpt states the cause.

- **Unity Catalog context**: read-only lineage, grants, and optional `system.billing` evidence for one table. A section with `available: false` is missing evidence, not a passing check.

Separate observed API state, local source state, and hypotheses. A missing API response or truncated output is unknown evidence, not a pass. Inspection, lineage, and grants can run without confirmation. Arbitrary SQL submission, pipeline control, and repair are available only through the Pi adapter and require interactive confirmation. The read-only MCP transport never exposes those mutations. `etl_uc_context` may submit only its own fixed system-table statements, and only for lineage fallback or an explicit job cost lookup. The package never deploys local source, restores Delta tables, or retries interrupted submissions automatically.
