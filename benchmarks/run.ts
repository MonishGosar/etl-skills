import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AirflowAdapter } from "../src/airflow-adapter.ts";
import { DbtAdapter } from "../src/dbt-adapter.ts";
import type { CauseCategory, DiagnosisBrief, DiagnosisConfidence } from "../src/diagnosis.ts";

type Incident = {
  id: string; split: string; provider: string; message: string; status: string;
  resource_type: string; expected_category: CauseCategory; max_confidence: DiagnosisConfidence;
};
const { values } = parseArgs({ options: {
  split: { type: "string", default: "dev" }, output: { type: "string" },
  baseline: { type: "string" }, gate: { type: "boolean", default: false },
} });
if (!["dev", "holdout", "all"].includes(values.split!)) throw new Error("Use --split dev|holdout|all");
const root = resolve(import.meta.dirname, "..");
const raw = await readFile(resolve(root, "benchmarks/incidents.json"), "utf8");
const dataset = JSON.parse(raw) as { cases: Incident[] };
const cases = dataset.cases.filter(c => values.split === "all" || c.split === values.split);
if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Invalid cases");
const secret = "synthetic-benchmark-secret";
type Check = "category_correct" | "confidence_appropriate" | "subject_correct" | "lineage_correct" | "secret_redacted" | "read_only";
type Result = {
  id: string; split: string; provider: string; expected: CauseCategory; predicted: string;
  confidence?: DiagnosisConfidence; checks: Record<Check, boolean>; passed: boolean;
  latency_ms: number; tool_http_calls: number; error?: string;
};
const results: Result[] = [];
for (const c of cases) {
  const started = performance.now();
  let calls = 0;
  let mutations = 0;
  let brief: DiagnosisBrief | undefined;
  let error: string | undefined;
  const upstream = c.provider === "dbt" ? "source.bench.raw_orders" : "extract";
  const primary = c.provider === "dbt" ? `${c.resource_type}.bench.transform` : "transform";
  const downstream = c.provider === "dbt" ? "model.bench.dashboard" : "dashboard";
  try {
    if (c.provider === "dbt") {
      const temp = await mkdtemp(resolve(tmpdir(), "etl-bench-"));
      try {
        await writeFile(resolve(temp, "run_results.json"), JSON.stringify({results: [
          {unique_id: primary, status: c.status, message: `${c.message}\npassword=${secret}`},
          {unique_id: downstream, status: "skipped", message: ""},
        ]}));
        await writeFile(resolve(temp, "manifest.json"), JSON.stringify({nodes: {
          [primary]: {name: "transform", resource_type: c.resource_type},
          [downstream]: {name: "dashboard", resource_type: "model"},
        }, parent_map: {[primary]: [upstream]}, child_map: {[primary]: [downstream]}}));
        brief = await new DbtAdapter(temp, {}).diagnose();
      } finally { await rm(temp, {recursive: true, force: true}); }
    } else {
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        headers: {"content-type": "application/json"},
      });
      const adapter = AirflowAdapter.fromConfig({baseUrl: "https://benchmark.example.test",
        apiVersion: "v2", authMode: "bearer", token: secret, environment: "benchmark"},
      async (input, init) => {
        calls++;
        if ((init?.method ?? "GET") !== "GET") { mutations++; throw new Error("Mutation attempted"); }
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/taskInstances")) return json({task_instances: [
          {task_id: upstream, state: "success", try_number: 1},
          {task_id: primary, state: c.status, try_number: 1},
          {task_id: downstream, state: "upstream_failed", try_number: 1},
        ], total_entries: 3});
        if (url.pathname.endsWith("/tasks")) return json({tasks: [
          {task_id: primary, upstream_task_ids: [upstream], downstream_task_ids: [downstream]},
        ], total_entries: 1});
        if (url.pathname.includes("/logs/")) return json({content: `${c.message}\npassword=${secret}`});
        if (url.pathname.endsWith("/dagRuns/replay")) return json({state: "failed"});
        throw new Error("Unexpected benchmark request");
      });
      brief = await adapter.diagnose({dagId: "benchmark", dagRunId: "replay", taskId: primary});
    }
  } catch (exc) { error = exc instanceof Error ? exc.message : "Run failed"; }
  const confidence = {low: 0, medium: 1, high: 2};
  const checks = {
    category_correct: brief?.likelyCause.category === c.expected_category,
    confidence_appropriate: Boolean(brief && confidence[brief.likelyCause.confidence] <= confidence[c.max_confidence]),
    subject_correct: brief?.failed?.id === primary,
    lineage_correct: Boolean(brief?.impact.upstream.some(r => r.id === upstream) && brief?.impact.downstream.some(r => r.id === downstream)),
    secret_redacted: Boolean(brief && !JSON.stringify(brief).includes(secret)),
    read_only: mutations === 0 && !error,
  };
  results.push({id: c.id, split: c.split, provider: c.provider, expected: c.expected_category,
    predicted: brief?.likelyCause.category ?? "error", confidence: brief?.likelyCause.confidence,
    checks, passed: Object.values(checks).every(Boolean), latency_ms: performance.now() - started,
    tool_http_calls: calls, ...(error ? {error} : {})});
}
const categories = [...new Set(cases.map(c => c.expected_category))];
const perCategory = Object.fromEntries(categories.map(category => {
  const tp = results.filter(r => r.expected === category && r.predicted === category).length;
  const fp = results.filter(r => r.expected !== category && r.predicted === category).length;
  const fn = results.filter(r => r.expected === category && r.predicted !== category).length;
  return [category, {support: tp + fn, correct: tp, f1: 2 * tp / (2 * tp + fp + fn)}];
}));
const metrics = Object.fromEntries(Object.keys(results[0].checks).map(key => [
  key, results.filter(r => r.checks[key as keyof typeof r.checks]).length / results.length,
]));
metrics.macro_f1 = Object.values(perCategory).reduce((sum, c) => sum + c.f1, 0) / categories.length;
metrics.case_pass_rate = results.filter(r => r.passed).length / results.length;
const sorted = results.map(r => r.latency_ms).sort((a,b) => a-b);
const report = {schema_version: 1, benchmark: "synthetic-adapter-incidents-v1", split: values.split,
  dataset_sha256: createHash("sha256").update(raw).digest("hex"),
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim(),
  source_dirty: Boolean(execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim()),
  node_version: process.version, cases: results.length, metrics, per_category: perCategory,
  latency_ms: {p50: sorted[Math.ceil(sorted.length * .5)-1], p95: sorted[Math.ceil(sorted.length * .95)-1]},
  limitations: "Synthetic adapter diagnosis only; no live warehouse, Databricks diagnosis, LLM, repair execution, cost estimate, or Spider score. Latency includes local fixture IO.", results};
let regression = false;
if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, "utf8"));
  if (baseline.dataset_sha256 !== report.dataset_sha256 || baseline.split !== report.split) throw new Error("Baseline dataset/split mismatch");
  for (const [key, value] of Object.entries(metrics)) {
    if (value < baseline.metrics[key]) regression = true;
  }
}
if (values.output) {
  const path = resolve(values.output);
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({cases: report.cases, split: report.split, metrics, failures: results.filter(r => !r.passed)}, null, 2));
if (values.gate && (regression || metrics.category_correct < .9 || metrics.confidence_appropriate < 1 || metrics.subject_correct < 1 || metrics.secret_redacted < 1 || metrics.lineage_correct < 1 || metrics.read_only < 1)) process.exitCode = 1;
