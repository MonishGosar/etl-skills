import assert from "node:assert/strict";
import { test } from "node:test";
import { AirflowAdapter } from "../src/airflow-adapter.ts";
import { AirflowClient, airflowConfigFromEnv, type AirflowConfig } from "../src/airflow-client.ts";

const secret = "super-secret-token";

function config(overrides: Partial<AirflowConfig> = {}): AirflowConfig {
  return {
    baseUrl: "https://airflow.example.com",
    apiVersion: "v1",
    authMode: "bearer",
    token: secret,
    environment: "sandbox",
    ...overrides,
  };
}

test("airflow config accepts https and localhost and rejects other contracts", () => {
  assert.equal(airflowConfigFromEnv({
    AIRFLOW_BASE_URL: "https://airflow.example.com",
    AIRFLOW_API_VERSION: "v2",
    AIRFLOW_AUTH_MODE: "basic",
    AIRFLOW_USERNAME: "agent",
    AIRFLOW_PASSWORD: secret,
  }).apiVersion, "v2");
  assert.equal(airflowConfigFromEnv({
    AIRFLOW_BASE_URL: "http://localhost:8080",
    AIRFLOW_API_VERSION: "v1",
    AIRFLOW_TOKEN: secret,
  }).baseUrl, "http://localhost:8080");
  assert.throws(() => airflowConfigFromEnv({ AIRFLOW_BASE_URL: "http://airflow.internal", AIRFLOW_API_VERSION: "v1", AIRFLOW_TOKEN: secret }), /HTTPS/);
  assert.throws(() => airflowConfigFromEnv({ AIRFLOW_BASE_URL: "https://user:secret@airflow.example.com", AIRFLOW_API_VERSION: "v1", AIRFLOW_TOKEN: secret }), /credentials/);
  assert.throws(() => airflowConfigFromEnv({ AIRFLOW_BASE_URL: "https://airflow.example.com/api", AIRFLOW_API_VERSION: "v1", AIRFLOW_TOKEN: secret }), /origin/);
  assert.throws(() => airflowConfigFromEnv({ AIRFLOW_BASE_URL: "https://airflow.example.com", AIRFLOW_TOKEN: secret }), /AIRFLOW_API_VERSION/);
  assert.throws(() => airflowConfigFromEnv({
    AIRFLOW_BASE_URL: "https://airflow.example.com",
    AIRFLOW_API_VERSION: "v2",
    AIRFLOW_AUTH_MODE: "aws-mwaa",
  }), /not available/);
});

