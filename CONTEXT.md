# pi-data project vocabulary

`/setup-pi-data` creates repository-specific configuration in `.pi-data/project.md`. Keep credentials in environment variables or a secret manager.

- **Pipeline**: a Databricks Lakeflow Declarative Pipeline identified by a UUID.
- **Update**: one execution of a pipeline, identified by an update ID. An accepted update is not a successful update.
- **Sandbox**: an isolated pipeline, catalog/schema, storage location, and principal used for validation. A catalog default alone is not isolation.
- **Checkpoint**: recorded source revision, table versions, and validation thresholds. It is evidence, not an automatic backup.
- **Production repair**: an approved rerun of deployed code after sandbox validation and release verification.

Separate observed API state, local source state, and hypotheses. A missing API response or truncated output is unknown evidence, not a pass. Inspection can run without confirmation; SQL, pipeline start/stop, and repair require interactive confirmation. The extension never deploys local source, restores Delta tables, or retries interrupted submissions automatically.
