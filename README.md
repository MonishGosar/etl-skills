# ETL Agent Tools

Portable ETL inspection and failure diagnosis for Pi, Claude Code, Codex, DeepSeek Harness, and other MCP clients.

Version `0.2.0-beta.1` adds a bundled read-only stdio MCP server. It inspects Databricks, reads local dbt artifacts, and reads Airflow DAG runs through the stable REST API. Pi also receives guarded Databricks execution tools; every SQL submission, pipeline action, job action, and repair requires interactive confirmation.

## Guided setup

Install the beta once, open the repository where you want to use it, and run:

```powershell
npm.cmd install --global etl-agent-tools@beta
etl-agent-tools-setup
```

Choose Codex, Claude Code, DeepSeek Harness, Pi, or all supported harnesses. The setup command installs the same shared skills in the correct directory, safely adds the available project configuration, creates `.etl-agent/project.md`, and prints any final harness command. It records environment-variable names but never asks for or writes a token.

The harness-specific sections below are manual alternatives and troubleshooting references.

## Support

| Harness | Skills | Read-only MCP tools | Guarded mutations |
| --- | --- | --- | --- |
| Pi | Packaged automatically | `etl_inspect` plus `dbx_inspect` alias | `dbx_query`, `dbx_pipeline`, `dbx_run`, `dbx_repair` |
| Claude Code | Claude plugin | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| Codex | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| DeepSeek Harness | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| Other MCP clients | Client-specific | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |

Databricks inspection, local dbt artifact diagnosis, and read-only Airflow diagnosis are implemented. Snowflake, dbt Cloud, and managed Airflow identity flows in [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) are not read by this release.

## Configure Databricks

Set values in the same terminal before starting the harness:

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_TOKEN = "your-short-lived-token"
# Needed only for SQL in Pi:
$env:DATABRICKS_WAREHOUSE_ID = "your-sandbox-warehouse-id"
```

The package does not load `.env` files. See [ETL workspace environment setup](ENVIRONMENT_SETUP.md) for where to obtain each value, optional catalog/schema defaults, dbt artifact paths, Airflow API settings, and credential handling.

## Configure dbt artifacts

Point the server at a directory that already contains `run_results.json` and `manifest.json`. The server does not run dbt.

```powershell
$env:DBT_ARTIFACTS_DIR = "C:\path\to\dbt\target"
# Optional:
$env:DBT_LOG_PATH = "C:\path\to\dbt\logs\dbt.log"
```

`DBT_PROJECT_DIR` is an alternative. The server then reads `<project>\target`. `etl_diagnose` can also take `artifacts_dir` for one call.

## Configure Airflow

Set the stable REST API version explicitly. Use `v1` for Airflow 2 and `v2` for Airflow 3. This release sends GET requests with bearer or basic auth. It does not trigger, clear, or retry tasks.

```powershell
$env:AIRFLOW_BASE_URL = "https://airflow-sandbox.example.com"
$env:AIRFLOW_API_VERSION = "v2"
$env:AIRFLOW_AUTH_MODE = "bearer"
$env:AIRFLOW_TOKEN = "your-short-lived-jwt"
$env:AIRFLOW_ENVIRONMENT = "sandbox"
```

HTTP is accepted only for `localhost` and `127.0.0.1`. Amazon MWAA and Google IAP auth are not implemented.

## Install for Pi

From this repository:

```powershell
npm.cmd install
npm.cmd run build
pi install .
pi
```

From npm:

```powershell
pi install npm:etl-agent-tools@0.2.0-beta.1
```

Run `/setup-etl-workspace` once in the target repository, then use `/diagnose-pipeline`, `/schema-drift`, or `/safe-repair`.

## Install for Claude Code

Test the checked-out plugin:

```powershell
npm.cmd install
npm.cmd run build
claude --plugin-dir .
```

Inside Claude Code, run `/mcp` and confirm that the `etl` server is connected. The setup workflow is namespaced as `/etl-agent-tools:setup-etl-workspace`.

After the GitHub release is published, install through the repository marketplace:

```text
/plugin marketplace add MonishGosar/etl-skills
/plugin install etl-agent-tools@etl-agent-tools
```

The plugin-root `.mcp.json` launches the bundled server and forwards only the documented Databricks variables.

## Install for Codex

Install the package and copy the shared skills into a repository:

```powershell
npm.cmd install --global etl-agent-tools@0.2.0-beta.1
etl-agent-tools-install-skills --target .agents/skills
```

Copy the `mcp_servers.etl` table from `config/codex.config.toml` into the trusted project's `.codex/config.toml`, then verify:

```powershell
codex mcp list
```

The template forwards selected variables from the environment instead of storing their values in configuration.

## Install for DeepSeek Harness

Install the package, install the skills, and merge `config/deepseek.cordis.yml` into a user or project Cordis patch:

```powershell
npm.cmd install --global etl-agent-tools@0.2.0-beta.1
etl-agent-tools-install-skills --target .agents/skills
```

The DeepSeek MCP client intentionally scrubs credential-shaped ambient variables. The supplied overlay explicitly forwards Databricks, dbt, and Airflow variables to the child server. Start DeepSeek Harness with the resulting patch and confirm that `mcp__etl__etl_capabilities`, `mcp__etl__etl_inspect`, `mcp__etl__etl_query_status`, and `mcp__etl__etl_diagnose` are discovered.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `etl_capabilities` | Report which providers are configured and which read-only operations exist, without contacting a remote workspace |
| `etl_inspect` | Read Databricks jobs, runs, schemas, notebooks, and pipelines; dbt artifact summaries; or Airflow DAG runs, task instances, and bounded task logs |
| `etl_query_status` | Read an existing Databricks SQL statement and bounded result without submitting or cancelling it |
| `etl_diagnose` | Build a root-cause brief for a dbt invocation or an Airflow DAG run: failed node or task, scrubbed error excerpt, upstream and downstream impact, cause category, and suggested next step |

Results include provider and workspace identity. Text output is capped at 24,000 characters, and oversized structured data is omitted with an explicit truncation marker. Provider error bodies are not returned because they can contain credentials or source data. Log excerpts are capped and scrubbed the same way.

## Safety model

The MCP server is read-only and rejects unknown command-line flags. It cannot submit SQL, start or stop an execution, cancel work, repair a run, invoke dbt, or trigger an Airflow task. dbt diagnosis reads only `run_results.json`, `manifest.json`, and an optional `dbt.log`. Airflow diagnosis sends GET requests only.

Pi mutations pass through a shared operation policy and Pi's interactive confirmation gate. Acceptance of a remote request is not completion: inspect the returned identifier and poll the remote state. A pipeline or job run uses deployed Databricks code and does not deploy a local patch.

Use a dedicated sandbox principal and separate sandbox resources. Catalog and schema defaults resolve names but do not enforce isolation.

## Development and release verification

```powershell
npm.cmd install
npm.cmd run verify
```

The verification command builds both bundled executables, type-checks source, runs mocked HTTP and MCP protocol tests, and inspects the npm tarball. Tests do not require Databricks credentials.

See [RELEASE_PLAN.md](RELEASE_PLAN.md) for remaining live compatibility checks and release gates. Provider expansion is tracked separately in [FUTURE_WORK.md](FUTURE_WORK.md). User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).
