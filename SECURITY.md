# Security policy

## Reporting

Report suspected vulnerabilities privately through the repository's GitHub security advisory form. Do not include real workspace tokens, SQL results, notebook source, or production identifiers in a public issue.

## Credential handling

The package reads credentials from the launching process environment and does not load `.env` files. Use a dedicated least-privilege sandbox principal and short-lived credentials. Personal access tokens and OAuth machine-to-machine client secrets are accepted from the environment. OAuth access tokens are fetched from the workspace `/oidc/v1/token` endpoint, cached in process memory, and refreshed before expiry. They are not written to project files. Tool errors and response bodies are scrubbed of token and client-secret values. The MCP server exposes read-only tools; Pi mutations require an interactive confirmation for every request. `etl_uc_context` can submit only fixed `SELECT` statements against Unity Catalog system tables.

dbt diagnosis reads only `run_results.json`, `manifest.json`, and an optional log file. A symlink that resolves outside the artifacts directory is refused. Airflow diagnosis sends GET requests only. Provider error bodies are discarded. Error excerpts and task logs are length-capped and scrubbed for credential-shaped text before they are returned.

Rotate a credential immediately if it appears in a repository, terminal transcript, issue, test fixture, or tool result.
