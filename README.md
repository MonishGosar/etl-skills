# ETL Agent Tools

Portable ETL inspection, diagnosis, and guarded repair workflows for Pi, Claude Code, Codex, DeepSeek Harness, and other MCP clients.

This package is the diagnosis and safe-repair layer on top of Databricks, and it also reads local dbt artifacts and Airflow DAG runs. Use Databricks managed MCP servers and Databricks agent skills for Genie, ad hoc SQL, Unity Catalog functions, and platform development. Use etl-agent-tools for failed-run evidence, Unity Catalog lineage and grants, optional job cost, dbt and Airflow diagnosis, and interactive Pi repair.

Version `0.2.0-beta.1` adds a bundled read-only stdio MCP server. It inspects Databricks, reads local dbt artifacts, and reads Airflow DAG runs through the stable REST API. Pi also receives guarded Databricks execution tools; every arbitrary SQL submission, pipeline action, job action, and repair requires interactive confirmation. Databricks authentication is a personal access token or an OAuth machine-to-machine service principal.

## Guided setup

Install the beta once, open the repository where you want to use it, and run:

```powershell
npm.cmd install --global etl-agent-tools@beta
etl-agent-tools-setup
```

Choose Codex, Claude Code, DeepSeek Harness, Pi, or all supported harnesses. The setup command installs the same shared skills in the correct directory, safely adds the available project configuration, creates `.etl-agent/project.md`, and prints any final harness command. It records environment-variable names for a personal access token or an OAuth service principal, and it never asks for or writes a secret.

The harness-specific sections below are manual alternatives and troubleshooting references.

## Support

| Harness | Skills | Read-only MCP tools | Guarded mutations |
| --- | --- | --- | --- |
| Pi | Packaged automatically | `etl_inspect`, `etl_uc_context`, `etl_diagnose`, plus `dbx_inspect` alias | `dbx_query`, `dbx_pipeline`, `dbx_run`, `dbx_repair` |
| Claude Code | Claude plugin | `etl_capabilities`, `etl_inspect`, `etl_uc_context`, `etl_query_status`, `etl_diagnose` | Unavailable in this beta |
| Codex | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_uc_context`, `etl_query_status`, `etl_diagnose` | Unavailable in this beta |
| DeepSeek Harness | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_uc_context`, `etl_query_status`, `etl_diagnose` | Unavailable in this beta |
| Other MCP clients | Client-specific | `etl_capabilities`, `etl_inspect`, `etl_uc_context`, `etl_query_status`, `etl_diagnose` | Unavailable in this beta |

Databricks inspection, local dbt artifact diagnosis, and read-only Airflow diagnosis are implemented. Snowflake, dbt Cloud, and managed Airflow identity flows in [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) are not read by this release.

## Alongside Databricks managed MCP servers

Databricks hosts managed MCP servers for governed data access, including Genie, Databricks SQL, Unity Catalog functions, and AI Search. Databricks agent skills, installed with `databricks aitools`, carry the platform workflows that earlier AI Dev Kit installs provided. Where those skill sets overlap, follow the current Databricks install path.

Connect both to the same coding agent:

- Point Genie questions, ad hoc SQL, semantic search, and Unity Catalog function calls at the managed MCP server.
- Point failed job, task, and pipeline diagnosis at this server: `etl_inspect` for run evidence and `etl_uc_context` for upstream and downstream lineage, grants, and optional `system.billing` job cost.
- Keep repair, pipeline control, and arbitrary SQL on interactive Pi, where each request asks for confirmation.

