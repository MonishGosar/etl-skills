import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DbtAdapter, diagnoseDbtInvocation, parseDbtInvocation, parseDbtManifest } from "../src/dbt-adapter.ts";

const secret = "super-secret-token";

function manifest() {
  return {
    nodes: {
      "model.proj.stg": { name: "stg", resource_type: "model", original_file_path: "models/stg.sql", depends_on: { nodes: [] } },
      "model.proj.orders": { name: "orders", resource_type: "model", original_file_path: "models/orders.sql", depends_on: { nodes: ["model.proj.stg"] } },
      "model.proj.metrics": { name: "metrics", resource_type: "model", original_file_path: "models/metrics.sql", depends_on: { nodes: ["model.proj.orders"] } },
    },
    parent_map: {
      "model.proj.orders": ["model.proj.stg"],
      "model.proj.metrics": ["model.proj.orders"],
    },
    child_map: {
      "model.proj.stg": ["model.proj.orders"],
      "model.proj.orders": ["model.proj.metrics"],
    },
  };
}

function runResults(extra: Record<string, unknown> = {}) {
  return {
    metadata: { invocation_id: "inv-1", generated_at: "2026-10-13T01:00:00Z" },
    results: [
      { unique_id: "model.proj.stg", status: "success", message: "", compiled_code: `select '${secret}' as leak` },
      {
        unique_id: "model.proj.orders",
        status: "error",
        message: `Database Error in model orders (models/orders.sql)\n  password=${secret}`,
        compiled_code: "select * from raw.orders",
        ...extra,
      },
      { unique_id: "model.proj.metrics", status: "skipped", message: "Skipped because of upstream failure" },
    ],
  };
}

test("dbt parser keeps the first failed node and drops compiled SQL", () => {
  const invocation = parseDbtInvocation(runResults());
  const brief = diagnoseDbtInvocation({
    invocation,
    graph: parseDbtManifest(manifest()),
    artifactsDir: "/tmp/target",
    secrets: [secret],
  });
  assert.equal(brief.outcome, "failed");
  assert.equal(brief.failed?.id, "model.proj.orders");
  assert.equal(brief.failed?.name, "orders");
  assert.equal(brief.failed?.location, "models/orders.sql");
  assert.equal(brief.likelyCause.category, "database");
  assert.deepEqual(brief.impact.upstream.map(item => item.id), ["model.proj.stg"]);
  assert.equal(brief.impact.upstream[0]?.status, "success");
  assert.deepEqual(brief.impact.downstream.map(item => ({ id: item.id, status: item.status })), [
    { id: "model.proj.metrics", status: "skipped" },
  ]);
  const serialized = JSON.stringify(brief);
  assert.doesNotMatch(serialized, /compiled_code/);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(brief.errorExcerpt, /Database Error in model orders/);
  assert.match(brief.suggestedNextStep, /warehouse/i);
});

test("dbt test failures and compilation errors keep their categories", () => {
  const testBrief = diagnoseDbtInvocation({
    invocation: parseDbtInvocation({
      results: [{ unique_id: "test.proj.not_null_orders_id", status: "fail", message: "Got 4 results, configured to fail if != 0" }],
    }),
    graph: parseDbtManifest({
      nodes: { "test.proj.not_null_orders_id": { name: "not_null_orders_id", resource_type: "test", original_file_path: "tests/not_null.sql" } },
    }),
    artifactsDir: "/tmp/target",
  });
  assert.equal(testBrief.likelyCause.category, "test_failure");
  assert.equal(testBrief.failed?.location, "tests/not_null.sql");

  const compileBrief = diagnoseDbtInvocation({
    invocation: parseDbtInvocation({
      results: [{ unique_id: "model.proj.orders", status: "error", message: "Compilation Error in model orders\n  'dbt_utils' is undefined" }],
    }),
    graph: parseDbtManifest(undefined),
    artifactsDir: "/tmp/target",
  });
  assert.equal(compileBrief.likelyCause.category, "compilation");
  assert.match(compileBrief.evidence.map(item => item.observation).join("\n"), /manifest.json was not available/);
  assert.deepEqual(compileBrief.impact.upstream, []);
});

test("dbt reports no_failure without inventing a node", () => {
  const brief = diagnoseDbtInvocation({
    invocation: parseDbtInvocation({ results: [{ unique_id: "model.proj.orders", status: "success", message: "" }] }),
    graph: parseDbtManifest(undefined),
    artifactsDir: "/tmp/target",
  });
  assert.equal(brief.outcome, "no_failure");
  assert.equal(brief.failed, null);
});

test("dbt artifact files are read from a directory and refuse symlink escape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-dbt-"));
  const outside = await mkdtemp(join(tmpdir(), "etl-dbt-outside-"));
  await writeFile(join(directory, "run_results.json"), JSON.stringify(runResults()));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
  await writeFile(join(directory, "dbt.log"), `INFO start\nDatabase Error in model orders\npassword=${secret}\n`);
  const adapter = new DbtAdapter(directory, { DBT_LOG_PATH: "" });
  const brief = await adapter.diagnose();
  assert.equal(brief.failed?.id, "model.proj.orders");
  assert.doesNotMatch(JSON.stringify(brief), new RegExp(secret));
  assert.match(brief.evidence.map(item => item.observation).join("\n"), /dbt.log/);

  const escaped = await mkdtemp(join(tmpdir(), "etl-dbt-escape-"));
  await writeFile(join(outside, "run_results.json"), JSON.stringify({ results: [], password: secret }));
  await symlink(join(outside, "run_results.json"), join(escaped, "run_results.json"));
  await assert.rejects(new DbtAdapter(escaped).diagnose(), /outside/);
});

test("invalid dbt artifacts do not echo file contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-dbt-invalid-"));
  await writeFile(join(directory, "run_results.json"), `{"password":"${secret}"}`);
  await assert.rejects(new DbtAdapter(directory).diagnose(), /no results array/);
  try {
    await new DbtAdapter(directory).diagnose();
  } catch (error) {
    assert.doesNotMatch(error instanceof Error ? error.message : "", new RegExp(secret));
  }
});

test("dbt inspect returns a summary and one node without compiled SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etl-dbt-inspect-"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run_results.json"), JSON.stringify(runResults()));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
  const adapter = new DbtAdapter(directory, {});
  const summary = await adapter.inspect("run_results");
  assert.equal((summary as { invocation_id: string }).invocation_id, "inv-1");
  assert.equal((summary as { failed: Array<{ id: string }> }).failed[0]?.id, "model.proj.orders");
  assert.doesNotMatch(JSON.stringify(summary), /select \* from raw/);
  const node = await adapter.inspect("node", "model.proj.orders");
  assert.equal((node as { original_file_path: string }).original_file_path, "models/orders.sql");
  assert.doesNotMatch(JSON.stringify(node), new RegExp(secret));
});

test("downstream impact is capped", () => {
  const children = Array.from({ length: 30 }, (_, index) => `model.proj.child_${index}`);
  const brief = diagnoseDbtInvocation({
    invocation: parseDbtInvocation({ results: [{ unique_id: "model.proj.orders", status: "error", message: "Database Error" }] }),
    graph: parseDbtManifest({
      nodes: { "model.proj.orders": { name: "orders", resource_type: "model" } },
      child_map: { "model.proj.orders": children },
    }),
    artifactsDir: "/tmp/target",
  });
  assert.equal(brief.impact.downstream.length, 25);
  assert.equal(brief.impact.truncated, true);
});
