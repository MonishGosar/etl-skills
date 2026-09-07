# Cross-harness release plan

## Goal

Release ETL Skills as one set of data-engineering workflows that can be used from Pi, Claude Code, Codex, and DeepSeek Harness. The workflows should stay provider-neutral. Databricks, Snowflake, Airflow, and later platforms should sit behind adapters at one small interface.

The release promise is complete when a user can install the package, configure one workspace without placing credentials in the repository, inspect a real non-production execution from each supported harness, and receive the same bounded and redacted result.

## Implementation status (2026-09-06)

Version `0.2.0-beta.1` is the first portable beta release:

- The provider logic is separated from Pi in a shared Databricks adapter.
- Pi uses an injected interactive approval gate for mutations and keeps the `dbx_*` compatibility tools.
- The bundled stdio MCP server exposes only `etl_capabilities`, `etl_inspect`, and `etl_query_status`.
- Claude Code, Codex, and DeepSeek Harness configurations launch the same read-only executable.
- One skill source can be copied to `.agents/skills` with `etl-agent-tools-install-skills`.
- Type checking, mocked transport tests, MCP protocol tests, Claude plugin validation, and clean packed-install verification pass locally on Windows.

Live Databricks sandbox checks, a DeepSeek-host process smoke test, and macOS/Linux compatibility checks remain gates for promotion from beta to a stable release. npm publication, the Git tag, and the GitHub release must still be verified independently for every release.

## Audited starting baseline (2026-09-06)

Version `0.1.0` is a Pi and Databricks preview:

- The five executable tools are registered through the Pi extension in `extensions/databricks.ts`.
- Databricks environment parsing, HTTPS validation, request timeouts, token redaction, and bounded output have offline tests.
- Claude Code can discover the four skill documents through the Claude plugin manifest, but the plugin does not include an MCP server, so those skills cannot call the Databricks tools outside Pi.
- Codex and DeepSeek Harness both discover project skills from `.agents/skills`, but this repository does not package its skills there.
- Codex, Claude Code, and DeepSeek Harness can all consume MCP tools. There is no MCP server in this package yet.
- The npm package name (`pi-databricks`), Claude plugin name (`pi-data`), and repository name (`etl-skills`) do not describe one product consistently.
- The Claude manifest declares an MIT license, but the repository has no checked-in `LICENSE` file.
- Type checking, four mocked HTTP tests, and `npm pack --dry-run --cache .npm-cache` pass in this workspace.

This was the state before the implementation in this release candidate. Skill discovery alone was not treated as executable cross-harness support.

## Target design

```text
skills/                         workflow instructions
             |                 shared by every harness
             v
harness packaging              Pi | Claude | Codex | DeepSeek Harness
             |
             v
ETL tool interface             inspect | validate | control | repair
             |
             v
provider adapters              Databricks | Airflow | Snowflake | ...
```

The external seam should expose a small provider-neutral interface:

```ts
interface EtlWorkspaceAdapter {
  capabilities(): Promise<WorkspaceCapabilities>;
  inspect(request: InspectRequest, signal?: AbortSignal): Promise<EtlResult>;
  validate(request: ValidationRequest, signal?: AbortSignal): Promise<EtlResult>;
  control(request: ControlRequest, approval: Approval, signal?: AbortSignal): Promise<EtlResult>;
  repair(request: RepairRequest, approval: Approval, signal?: AbortSignal): Promise<EtlResult>;
}
```

`WorkspaceCapabilities` makes unsupported actions visible instead of relying on the model to infer them. Provider adapters own authentication, pagination, API versions, request translation, idempotency, and provider error redaction. The interface owns normalized inputs, result status, truncation metadata, evidence references, and mutation classification.

Do not add a provider seam for every vendor detail. Add a capability only after two adapters need it. Provider-specific evidence can live in a typed `details` field without expanding every caller's interface.

## Release sequence

### 1. Make the package identity and support promise consistent

- Choose one package and plugin name, recommended: `etl-agent-tools`. Use it in `package.json`, the Claude manifest, tool titles, documentation, and release artifacts.
- Add the repository license file, changelog, security policy, contribution notes, and a support matrix.
- Declare Node and package-manager requirements and pin the MCP SDK version.
- Keep `0.1.x` labeled Pi/Databricks preview. Do not publish cross-harness claims in registry descriptions yet.

Exit criterion: `npm pack --dry-run` contains only the declared runtime, skills, manifests, license, and documentation; a fresh-directory install can run the current Pi smoke test.

### 2. Extract the Databricks adapter and shared policy

