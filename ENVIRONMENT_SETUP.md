# ETL workspace environment setup

This guide explains which values a user needs, where to obtain them, and when to set them. It does not mean every provider is implemented today.

## Support status

| Provider | Status in this repository | What works now |
| --- | --- | --- |
| Databricks | Implemented | Read-only MCP inspection for supported harnesses; guarded SQL, job, pipeline, and repair operations in Pi |
| Airflow | Planned | Environment contract proposed below; no adapter is shipped |
| Snowflake | Planned | Environment contract proposed below; no adapter is shipped |
| dbt Cloud/Core | Future | No adapter is shipped |
| AWS Glue | Future | No adapter is shipped |
| BigQuery/Dataform | Future | No adapter is shipped |
| Azure Data Factory/Fabric | Future | No adapter is shipped |

Claude Code, Codex, and DeepSeek Harness use the bundled read-only MCP server. Mutating Databricks operations remain exclusive to interactive Pi sessions in this beta.

## Fastest setup

After installing the package globally, run `etl-agent-tools-setup` in the repository where the harness will work. Choose one harness or all supported harnesses. The command installs skills and configuration, then prints this variable checklist. It does not request, display, or save credential values.

## When to configure a workspace

Collect workspace values after the ETL workspace and a dedicated least-privilege principal exist, but before launching the harness. Set variables in the same terminal that starts Pi or the local MCP server. A child process inherits a snapshot of its parent's environment, so restart the harness after adding, rotating, or removing a value.

Use a separate principal and variables for each environment. Start with a development or sandbox workspace. A catalog, schema, database, role, or naming default helps resolve names; it does not prevent a fully qualified production write.

The repository ignores `.env` files, and the current package does not load them automatically. `.env.example` contains names only. Keep actual secrets in a secret manager, OS credential store, CI secret store, or temporary shell session.

To check whether a variable exists without printing its secret in PowerShell:

```powershell
if ($env:DATABRICKS_TOKEN) { "DATABRICKS_TOKEN is set" } else { "DATABRICKS_TOKEN is missing" }
```

Clear a temporary secret when the session is finished:

```powershell
Remove-Item Env:DATABRICKS_TOKEN
```

## Databricks (implemented)

### Values

| Variable | Required when | Where to get it | Secret |
| --- | --- | --- | --- |
| `DATABRICKS_HOST` | Every Databricks operation | Open the target workspace and copy its HTTPS origin, for example `https://adb-...azuredatabricks.net` or `https://dbc-....cloud.databricks.com`. Remove every path, query, and fragment. | No |
| `DATABRICKS_TOKEN` | Every Databricks operation | In the same workspace, create a personal access token from user settings if your administrator permits PATs. Prefer a short lifetime and a dedicated principal. | Yes |
| `DATABRICKS_WAREHOUSE_ID` | SQL submission | Open **SQL Warehouses**, select the sandbox warehouse, and copy its warehouse ID from its connection details or URL. This is the ID, not the HTTP path. | No |
| `DATABRICKS_CATALOG` | Optional SQL name default | Copy the sandbox catalog name from Catalog Explorer. | No |
| `DATABRICKS_SCHEMA` | Optional SQL name default | Copy the sandbox schema name from Catalog Explorer. | No |

The current adapter supports PAT bearer authentication. OAuth and service-principal environment variables belong to a future adapter release.

### Set for the current PowerShell session

```powershell
$env:DATABRICKS_HOST = "https://your-workspace.cloud.databricks.com"
$env:DATABRICKS_TOKEN = "your-short-lived-token"
$env:DATABRICKS_WAREHOUSE_ID = "your-sandbox-warehouse-id"
$env:DATABRICKS_CATALOG = "sandbox_catalog"
$env:DATABRICKS_SCHEMA = "sandbox_schema"

pi
```

`DATABRICKS_WAREHOUSE_ID` is unnecessary when only inspecting jobs or pipelines. Catalog and schema are optional even for SQL, but fully qualified object names are safer evidence.

