---
name: setup-etl-workspace
description: Configure ETL Agent Tools for a repository by recording provider identity, sandbox boundaries, validation thresholds, and release conventions without storing credentials.
disable-model-invocation: true
---

# Set up an ETL workspace

Run once per repository before diagnosis or repair. This is a user-invoked configuration interview; never infer production identifiers or write credentials into files.

1. Read `CONTEXT.md`, `ENVIRONMENT_SETUP.md`, the repository README, deployment configuration, and `.gitignore`. Preserve existing conventions and unrelated edits.
2. Ask for the provider and project name. For the currently implemented Databricks adapter, ask for workspace host; development/sandbox pipeline ID and name; production pipeline ID and name or `none`; sandbox catalog/schema, storage boundary, and execution principal; source repository and deployment command or CI workflow; checkpoint directory; and validation thresholds for schema, row count, null rates, duplicate keys, and business invariants.
3. Validate without contacting the workspace: the Databricks host is HTTPS with no path or credentials; pipeline IDs are UUIDs; checkpoint paths are approved. Never ask the user to paste a token.
4. Write `.etl-agent/project.md` with the answers, assumptions, and a `Configured on` timestamp. Use placeholders such as `${DATABRICKS_HOST}` for values sourced from the environment. Never copy tokens, connection strings, or query results.
5. Show the complete file and deployment command without running deployment or production operations. Setup is complete only when every requested field is present or explicitly `unknown`, no secret-shaped value is present, and the user has seen the contents.

After setup, load `diagnose-pipeline` for investigation and `safe-repair` before any patch, sandbox execution, or production repair.