- Move transport-free Databricks operations out of `extensions/databricks.ts`.
- Introduce normalized result and error types, capability discovery, pagination helpers, redaction, output bounds, timeout handling, and idempotency rules.
- Replace direct `ctx.ui.confirm` calls with an injected `ApprovalGate`. Keep the Pi UI implementation behavior unchanged.
- Keep the existing `dbx_*` Pi tool names as compatibility aliases for the first migration release.

Exit criterion: existing tests pass through the extracted adapter, every operation is classified read-only or mutating in one policy table, and deleting either harness adapter does not affect provider tests.

### 3. Ship a local stdio MCP server

- Add an executable such as `etl-agent-tools-mcp` that exposes stable JSON Schema tools and writes protocol traffic only to stdout; diagnostics go to stderr.
- Start with read-only inspection and bounded validation. Credentials come from the child process environment.
- Return both text content and structured content, including `status`, `provider`, `workspace`, `truncated`, `nextCursor`, and evidence identifiers.
- Test discovery, calls, cancellation, malformed arguments, pagination, redaction, empty responses, timeouts, and child shutdown with the MCP Inspector and automated child-process tests.

MCP does not make per-call human approval portable by itself. The portable server therefore starts in read-only mode. Mutating tools must remain unavailable unless a harness-specific `ApprovalGate` has been proven in an integration test. A configuration flag alone is not evidence of per-operation approval.

Exit criterion: the packed executable can be installed in a clean directory and the Inspector can list and invoke a mocked read tool without TypeScript source or repository-local dependencies.

### 4. Package each harness

| Harness | Skills | Tool connection | Release verification |
| --- | --- | --- | --- |
| Pi | Package `pi.skills` | Existing extension, later backed by the shared adapter | Fresh install; inspect; declined mutation; approved sandbox mutation |
| Claude Code | Claude plugin skill entries | Plugin-root `.mcp.json` launches the packed stdio server | Plugin install; MCP connected; skill invocation; real sandbox inspection |
| Codex | Copy or link bundles under `.agents/skills` | Project `.codex/config.toml` or `codex mcp add` | Skill appears; MCP list succeeds; real sandbox inspection |
| DeepSeek Harness | Copy or link bundles under `.agents/skills` | Cordis overlay using `@deepseek-ai/dsh-mcp-client` | Tools discovered as `mcp__etl__*`; skill invocation; real sandbox inspection |

Generate the harness packaging from one skills source instead of maintaining four copies. Installation scripts may copy files, but the checked-in workflow content should have one source of truth.

Exit criterion: an automated compatibility matrix installs the packed artifact and verifies tool discovery plus one mocked call in every harness. A manual release checklist verifies one real read-only Databricks sandbox call from every harness.

### 5. Publish the first portable beta

- Publish an npm prerelease, create a Git tag and GitHub release, attach the pack manifest and checksums, and include exact supported capabilities.
- Use `0.2.0-beta.1` for the first MCP build. Promote to `0.2.0` only after the compatibility matrix passes on Windows, macOS, and Linux.
- Keep live tests opt-in and sandbox-only. CI should use mocked HTTP and a fake MCP client; release qualification should use a dedicated least-privilege Databricks workspace.
- Document uninstall and credential rotation along with install steps.

Exit criterion: a new user can follow the README from a clean machine, configure a sandbox, run a diagnosis, and remove the package without undocumented steps.

## Extension roadmap

Provider order, workspace profiles, identity improvements, shared validation, observability, and adapter readiness criteria are maintained in [FUTURE_WORK.md](FUTURE_WORK.md).

## Release gate checklist

A release candidate is ready only when all applicable rows pass:

- `npm run typecheck`, unit tests, MCP protocol tests, and packed-install tests pass.
- The npm tarball is inspected; no `.env`, token, cache, fixture credential, or unrelated file is present.
- Skill frontmatter parses in Pi, Claude Code, Codex, and DeepSeek Harness.
- Every claimed harness discovers the same read-only tools from the packed artifact.
- Mutation tools are unavailable when a tested approval gate is absent.
- Databricks sandbox smoke tests prove inspection, pagination, truncation, timeout, redaction, and cancellation behavior.
- README, environment guide, support matrix, changelog, package metadata, tag, and release notes agree on the version and supported capabilities.
- Published is distinguished from released: npm publication, Git tag, and GitHub release are each verified independently.

## References used for interoperability decisions

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Codex skill locations](https://developers.openai.com/codex/skills)
- [Claude Code MCP configuration](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
