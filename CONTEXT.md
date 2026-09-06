# ETL Agent Tools project vocabulary

`/setup-etl-workspace` creates repository-specific configuration in `.etl-agent/project.md`. Keep credentials in environment variables or a secret manager.

- **Pipeline**: a Databricks Lakeflow Declarative Pipeline identified by a UUID.
- **Update**: one execution of a pipeline, identified by an update ID. An accepted update is not a successful update.
- **Sandbox**: an isolated pipeline, catalog/schema, storage location, and principal used for validation. A catalog default alone is not isolation.
- **Checkpoint**: recorded source revision, table versions, and validation thresholds. It is evidence, not an automatic backup.
- **Production repair**: an approved rerun of deployed code after sandbox validation and release verification.

Separate observed API state, local source state, and hypotheses. A missing API response or truncated output is unknown evidence, not a pass. Inspection can run without confirmation. SQL submission, pipeline control, and repair are available only through the Pi adapter and require interactive confirmation. The read-only MCP transport never exposes those mutations. The package never deploys local source, restores Delta tables, or retries interrupted submissions automatically.