test("airflow client sends GET, redacts tokens, and hides error bodies", async () => {
  let seen: Request | undefined;
  const client = new AirflowClient(config(), async (input, init) => {
    seen = new Request(input, init);
    const url = new URL(seen.url);
    if (url.pathname.endsWith("/logs/2")) return new Response(`password=${secret}\nBearer ${secret}`, { status: 200, headers: { "content-type": "text/plain" } });
    if (url.pathname.includes("/fail")) return new Response(`password=${secret}`, { status: 500 });
    return new Response(JSON.stringify({ value: secret, ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const payload = await client.request(["dags", "orders"]);
  assert.equal(seen?.method, "GET");
  assert.equal(seen?.headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(new URL(seen?.url ?? "").pathname, "/api/v1/dags/orders");
  assert.deepEqual(payload, { value: "[REDACTED]", ok: true });
  await assert.rejects(client.request(["fail"]), (error: Error) => {
    assert.match(error.message, /Airflow HTTP 500/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  const log = await client.request(["dags", "orders", "dagRuns", "manual__2026-01-01T00:00:00+00:00", "taskInstances", "transform", "logs", "2"], {}, undefined, "log");
  const parts = new URL(seen?.url ?? "").pathname.split("/");
  assert.equal(decodeURIComponent(parts[parts.indexOf("dagRuns") + 1] ?? ""), "manual__2026-01-01T00:00:00+00:00");
  assert.equal((log as { content: string }).content.includes(secret), false);
});

test("airflow client uses basic auth and the v2 prefix", async () => {
  let seen: Request | undefined;
  const client = new AirflowClient(config({ apiVersion: "v2", authMode: "basic", username: "agent", password: secret, token: undefined }), async (input, init) => {
    seen = new Request(input, init);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  await client.request(["dags"]);
  assert.equal(seen?.headers.get("authorization"), `Basic ${Buffer.from(`agent:${secret}`).toString("base64")}`);
  assert.equal(new URL(seen?.url ?? "").pathname, "/api/v2/dags");
});

function instances(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    task_id: `task_${start + index}`,
    state: "success",
    try_number: 1,
    start_date: "2026-01-01T00:00:00+00:00",
  }));
}

test("airflow diagnosis selects the earliest failed task and scrubs the log", async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}?${url.searchParams}`);
    if (url.pathname.endsWith("/dagRuns/run-1") && !url.pathname.includes("taskInstances")) {
      return json({
        dag_id: "orders",
        dag_run_id: "run-1",
        state: "failed",
        logical_date: "2026-01-01T00:00:00+00:00",
        conf: { password: secret },
      });
    }
    if (url.pathname.endsWith("/taskInstances")) {
      return json({
        task_instances: [
          { task_id: "extract", state: "success", try_number: 1, start_date: "2026-01-01T00:00:00+00:00" },
          { task_id: "load", state: "upstream_failed", try_number: 1, start_date: "2026-01-01T00:03:00+00:00" },
          { task_id: "late", state: "failed", try_number: 1, start_date: "2026-01-01T00:05:00+00:00" },
          { task_id: "transform", state: "failed", try_number: 2, start_date: "2026-01-01T00:02:00+00:00", operator: "BashOperator" },
        ],
        total_entries: 4,
      });
    }
    if (url.pathname.endsWith("/tasks")) {
      return json({
        tasks: [
          { task_id: "extract", upstream_task_ids: [], downstream_task_ids: ["transform"] },
          { task_id: "transform", upstream_task_ids: ["extract"], downstream_task_ids: ["load"] },
          { task_id: "load", upstream_task_ids: ["transform"], downstream_task_ids: [] },
          { task_id: "late", upstream_task_ids: [], downstream_task_ids: [] },
        ],
        total_entries: 4,
      });
    }
    if (url.pathname.endsWith("/logs/2")) {
      return new Response("missing", { status: 404 });
    }
    if (url.pathname.endsWith("/logs/1")) {
      return json({ content: [`Database Error in model orders`, `password=${secret}`, `Bearer ${secret}`] });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const adapter = AirflowAdapter.fromConfig(config(), transport);
  const brief = await adapter.diagnose({ dagId: "orders", dagRunId: "run-1" });
  assert.equal(brief.outcome, "failed");
  assert.equal(brief.failed?.id, "transform");
  assert.equal(brief.failed?.location, "BashOperator");
  assert.equal(brief.likelyCause.category, "database");
  assert.deepEqual(brief.impact.upstream, [{ id: "extract", name: "extract", status: "success" }]);
  assert.deepEqual(brief.impact.downstream, [{ id: "load", name: "load", status: "upstream_failed" }]);
  assert.deepEqual(brief.additionalFailures.map(item => item.id), ["late"]);
  assert.match(brief.errorExcerpt, /Database Error in model orders/);
  const serialized = JSON.stringify(brief);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /"conf"/);
  assert.ok(calls.some(call => call.includes("/logs/2")));
  assert.ok(calls.some(call => call.includes("/logs/1")));
  assert.equal(adapter.workspace, "https://airflow.example.com (sandbox)");
});

test("airflow task pages follow offset and stop at the cap", async () => {
  const offsets: number[] = [];
  const transport: typeof fetch = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    offsets.push(offset);
    const count = offset === 0 ? 100 : 20;
    return json({ task_instances: instances(count, offset), total_entries: 120 });
  };
  const adapter = AirflowAdapter.fromConfig(config(), transport);
  const inspected = await adapter.inspect({ action: "task_instances", dagId: "orders", dagRunId: "run-1" });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal((inspected as { task_instances: unknown[] }).task_instances.length, 120);
  assert.equal((inspected as { truncated: boolean }).truncated, false);
});

test("airflow log failure still returns a brief without the error body", async () => {
  const transport: typeof fetch = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/dagRuns/run-1") && !url.pathname.includes("taskInstances") && !url.pathname.endsWith("/tasks")) {
      return json({ dag_id: "orders", dag_run_id: "run-1", state: "failed" });
    }
    if (url.pathname.endsWith("/taskInstances")) {
      return json({ task_instances: [{ task_id: "transform", state: "failed", try_number: 1 }], total_entries: 1 });
    }
    if (url.pathname.endsWith("/tasks")) return json({ tasks: [], total_entries: 0 });
    return new Response(`password=${secret}`, { status: 500 });
  };
  const brief = await AirflowAdapter.fromConfig(config(), transport).diagnose({ dagId: "orders", dagRunId: "run-1" });
  assert.equal(brief.failed?.id, "transform");
  assert.match(brief.evidence.map(item => item.observation).join("\n"), /HTTP 500/);
  assert.doesNotMatch(JSON.stringify(brief), new RegExp(secret));
});

test("aborted airflow requests do not claim a mutation", async () => {
  const client = new AirflowClient(config(), async () => {
    throw new Error("aborted");
  });
  await assert.rejects(client.request(["dags"], {}, AbortSignal.abort()), /No mutation was submitted/);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
