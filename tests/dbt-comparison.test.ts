import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareDbtSnapshots } from "../src/dbt-comparison.ts";
import { DbtAdapter, diagnoseDbtInvocation, parseDbtInvocation, parseDbtManifest } from "../src/dbt-adapter.ts";

function snapshot(current = false) {
  const metadata = { invocation_id: current ? "new" : "old", project_id: "project", generated_at: current ? "2026-11-12T02:00:00Z" : "2026-11-12T01:00:00Z" };
  return {
    invocation: parseDbtInvocation({ metadata, results: [
      { unique_id: "model.p.report", status: current ? "error" : "success", message: "Database Error downstream" },
      { unique_id: "model.p.ledger", status: current ? "error" : "success", message: "Compilation Error: missing macro" },
    ] }),
    graph: parseDbtManifest({ metadata, nodes: {
      "model.p.report": { name: "report", raw_code: "select * from ledger", config: {}, columns: {} },
      "model.p.ledger": { name: "ledger", raw_code: current ? "select gross_amount" : "select amount", config: { incremental_strategy: current ? "append" : "delete+insert", secret: "DO_NOT_RETURN" }, columns: {} },
      "source.p.payments": { name: "payments", columns: current ? { gross_amount: { data_type: "decimal" } } : { amount: { data_type: "integer" } } },
      "model.p.unrelated": { name: "unrelated", raw_code: current ? "select 2" : "select 1", config: {}, columns: {} },
    }, parent_map: { "model.p.report": ["model.p.ledger"], "model.p.ledger": ["source.p.payments"] } }),
  };
}

test("diagnosis selects the upstream failing subject and keeps invocation-wide log errors separate", () => {
  const current = snapshot(true);
  const brief = diagnoseDbtInvocation({ ...current, artifactsDir: "/unused", log: "permission denied for unrelated task" });
  assert.equal(brief.failed?.id, "model.p.ledger");
  assert.equal(brief.likelyCause.category, "compilation");
  assert.deepEqual(brief.additionalFailures.map(f => f.id), ["model.p.report"]);
  current.invocation.results.forEach(result => { result.message = ""; });
  const missing = diagnoseDbtInvocation({ ...current, artifactsDir: "/unused", log: "permission denied for an unrelated failure" });
  assert.equal(missing.likelyCause.category, "unknown");
  assert.match(missing.evidence.map(e => e.observation).join(" "), /not attributed/);
});

test("comparison exposes changes and upstream evidence without raw code or configuration values", () => {
  const result = compareDbtSnapshots(snapshot(), snapshot(true));
  assert.equal(result.focusNode, "model.p.ledger");
  assert.equal(result.changedUpstreamNodes, 1);
  assert.deepEqual(result.changes.find(c => c.id === "model.p.ledger")?.kinds, ["code", "configuration"]);
  const source = result.changes.find(c => c.id === "source.p.payments")!;
  assert.equal(source.relation, "upstream");
  assert.deepEqual(source.columns.added, ["gross_amount"]);
  assert.deepEqual(source.columns.removed, ["amount"]);
  assert.equal(result.changes.at(-1)?.relation, "unrelated");
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETURN|select gross_amount/);
});

test("identity, ordering and successful baseline requirements reject invalid comparisons", () => {
  const before = snapshot();
  const after = snapshot(true);
  assert.throws(() => compareDbtSnapshots(after, before), /Baseline must contain successful/);
  assert.throws(() => compareDbtSnapshots(before, before), /same invocation/);
  const foreign = snapshot(true);
  foreign.graph.projectId = "foreign";
  assert.throws(() => compareDbtSnapshots(before, foreign), /different dbt projects/);
  const mixed = snapshot(true);
  mixed.graph.invocationId = "different";
  assert.throws(() => compareDbtSnapshots(before, mixed), /different invocations/);
  const older = snapshot(true);
  older.invocation.generatedAt = "2026-11-11T00:00:00Z";
  assert.throws(() => compareDbtSnapshots(before, older), /must precede/);
  assert.throws(() => compareDbtSnapshots(before, after, "missing"), /absent/);
  before.invocation.results[0].status = "warn";
  assert.throws(() => compareDbtSnapshots(before, after), /without failures, warnings/);
});

test("missing column metadata does not become a fabricated schema deletion", () => {
  const before = snapshot();
  const after = snapshot(true);
  after.graph.nodes.get("source.p.payments")!.columns = undefined;
  const result = compareDbtSnapshots(before, after);
  assert.equal(result.changes.some(c => c.id === "source.p.payments"), false);
  assert.match(result.notes.join(" "), /incomplete comparison metadata/);
});

test("cycles and multiple independent failing subjects remain explicitly uncertain", () => {
  const current = snapshot(true);
  current.graph.parents.set("model.p.ledger", ["model.p.report"]);
  const brief = diagnoseDbtInvocation({ ...current, artifactsDir: "/unused" });
  assert.equal(brief.failed?.id, "model.p.report");
  assert.match(brief.evidence.map(e => e.observation).join(" "), /cyclic/);
  current.graph.parents.clear();
  const independent = diagnoseDbtInvocation({ ...current, artifactsDir: "/unused" });
  assert.match(independent.evidence.map(e => e.observation).join(" "), /2 upstream-most failing candidates/);
  current.invocation.results = [current.invocation.results[0]];
  current.graph.parents.set("model.p.report", ["model.p.report"]);
  const selfLoop = diagnoseDbtInvocation({ ...current, artifactsDir: "/unused" });
  assert.match(selfLoop.evidence.map(e => e.observation).join(" "), /cyclic/);
});

test("adapter comparison redacts artifact labels, ignores configured logs and bounds output", async () => {
  const oldDir = await mkdtemp(join(tmpdir(), "etl-before-"));
  const newDir = await mkdtemp(join(tmpdir(), "etl-after-"));
  try {
    for (const [directory, id, date] of [[oldDir, "old", "2026-11-11"], [newDir, "new", "2026-11-12"]]) {
      const metadata = { invocation_id: id, project_id: "p", generated_at: date };
      await writeFile(join(directory, "run_results.json"), JSON.stringify({ metadata, results: [{ unique_id: "model.p.focus", status: "success" }] }));
      const nodes = Object.fromEntries(Array.from({length: 35}, (_, i) => [`model.p.${i}`, { name: "password=synthetic-secret", raw_code: `${id}: ${i}`, config: {}, columns: {} }]));
      nodes["model.p.focus"] = { name: "focus", raw_code: "same", config: {}, columns: {} };
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ metadata, nodes }));
    }
    const adapter = new DbtAdapter(newDir, { DBT_LOG_PATH: "/this-must-not-be-read", DATABRICKS_TOKEN: "synthetic-secret" });
    const result = await adapter.compareRuns(oldDir) as { truncated: boolean; changes: unknown[] };
    assert.equal(result.truncated, true);
    assert.equal(result.changes.length, 25);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
    await assert.rejects(adapter.compareRuns(newDir), /different directories/);
    await assert.rejects(adapter.compareRuns(oldDir, undefined, AbortSignal.abort()), /interrupted/);
  } finally { await rm(oldDir, {recursive: true, force: true}); await rm(newDir, {recursive: true, force: true}); }
});
