import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";

type RpcResponse = { id?: number; result?: any; error?: unknown };

function startMcp(args: string[] = []) {
  const child = spawn(process.execPath, ["dist/mcp.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABRICKS_HOST: "", DATABRICKS_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<number, (message: RpcResponse) => void>();
  lines.on("line", line => {
    const message = JSON.parse(line) as RpcResponse;
    if (typeof message.id === "number") waiting.get(message.id)?.(message);
  });
  function send(message: object) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(id: number, method: string, params?: object): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5_000);
      waiting.set(id, message => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }
  return { child, request, send };
}

test("stdio MCP server exposes only the portable read tools", async () => {
  const mcp = startMcp(["--read-only"]);
  try {
    const initialized = await mcp.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "etl-agent-tools-test", version: "1.0.0" },
    });
    assert.equal(initialized.error, undefined);
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await mcp.request(2, "tools/list", {});
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      ["etl_capabilities", "etl_inspect", "etl_query_status"],
    );
    assert.ok(listed.result.tools.every((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint));

    const called = await mcp.request(3, "tools/call", { name: "etl_capabilities", arguments: {} });
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.structuredContent.data.mode, "read-only");
    assert.deepEqual(called.result.structuredContent.data.operations, ["inspect", "query_status"]);
  } finally {
    mcp.child.kill();
  }
});

test("MCP executable rejects unsupported modes", async () => {
  const child = spawn(process.execPath, ["dist/mcp.js", "--allow-mutations"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 2);
  assert.match(stderr, /supports only --read-only/);
});

test("skill installer copies every shared skill into an agents directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-agent-tools-skills-"));
  const target = join(directory, ".agents", "skills");
  try {
    const child = spawn(process.execPath, ["dist/install-skills.js", "--target", target], { stdio: ["ignore", "pipe", "pipe"] });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const setup = await readFile(join(target, "setup-etl-workspace", "SKILL.md"), "utf8");
    assert.match(setup, /name: setup-etl-workspace/);
    const diagnose = await readFile(join(target, "diagnose-pipeline", "SKILL.md"), "utf8");
    assert.match(diagnose, /etl_inspect/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup command configures every harness without writing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-agent-tools-setup-"));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const child = spawn(process.execPath, ["dist/setup.js", "--harness", "all", "--target", directory], { stdio: ["ignore", "pipe", "pipe"] });
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
    }
    const codex = await readFile(join(directory, ".codex", "config.toml"), "utf8");
    assert.match(codex, /command = "etl-agent-tools-mcp"/);
    const claude = JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8"));
    assert.deepEqual(claude.mcpServers.etl.args, ["--read-only"]);
    const deepseek = await readFile(join(directory, ".etl-agent", "deepseek.cordis.yml"), "utf8");
    assert.match(deepseek, /@deepseek-ai\/dsh-mcp-client/);
    const profile = await readFile(join(directory, ".etl-agent", "project.md"), "utf8");
    assert.match(profile, /Required variables: DATABRICKS_HOST, DATABRICKS_TOKEN/);
    assert.doesNotMatch(profile, /dapi[a-zA-Z0-9]+/);
    await readFile(join(directory, ".claude", "skills", "setup-etl-workspace", "SKILL.md"), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
