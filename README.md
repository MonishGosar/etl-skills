# ETL Skills

Databricks pipeline tools and reusable ETL workflows for Pi, Claude Code, Codex, and other agent harnesses.

The package helps an agent inspect pipeline failures, investigate schema drift, run approved pipeline updates, and prepare safe repairs. It does not deploy local code or automatically change production.

## Install for Pi

From this repository:

```powershell
npm.cmd install
pi install .
```

Or install directly from Git after publishing:

```powershell
pi install git:github.com/MonishGosar/etl-skills
```

## Configure Databricks

Set these variables in the same PowerShell window where you run Pi:

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_TOKEN = "your-databricks-token"
# Required only for SQL queries:
$env:DATABRICKS_WAREHOUSE_ID = "your-sql-warehouse-id"
```

The token is read from the environment and is never written to project files. Use a short-lived, least-privilege token.

## Start using it

```powershell
pi
```

Ask:

```text
Why did the latest pipeline update fail?
```

Then run the setup workflow once per repository:

```text
/setup-pi-data
```

It records pipeline IDs, sandbox boundaries, deployment instructions, and validation thresholds in `.pi-data/project.md`. It does not ask you to paste a token.

Useful workflows:

- `/diagnose-pipeline` — investigate a failed pipeline or update.
- `/schema-drift` — compare expected and actual schemas.
- `/safe-repair` — patch, validate in a sandbox, and prepare an approved repair.

## Tools

| Tool | Purpose |
| --- | --- |
| `dbx_inspect` | Read pipelines, updates, jobs, runs, schemas, notebooks, and task output |
| `dbx_pipeline` | Start or stop a deployed pipeline update |
| `dbx_query` | Execute, inspect, or cancel SQL with confirmation |
| `dbx_run` | Start or cancel a deployed job run |
| `dbx_repair` | Rerun selected job tasks after validation and confirmation |

All write or execution operations require interactive confirmation. A pipeline run uses deployed Databricks code; it does not test an un-deployed local edit. Use Databricks permissions and separate sandbox resources for isolation.

## Future scope

The extension is intentionally organized around a provider-neutral ETL interface so additional workspaces can be added without changing the skills:

- **Apache Airflow** — DAG runs, task logs, retries, backfills, and deployment revision checks.
- **Snowflake** — query history, task status, warehouse usage, schemas, and safe SQL validation.
- **dbt Cloud and dbt Core** — job runs, model/test failures, manifests, exposures, and artifact inspection.
- **AWS Glue** — job runs, state transitions, CloudWatch output, schema metadata, and retries.
- **Google Cloud Dataform and BigQuery** — workflow invocations, compilation results, schemas, and bounded validation queries.
- **Microsoft Fabric and Azure Data Factory** — pipeline runs, activity failures, datasets, and integration runtime status.
- **Apache Spark and Kubernetes operators** — application status, driver/executor logs, event logs, and artifact versions.

Each provider should implement the same small capability groups: inspect execution, inspect schema and metadata, run a bounded validation, start or stop an execution, and record a checkpoint. Provider adapters should remain responsible for API details, pagination, authentication, and environment boundaries. The skills should continue to describe diagnosis, schema drift, validation, and repair in platform-neutral terms.

Planned platform work includes OAuth and service-principal authentication, an MCP server shared by all harnesses, provider capability discovery, workspace/project configuration, and a validation result format that can be compared across providers. New providers will be added only after their read paths, confirmation gates, pagination, redaction, and sandbox behavior have offline tests.

## Development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd pack --dry-run
```

Tests use mocked HTTP and do not require Databricks credentials.
