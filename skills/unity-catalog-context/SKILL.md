---
name: unity-catalog-context
description: Read Unity Catalog lineage, grants, and optional job cost while diagnosing a failing Databricks table. Missing permission is incomplete evidence.
---

Use this during Databricks diagnosis after the failing table's fully qualified name is known. Databricks managed MCP servers and Databricks agent skills (the current home of earlier AI Dev Kit workflows) answer Genie questions, ad hoc SQL, Unity Catalog functions, and platform development. This skill assembles failure context around one table.

1. Call `etl_uc_context` with `table` set to `catalog.schema.table`. Add `column` when the exception names a column. Add `job_id` only when `DATABRICKS_WAREHOUSE_ID` is configured and job cost would change the diagnosis. Omitting `job_id` skips the `system.billing` statement.
2. Lineage prefers the workspace lineage API and returns upstream and downstream tables. When that API is unavailable and a SQL warehouse is configured, the tool falls back to a fixed `system.access` statement covering the last 30 days. Treat `available: false` as missing evidence. Record the reason (`not permitted`, `not found`, warehouse unset, or query still running). A missing grant does not prove the object is inaccessible to every principal.
3. Read grants for the failing table and the lineage tables that fit in the response. `assignments` are explicit grants. `effective` includes inherited privileges and names the parent when Databricks provides one. `grants_limited: true` means further lineage tables were not checked.
4. If `job_cost.statement_id` is present and the statement did not finish, read it with `etl_query_status`. Do not submit another billing statement. `list_cost` is the published list price and can differ from the invoice. Usage quantity is the Databricks unit from `system.billing.usage`.
5. Use upstream tables as suspected inputs and downstream tables as impact. Continue with `diagnose-pipeline`. Load `safe-repair` before any patch, sandbox run, or production repair.

The portable MCP transport stays read-only. `etl_uc_context` never accepts caller SQL. Arbitrary SQL still goes through Pi `dbx_query`, which asks for confirmation on every submission.