References: [Databricks personal access tokens](https://docs.databricks.com/aws/en/dev-tools/auth/pat), [Databricks SQL warehouse connection details](https://docs.databricks.com/aws/en/integrations/compute-details).

## Snowflake (planned contract)

The first Snowflake adapter should prefer key-pair authentication. Use OAuth where the organization already manages it. Password authentication should be a development fallback rather than the documented production default.

| Variable | Required when | Where to get it | Secret |
| --- | --- | --- | --- |
| `SNOWFLAKE_ACCOUNT` | Every operation | In Snowsight, open account details and copy the account identifier requested by the Snowflake driver. Do not substitute a full browser URL. | No |
| `SNOWFLAKE_USER` | Key-pair or password login | Obtain the dedicated automation user's login name from a Snowflake administrator. | No |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | Key-pair login | Generate the private key locally; give only the public key to the administrator for the Snowflake user. Store the private key outside the repository. | Sensitive file path |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | Encrypted private key | Choose it when generating the encrypted private key and store it in a secret manager. | Yes |
| `SNOWFLAKE_OAUTH_TOKEN` | OAuth login | Obtain it through the organization's identity-provider or Snowflake OAuth flow. Tokens should be short lived. | Yes |
| `SNOWFLAKE_PASSWORD` | Password fallback | Obtain or reset it for the dedicated user. Do not use a personal password. | Yes |
| `SNOWFLAKE_ROLE` | Every scoped operation | Ask the administrator for a least-privilege sandbox role. | No |
| `SNOWFLAKE_WAREHOUSE` | Query execution | Select a sandbox virtual warehouse in Snowsight. | No |
| `SNOWFLAKE_DATABASE` | Object inspection or SQL | Select the sandbox database. | No |
| `SNOWFLAKE_SCHEMA` | Object inspection or SQL | Select the sandbox schema. | No |

Exactly one authentication method should be selected in a workspace profile. The future adapter should reject ambiguous combinations instead of guessing.

```powershell
$env:SNOWFLAKE_ACCOUNT = "orgname-account_name"
$env:SNOWFLAKE_USER = "etl_agent_sandbox"
$env:SNOWFLAKE_PRIVATE_KEY_PATH = "C:\secrets\snowflake-agent.p8"
$env:SNOWFLAKE_PRIVATE_KEY_PASSPHRASE = "your-secret"
$env:SNOWFLAKE_ROLE = "ETL_AGENT_SANDBOX"
$env:SNOWFLAKE_WAREHOUSE = "ETL_SANDBOX_WH"
$env:SNOWFLAKE_DATABASE = "ETL_SANDBOX"
$env:SNOWFLAKE_SCHEMA = "VALIDATION"
```

References: [Snowflake account identifiers](https://docs.snowflake.com/en/user-guide/admin-account-identifier), [Snowflake key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth), [Snowflake connection parameters](https://docs.snowflake.com/en/developer-guide/python-connector/python-connector-api#connect).

## Apache Airflow (planned contract)

Airflow authentication is deployment-specific. First identify the Airflow version, base URL, and configured auth manager with the platform owner. Airflow 2 commonly exposes stable API v1. Airflow 3 exposes public API v2 and obtains JWTs through an auth-manager endpoint. Managed Airflow services can require cloud identity instead of a reusable Airflow token.

| Variable | Required when | Where to get it | Secret |
| --- | --- | --- | --- |
| `AIRFLOW_BASE_URL` | Every operation | Copy the deployment's web/API origin from the platform owner. Store only the origin; the adapter adds `/api/v1` or `/api/v2`. | No |
| `AIRFLOW_API_VERSION` | Setup | Determine from the deployed Airflow major version and enabled public endpoint. Use `v1` or `v2`; do not auto-upgrade production behavior. | No |
| `AIRFLOW_AUTH_MODE` | Setup | Ask which auth manager or managed-service flow protects the API. Proposed values: `bearer`, `basic`, `aws-mwaa`, or `google-iap`. | No |
| `AIRFLOW_TOKEN` | Bearer/JWT mode | Obtain it from the configured auth manager. For Airflow 3, this is generally returned by `/auth/token` and expires. | Yes |
| `AIRFLOW_USERNAME` | Basic or token exchange | Obtain a dedicated least-privilege API user from the Airflow administrator. | No |
| `AIRFLOW_PASSWORD` | Basic or token exchange | Set for the dedicated API user and keep it in a secret manager. | Yes |
| `AIRFLOW_ENVIRONMENT` | Evidence labeling | Choose a stable label such as `sandbox` or `staging`; this is local metadata, not an Airflow credential. | No |

The future adapter should support one auth mode at a time. For Amazon MWAA, use the normal AWS credential chain and the environment name rather than inventing a long-lived `AIRFLOW_TOKEN`. For Cloud Composer, use Google Application Default Credentials and the environment's authenticated endpoint.

```powershell
$env:AIRFLOW_BASE_URL = "https://airflow-sandbox.example.com"
$env:AIRFLOW_API_VERSION = "v2"
$env:AIRFLOW_AUTH_MODE = "bearer"
$env:AIRFLOW_TOKEN = "your-short-lived-jwt"
$env:AIRFLOW_ENVIRONMENT = "sandbox"
```

References: [Airflow 3 public API authentication](https://airflow.apache.org/docs/apache-airflow/stable/security/api.html), [Airflow stable REST API](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html).

## Later provider credential families

These names are planning guidance and are not read by the package yet.

| Provider | Likely non-secret selectors | Preferred credential source |
| --- | --- | --- |
| dbt Cloud | `DBT_CLOUD_HOST`, `DBT_CLOUD_ACCOUNT_ID`, job/environment IDs | `DBT_CLOUD_TOKEN` from a least-privilege service token |
| dbt Core | Project and profiles directory, target name | Existing `profiles.yml` with secret values supplied by its own environment-variable references |
| AWS Glue | `AWS_REGION`, Glue job/catalog identifiers | AWS SDK default credential chain, workload role, or SSO; avoid static keys when possible |
| BigQuery/Dataform | `GOOGLE_CLOUD_PROJECT`, location, repository/workflow IDs | Application Default Credentials or workload identity |
| Azure Data Factory/Fabric | Tenant, subscription, resource group, workspace/factory IDs | Azure Default Credential, managed identity, or service principal secret/certificate |

Before implementing one of these adapters, confirm the official SDK's credential chain and naming. Reuse that chain where possible instead of copying cloud credentials into new `ETL_*` variables.

## Multiple workspaces

Do not put `DEV_`, `STAGING_`, and `PROD_` credentials into one agent process. Launch a separate process with one selected workspace so evidence and permissions cannot silently cross environments.

The planned profile file should contain selectors and environment-variable references only:

```yaml
version: 1
profiles:
  databricks-sandbox:
    provider: databricks
    environment: sandbox
    env:
      host: DATABRICKS_HOST
      credential: DATABRICKS_TOKEN
      warehouse: DATABRICKS_WAREHOUSE_ID
```

The profile says which variable to read; it never stores the value. Production should use a separate principal and separate process, and mutating tools should stay unavailable unless the selected harness supplies the tested approval gate described in `RELEASE_PLAN.md`.

## Harness environment propagation

These configurations apply to version `0.2.0-beta.1`.

Claude Code project plugins can map existing variables in the plugin-root `.mcp.json`:

```json
{
  "mcpServers": {
    "etl": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js", "--read-only"],
      "env": {
        "DATABRICKS_HOST": "${DATABRICKS_HOST}",
        "DATABRICKS_TOKEN": "${DATABRICKS_TOKEN}",
        "DATABRICKS_WAREHOUSE_ID": "${DATABRICKS_WAREHOUSE_ID:-}"
      }
    }
  }
}
```

Codex can forward selected ambient variables from project `.codex/config.toml`:

```toml
[mcp_servers.etl]
command = "etl-agent-tools-mcp"
args = ["--read-only"]
env_vars = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID"]
```

DeepSeek Harness explicitly forwards credential-shaped variables because its MCP client scrubs them from the ambient environment by default:

```yaml
- insert:
    - id: etl-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: etl
        transport: stdio
        command: etl-agent-tools-mcp
        args: ['--read-only']
        env:
          DATABRICKS_HOST: !!js process.env.DATABRICKS_HOST
          DATABRICKS_TOKEN: !!js process.env.DATABRICKS_TOKEN
          DATABRICKS_WAREHOUSE_ID: !!js process.env.DATABRICKS_WAREHOUSE_ID
```

Commit variable names and launch configuration only. Set the values outside the repository before starting the harness.
