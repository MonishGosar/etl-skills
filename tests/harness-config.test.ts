import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Claude plugin launches the bundled MCP server in read-only mode", async () => {
  const config = JSON.parse(await readFile(".mcp.json", "utf8"));
  assert.equal(config.mcpServers.etl.command, "node");
  assert.deepEqual(config.mcpServers.etl.args, ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js", "--read-only"]);
  assert.equal(config.mcpServers.etl.env.DATABRICKS_TOKEN, "${DATABRICKS_TOKEN:-}");
});

test("Codex template uses the installed portable executable and forwards variable names only", async () => {
  const config = await readFile("config/codex.config.toml", "utf8");
  assert.match(config, /command = "etl-agent-tools-mcp"/);
  assert.match(config, /"--read-only"/);
  assert.match(config, /env_vars = \["DATABRICKS_HOST", "DATABRICKS_TOKEN"/);
  assert.doesNotMatch(config, /dapi[a-zA-Z0-9]+/);
});

test("DeepSeek overlay opts into credential forwarding and read-only mode", async () => {
  const config = await readFile("config/deepseek.cordis.yml", "utf8");
  assert.match(config, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(config, /command: etl-agent-tools-mcp/);
  assert.match(config, /args: \['--read-only'\]/);
  assert.match(config, /DATABRICKS_TOKEN: !!js process\.env\.DATABRICKS_TOKEN/);
  assert.doesNotMatch(config, /dapi[a-zA-Z0-9]+/);
});
