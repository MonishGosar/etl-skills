# Changelog

## 0.2.0-beta.1 - 2026-09-07

### Added

- Read-only stdio MCP server for Claude Code, Codex, DeepSeek Harness, and other MCP clients.
- Portable `etl_inspect`, `etl_query_status`, and `etl_capabilities` tools.
- Shared Databricks adapter and approval interface used by Pi and MCP.
- Harness configuration examples and a cross-harness skill installer.
- Interactive `etl-agent-tools-setup` command for one-step Codex, Claude Code, DeepSeek Harness, or Pi project setup.
- Workspace environment guide covering current Databricks configuration and planned provider contracts.

### Changed

- Renamed the package from `pi-databricks` to `etl-agent-tools`.
- Kept Pi mutation tools behind interactive approval and limited the portable MCP transport to read-only operations.
- Added structured, bounded tool results with provider and workspace identity.

## 0.1.0 - 2026-09-04

- Initial Pi extension with Databricks inspection, SQL, job, pipeline, and repair tools.
- Databricks diagnosis, schema drift, setup, and safe repair skills.