Use a dedicated least-privilege principal for this server. OAuth machine-to-machine (service principal client ID and secret) is the preferred unattended credential. A short-lived personal access token still works. An interactive user session on a managed MCP server can use a different credential. This package does not register or replace the managed servers. Enable those in the Databricks account or workspace and follow [Databricks-provided MCPs](https://docs.databricks.com/aws/en/agents/mcp-tools/) and [Agent skills](https://docs.databricks.com/aws/en/agent-skills/).

## Configure Databricks

Set values in the same terminal before starting the harness:

Personal access token:

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_TOKEN = "your-short-lived-token"
# Needed for arbitrary SQL in Pi, and for optional job cost:
$env:DATABRICKS_WAREHOUSE_ID = "your-sandbox-warehouse-id"
```

OAuth machine-to-machine service principal:

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_CLIENT_ID = "your-service-principal-client-id"
$env:DATABRICKS_CLIENT_SECRET = "your-oauth-secret"
# Optional. Defaults to all-apis. Prefer the scopes bound to the OAuth secret.
$env:DATABRICKS_OAUTH_SCOPE = "all-apis"
$env:DATABRICKS_WAREHOUSE_ID = "your-sandbox-warehouse-id"
```

Set `DATABRICKS_AUTH` to `pat` or `oauth-m2m` when both credential families are present, and unset the family you are not using. The server exchanges the client ID and secret at `{workspace}/oidc/v1/token`, caches the access token in memory, and refreshes it before the one-hour expiry. The package does not load `.env` files. See [ETL workspace environment setup](ENVIRONMENT_SETUP.md) for where to obtain each value, optional catalog/schema defaults, dbt artifact paths, Airflow API settings, and credential handling.

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

The plugin-root `.mcp.json` launches the bundled server and forwards the documented Databricks, dbt, and Airflow variable names.

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

The DeepSeek MCP client intentionally scrubs credential-shaped ambient variables. The supplied overlay explicitly forwards Databricks variables, including the OAuth client secret, plus dbt and Airflow variables, to the child server. Start DeepSeek Harness with the resulting patch and confirm that `mcp__etl__etl_capabilities`, `mcp__etl__etl_inspect`, `mcp__etl__etl_uc_context`, `mcp__etl__etl_query_status`, and `mcp__etl__etl_diagnose` are discovered.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `etl_capabilities` | Report which providers are configured and which read-only operations exist, without contacting a remote workspace |
| `etl_inspect` | Read Databricks jobs, runs, schemas, notebooks, and pipelines; dbt artifact summaries; or Airflow DAG runs, task instances, and bounded task logs |
| `etl_uc_context` | Read lineage and grants for a failing table, and optional job cost from `system.billing` when `job_id` is set |
| `etl_query_status` | Read an existing Databricks SQL statement and bounded result without submitting or cancelling it |
| `etl_diagnose` | Build a root-cause brief for a dbt invocation or an Airflow DAG run: failed node or task, scrubbed error excerpt, upstream and downstream impact, cause category, and suggested next step |

Results include provider and workspace identity. Text output is capped at 24,000 characters, and oversized structured data is omitted with an explicit truncation marker. Provider error bodies are not returned because they can contain credentials or source data. Log excerpts are capped and scrubbed the same way.

## Safety model

The MCP server is read-only and rejects unknown command-line flags. It cannot submit arbitrary SQL, start or stop an execution, cancel work, repair a run, invoke dbt, or trigger an Airflow task. dbt diagnosis reads only `run_results.json`, `manifest.json`, and an optional `dbt.log`. Airflow diagnosis sends GET requests only. `etl_uc_context` may submit only its built-in `SELECT` statements: a `system.access` lineage fallback when the lineage API is unavailable, and a `system.billing` job-cost statement when `job_id` is set. Both require `DATABRICKS_WAREHOUSE_ID` and return `available: false` when the principal is not permitted.

Pi mutations pass through a shared operation policy and Pi's interactive confirmation gate. Acceptance of a remote request is not completion: inspect the returned identifier and poll the remote state. A pipeline or job run uses deployed Databricks code and does not deploy a local patch.

Use a dedicated sandbox principal and separate sandbox resources. Catalog and schema defaults resolve names but do not enforce isolation.

## Development and release verification

```powershell
npm.cmd install
npm.cmd run verify
```

The verification command builds both bundled executables, type-checks source, runs mocked HTTP and MCP protocol tests, and inspects the npm tarball. Tests do not require Databricks credentials.

See [RELEASE_PLAN.md](RELEASE_PLAN.md) for remaining live compatibility checks and release gates. Provider expansion is tracked separately in [FUTURE_WORK.md](FUTURE_WORK.md). User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).
