import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabricksClient } from "../src/client.ts";
import { toolResult } from "../src/core.ts";
import { DatabricksAdapter } from "../src/databricks-adapter.ts";

test("adapter keeps reads outside the approval gate", async () => {
  let seen: Request | undefined;
  const client = new DatabricksClient({ host: "https://example.com", token: "secret" }, async (input, init) => {
    seen = new Request(input, init);
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  });
  const adapter = new DatabricksAdapter(client);

  assert.deepEqual(await adapter.execute({ kind: "inspect", action: "jobs" }), { jobs: [] });
  assert.equal(seen?.url, "https://example.com/api/2.2/jobs/list?limit=25");
});

test("adapter fails closed before a mutation reaches the transport", async () => {
  let requests = 0;
  const client = new DatabricksClient({ host: "https://example.com", token: "secret" }, async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  });
  const adapter = new DatabricksAdapter(client);

  await assert.rejects(
    adapter.execute({ kind: "pipeline", action: "start", pipeline_id: "pipeline-1" }),
    /interactive approval gate.*read-only/i,
  );
  assert.equal(requests, 0);
});

test("adapter submits the exact approved mutation", async () => {
  let seen: Request | undefined;
  let approval: unknown;
  const client = new DatabricksClient({ host: "https://example.com", token: "secret" }, async (input, init) => {
    seen = new Request(input, init);
    return new Response(JSON.stringify({ update_id: "u-1" }), { status: 200 });
  });
  const adapter = new DatabricksAdapter(client);

  const result = await adapter.execute(
    { kind: "pipeline", action: "start", pipeline_id: "pipeline-1", full_refresh: false },
    { approvalGate: { async confirm(request) { approval = request; return true; } } },
  );

  assert.deepEqual(result, { update_id: "u-1" });
  assert.equal(seen?.url, "https://example.com/api/2.0/pipelines/pipeline-1/updates");
  assert.equal(seen?.method, "POST");
  assert.deepEqual(await seen?.json(), { full_refresh: false });
  assert.match(JSON.stringify(approval), /pipeline-1/);
});

test("oversized results bound text and structured content", () => {
  const result = toolResult("databricks", "https://example.com", { value: "x".repeat(100) }, 80);
  assert.equal(result.details.truncated, true);
  assert.equal(result.structuredContent.truncated, true);
  assert.deepEqual(result.structuredContent.data, {
    omitted: true,
    reason: "Result exceeded the structured output limit. Narrow the request or follow pagination.",
  });
  assert.ok(result.content[0].text.length <= 80);
  assert.match(result.content[0].text, /Output truncated/);
});
