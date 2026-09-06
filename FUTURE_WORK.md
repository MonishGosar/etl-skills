# Future work

This roadmap starts after the portable `0.2.0-beta.1` release candidate. Add capabilities through the shared `EtlWorkspaceAdapter`; keep skill content provider-neutral and keep authentication, pagination, API versions, and request translation inside each provider adapter.

## Provider order

### 1. Apache Airflow

Start with DAG discovery, DAG-run inspection, task-instance status and logs, deployment revision evidence, and retry history. Detect Airflow 2 API v1 versus Airflow 3 API v2 during setup and store the selected version explicitly. Authentication must follow the deployment's auth manager or managed-cloud identity flow.

Keep the first adapter read-only. Add trigger, retry, clear, pause, and backfill only after task selection, logical-date semantics, side effects, and approval behavior have integration tests.

### 2. Snowflake

Start with query history, task history, schema metadata, warehouse state, and bounded validation SQL. Prefer key-pair or OAuth authentication. Keep role, warehouse, database, and schema explicit in every workspace profile because defaults do not enforce isolation.

Add SQL submission, cancellation, task resume or suspend, and reruns only after query tagging, statement timeouts, result bounds, transactions, idempotency, and approval behavior are tested.

### 3. Later adapters

Prioritize dbt Cloud/Core, AWS Glue, BigQuery/Dataform, Azure Data Factory/Fabric, and Spark/Kubernetes according to user demand. Add a shared capability only when at least two provider adapters need it; provider-specific evidence can remain in a typed `details` field.

## Cross-provider features

1. Add named workspace profiles for `dev`, `staging`, or `prod`. Profiles contain environment-variable names and non-secret selectors, never credential values.
2. Add OAuth and workload identity for Databricks, Snowflake, AWS, Google Cloud, and Azure. Prefer short-lived credentials.
3. Define normalized validation results for schema, row count, null rate, duplicate keys, freshness, and business invariants.
4. Add bounded evidence export with secret scanning.
5. Add OpenTelemetry spans for operation name, provider, status, duration, and provider request ID. Exclude SQL text, rows, tokens, notebook source, and other payload data.
6. Make skills capability-aware so a harness loads only workflows supported by the selected adapter.
7. Add Streamable HTTP only when a shared remote service is required. Design tenant isolation, OAuth, audit logging, rate limits, and its threat model first.

## Adapter readiness checklist

An adapter is ready for beta only when:

- Read operations, pagination, rate limits, cancellation, timeouts, and expired evidence are tested.
- Secrets and provider error bodies are redacted.
- Provider and sandbox or production identity are visible in each result.
- Results have text and structured-output bounds.
- Mutations are absent until the harness has a tested per-operation approval gate, an idempotency strategy, and remote-state reconciliation tests.
- Mocked offline tests and a live least-privilege sandbox smoke test both pass.
- `ENVIRONMENT_SETUP.md` states where each value comes from, when it is required, and whether it is secret.

## Stable release path

Promote the beta only after Claude Code, Codex, DeepSeek Harness, and Pi host checks pass against the packed artifact on Windows, macOS, and Linux. Then add one provider at a time behind the same interface instead of branching the harness packaging.
