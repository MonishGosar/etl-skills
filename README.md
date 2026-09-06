# ETL Agent Tools

Portable Databricks inspection and ETL diagnosis workflows for Pi, Claude Code, Codex, DeepSeek Harness, and other MCP clients.

Version `0.2.0-beta.1` adds a bundled read-only stdio MCP server. Pi also receives guarded Databricks execution tools; every SQL submission, pipeline action, job action, and repair requires interactive confirmation.

## Support

| Harness | Skills | Read-only MCP tools | Guarded mutations |
| --- | --- | --- | --- |
| Pi | Packaged automatically | `etl_inspect` plus `dbx_inspect` alias | `dbx_query`, `dbx_pipeline`, `dbx_run`, `dbx_repair` |
| Claude Code | Claude plugin | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| Codex | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| DeepSeek Harness | Install into `.agents/skills` | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |
| Other MCP clients | Client-specific | `etl_capabilities`, `etl_inspect`, `etl_query_status` | Unavailable in this beta |

Databricks is the only implemented provider. Snowflake, Airflow, and other environment-variable contracts in [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) are planned and are not read by this release.

## Configure Databricks

Set values in the same terminal before starting the harness:

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_TOKEN = "your-short-lived-token"
# Needed only for SQL in Pi:
$env:DATABRICKS_WAREHOUSE_ID = "your-sandbox-warehouse-id"
```

The package does not load `.env` files. See [ETL workspace environment setup](ENVIRONMENT_SETUP.md) for where to obtain each value, optional catalog/schema defaults, credential handling, and future provider contracts.

## Install for Pi

From this repository:

```powershell
npm.cmd install
npm.cmd run build
pi install .
pi
```

After publication:

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

The DeepSeek MCP client intentionally scrubs credential-shaped ambient variables. The supplied overlay explicitly forwards the five supported Databricks variables to the child server. Start DeepSeek Harness with the resulting patch and confirm that `mcp__etl__etl_capabilities`, `mcp__etl__etl_inspect`, and `mcp__etl__etl_query_status` are discovered.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `etl_capabilities` | Report configuration presence, provider, mode, and available operations without contacting Databricks |
| `etl_inspect` | Read jobs, runs, output, schemas, notebooks, pipelines, and pipeline updates |
| `etl_query_status` | Read an existing SQL statement and bounded result without submitting or cancelling it |

Results include provider and workspace identity. Text output is capped at 24,000 characters, and oversized structured data is omitted with an explicit truncation marker. Provider error bodies are not returned because they can contain credentials or source data.

## Safety model

The MCP server is read-only and rejects unknown command-line flags. It cannot submit SQL, start or stop an execution, cancel work, or repair a run.

Pi mutations pass through a shared operation policy and Pi's interactive confirmation gate. Acceptance of a remote request is not completion: inspect the returned identifier and poll the remote state. A pipeline or job run uses deployed Databricks code and does not deploy a local patch.

Use a dedicated sandbox principal and separate sandbox resources. Catalog and schema defaults resolve names but do not enforce isolation.

## Development and release verification

```powershell
npm.cmd install
npm.cmd run verify
```

The verification command builds both bundled executables, type-checks source, runs mocked HTTP and MCP protocol tests, and inspects the npm tarball. Tests do not require Databricks credentials.

See [RELEASE_PLAN.md](RELEASE_PLAN.md) for remaining live compatibility checks and release gates. Provider expansion is tracked separately in [FUTURE_WORK.md](FUTURE_WORK.md). User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).
