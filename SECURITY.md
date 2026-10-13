# Security policy

## Reporting

Report suspected vulnerabilities privately through the repository's GitHub security advisory form. Do not include real workspace tokens, SQL results, notebook source, or production identifiers in a public issue.

## Credential handling

The package reads credentials from the launching process environment and does not load `.env` files. Use a dedicated least-privilege sandbox principal and short-lived credentials. The MCP server exposes read-only tools; Pi mutations require an interactive confirmation for every request.

dbt diagnosis reads only `run_results.json`, `manifest.json`, and an optional log file. A symlink that resolves outside the artifacts directory is refused. Airflow diagnosis sends GET requests only. Provider error bodies are discarded. Error excerpts and task logs are length-capped and scrubbed for credential-shaped text before they are returned.

Rotate a credential immediately if it appears in a repository, terminal transcript, issue, test fixture, or tool result.
