# Changelog

## Unreleased

### Added

- Databricks OAuth machine-to-machine authentication for a service principal client ID and secret, with in-memory token fetch and refresh. Personal access tokens remain supported. Set `DATABRICKS_AUTH` when both credential families are present.
- Read-only `etl_uc_context` for Unity Catalog table and column lineage, explicit grants and effective permissions, and optional job cost from `system.billing` when a warehouse is configured. A section the principal cannot access returns `available: false`.
- Guidance for using this toolkit as the diagnosis and safe-repair layer alongside Databricks managed MCP servers and Databricks agent skills.
- Read-only dbt failure diagnosis from local `run_results.json`, `manifest.json`, and optional `dbt.log`.
- Read-only Airflow DAG run, task instance, and task log diagnosis through the stable REST API (`v1` or `v2`, bearer or basic auth).
- `etl_diagnose`, which returns a root-cause brief with the failed node or task, a scrubbed error excerpt, upstream and downstream impact, a cause category, and a suggested next step.
- dbt and Airflow actions on `etl_inspect`.
- `etl_capabilities` reports Databricks, dbt, and Airflow configuration and read-only operations, including Databricks OAuth and `uc_context`.

### Changed

- The diagnose-pipeline skill covers Databricks lineage and grants, dbt, and Airflow.
- Guided setup, harness configuration, and the environment guide accept either a personal access token or OAuth client credentials, and forward dbt and Airflow environment variable names. The installer still does not write secret values.

## 0.2.0-beta.1 - 2026-09-07

### Added

- Read-only stdio MCP server for Claude Code, Codex, DeepSeek Harness, and other MCP clients.
- Portable `etl_inspect`, `etl_query_status`, and `etl_capabilities` tools.
- Shared Databricks adapter and approval interface used by Pi and MCP.
- Harness configuration examples and a cross-harness skill installer.
- Interactive `etl-agent-tools-setup` command for one-step Codex, Claude Code, DeepSeek Harness, or Pi project setup.
- Workspace environment guide covering current Databricks configuration and planned provider contracts.

### Changed

- Renamed the package from `pi-databricks` to `etl-agent-tools`.
- Kept Pi mutation tools behind interactive approval and limited the portable MCP transport to read-only operations.
- Added structured, bounded tool results with provider and workspace identity.

## 0.1.0 - 2026-09-04

- Initial Pi extension with Databricks inspection, SQL, job, pipeline, and repair tools.
- Databricks diagnosis, schema drift, setup, and safe repair skills.
