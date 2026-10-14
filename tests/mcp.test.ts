import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";

type RpcResponse = { id?: number; result?: any; error?: unknown };

function startMcp(args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["dist/mcp.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABRICKS_HOST: "",
      DATABRICKS_TOKEN: "",
      DBT_ARTIFACTS_DIR: "",
      DBT_PROJECT_DIR: "",
      DBT_LOG_PATH: "",
      AIRFLOW_BASE_URL: "",
      AIRFLOW_API_VERSION: "",
      AIRFLOW_AUTH_MODE: "",
      AIRFLOW_TOKEN: "",
      AIRFLOW_USERNAME: "",
      AIRFLOW_PASSWORD: "",
      ...extra,
    },
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
      ["etl_capabilities", "etl_inspect", "etl_query_status", "etl_diagnose"],
    );
    assert.ok(listed.result.tools.every((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint));

    const called = await mcp.request(3, "tools/call", { name: "etl_capabilities", arguments: {} });
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.structuredContent.data.mode, "read-only");
    const providers = called.result.structuredContent.data.providers;
    assert.deepEqual(providers.find((provider: { provider: string }) => provider.provider === "databricks").operations, ["inspect", "query_status"]);
    assert.equal(providers.find((provider: { provider: string }) => provider.provider === "databricks").configured, false);
    assert.deepEqual(providers.find((provider: { provider: string }) => provider.provider === "dbt").operations, ["inspect", "diagnose"]);
    assert.deepEqual(providers.find((provider: { provider: string }) => provider.provider === "airflow").unavailableMutations, ["trigger", "clear", "retry", "pause", "backfill"]);
  } finally {
    mcp.child.kill();
  }
});

test("MCP diagnose reads local dbt artifacts and does not return compiled SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-mcp-dbt-"));
  await writeFile(join(directory, "run_results.json"), JSON.stringify({
    metadata: { invocation_id: "inv-mcp" },
    results: [
      { unique_id: "model.proj.orders", status: "error", message: "Database Error in model orders", compiled_code: "select secret_password from orders" },
      { unique_id: "model.proj.metrics", status: "skipped", message: "" },
    ],
  }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    nodes: {
      "model.proj.orders": { name: "orders", resource_type: "model", original_file_path: "models/orders.sql" },
      "model.proj.metrics": { name: "metrics", resource_type: "model", original_file_path: "models/metrics.sql" },
    },
    child_map: { "model.proj.orders": ["model.proj.metrics"] },
  }));
  const mcp = startMcp(["--read-only"], { DBT_ARTIFACTS_DIR: directory });
  try {
    await mcp.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "etl-agent-tools-test", version: "1.0.0" },
    });
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const called = await mcp.request(2, "tools/call", { name: "etl_diagnose", arguments: { provider: "dbt" } });
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.structuredContent.provider, "dbt");
    assert.equal(called.result.structuredContent.data.failed.id, "model.proj.orders");
    assert.equal(called.result.structuredContent.data.likelyCause.category, "database");
    assert.equal(called.result.structuredContent.data.impact.downstream[0].id, "model.proj.metrics");
    assert.doesNotMatch(JSON.stringify(called.result), /secret_password/);
  } finally {
    mcp.child.kill();
    await rm(directory, { recursive: true, force: true });
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
    assert.match(diagnose, /etl_diagnose/);
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
