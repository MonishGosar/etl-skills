# Security policy

## Reporting

Report suspected vulnerabilities privately through the repository's GitHub security advisory form. Do not include real workspace tokens, SQL results, notebook source, or production identifiers in a public issue.

## Credential handling

The package reads credentials from the launching process environment and does not load `.env` files. Use a dedicated least-privilege sandbox principal and short-lived credentials. The MCP server exposes read-only tools; Pi mutations require an interactive confirmation for every request.

Rotate a credential immediately if it appears in a repository, terminal transcript, issue, test fixture, or tool result.
