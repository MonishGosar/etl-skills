import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabricksClient, type Config } from "../src/client.ts";
import { DatabricksAdapter } from "../src/databricks-adapter.ts";
import { BILLING_COST_SQL, BILLING_USAGE_SQL, COLUMN_LINEAGE_SQL, normalizeTableLineage, TABLE_LINEAGE_SQL } from "../src/unity-catalog.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientFor(handler: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response, overrides: Partial<Config> = {}) {
  const config: Config = {
    host: "https://example.com",
    auth: "pat",
    token: "secret-token",
    warehouse: "warehouse-1",
    catalog: "production",
    ...overrides,
  };
  return new DatabricksClient(config, async (input, init) => handler(new URL(String(input)), init));
}

test("lineage normalization drops storage paths and keeps upstream and downstream tables", () => {
  const normalized = normalizeTableLineage({
    upstreams: [
      {
        tableInfo: { name: "raw_orders", catalog_name: "main", schema_name: "sales", table_type: "TABLE" },
        jobInfos: [{ job_id: "99" }],
        fileInfos: [{ path: "s3://private/secret-path" }],
      },
      { fileInfos: [{ path: "s3://private/other-secret" }] },
    ],
    downstreams: [
      { tableInfo: { name: "daily", catalog_name: "main", schema_name: "sales", table_type: "VIEW" } },
    ],
  });
  assert.deepEqual(normalized.upstreams, [{
    table: "main.sales.raw_orders",
    table_type: "TABLE",
    entities: [{ type: "job", id: "99" }],
    file_count: 1,
  }]);
  assert.equal(normalized.downstreams[0]?.table, "main.sales.daily");
  assert.equal(normalized.omitted_edges, 1);
  assert.equal(JSON.stringify(normalized).includes("s3://"), false);
});

test("unity catalog context reads lineage and grants without approval or caller SQL", async () => {
  const calls: string[] = [];
  const client = clientFor(url => {
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/2.0/lineage-tracking/table-lineage") {
      return json({
        upstreams: [{ tableInfo: { name: "raw_orders", catalog_name: "main", schema_name: "sales", table_type: "TABLE" }, jobInfos: [{ job_id: "99" }] }],
        downstreams: [{ tableInfo: { name: "daily", catalog_name: "main", schema_name: "sales", table_type: "TABLE" } }],
      });
    }
    if (url.pathname === "/api/2.0/lineage-tracking/column-lineage") {
      return json({
        upstream_cols: [{ name: "amount", catalog_name: "main", schema_name: "sales", table_name: "raw_orders" }],
        downstream_cols: [{ name: "amount", catalog_name: "main", schema_name: "sales", table_name: "daily" }],
      });
    }
    if (url.pathname.startsWith("/api/2.1/unity-catalog/permissions/TABLE/")) {
      const truncated = url.pathname.endsWith("main.sales.daily");
      return json({
        privilege_assignments: [{ principal: "etl-agent", privileges: ["SELECT", "MODIFY"] }],
        ...(truncated ? { next_page_token: "page-token-secret" } : {}),
      });
    }
    if (url.pathname.startsWith("/api/2.1/unity-catalog/effective-permissions/TABLE/")) {
      return json({
        privilege_assignments: [{
          principal: "etl-agent",
          privileges: [{ privilege: "SELECT", inherited_from_type: "SCHEMA", inherited_from_name: "main.sales" }],
        }],
      });
    }
    return json({ unexpected: url.pathname }, 500);
  });
  const adapter = new DatabricksAdapter(client);
  let approved = false;
  const result = await adapter.execute({ kind: "uc_context", table: "main.sales.orders", column: "amount" }, {
    approvalGate: { async confirm() { approved = true; return true; } },
  }) as {
    lineage: { source: string; upstreams: Array<{ table: string }>; column: { upstreams: Array<{ table?: string; column: string }> } };
    grants: Array<{ object: string; assignments?: Array<{ privileges: string[] }>; effective?: Array<{ privileges: Array<{ inherited_from_name?: string }> }>; truncated?: boolean }>;
    job_cost: { reason: string };
    grants_limited: boolean;
  };

  assert.equal(approved, false);
  assert.equal(result.lineage.source, "lineage-api");
  assert.deepEqual(result.lineage.upstreams.map(node => node.table), ["main.sales.raw_orders"]);
  assert.deepEqual(result.lineage.column.upstreams, [{ table: "main.sales.raw_orders", column: "amount" }]);
  assert.deepEqual(result.grants.map(grant => grant.object), ["main.sales.orders", "main.sales.raw_orders", "main.sales.daily"]);
  assert.deepEqual(result.grants[0]?.assignments?.[0]?.privileges, ["SELECT", "MODIFY"]);
  assert.equal(result.grants[0]?.effective?.[0]?.privileges[0]?.inherited_from_name, "main.sales");
  assert.equal(result.grants[2]?.truncated, true);
  assert.equal(JSON.stringify(result).includes("page-token-secret"), false);
  assert.equal(result.job_cost.reason, "not requested");
  assert.equal(result.grants_limited, false);
  assert.ok(calls.some(call => call.startsWith("/api/2.0/lineage-tracking/table-lineage?table_name=main.sales.orders&include_entity_lineage=true")));
  assert.ok(calls.some(call => call.includes("/api/2.1/unity-catalog/permissions/TABLE/main.sales.orders?max_results=150")));
  assert.equal(calls.some(call => call.includes("/api/2.0/sql/statements")), false);
});

test("lineage and grants degrade when not permitted and skip system tables without a warehouse", async () => {
  let calls = 0;
  const client = clientFor(() => {
    calls += 1;
    return json({ message: "secret-token" }, 403);
  }, { warehouse: undefined });
  const adapter = new DatabricksAdapter(client);
  const result = await adapter.execute({ kind: "uc_context", table: "main.sales.orders", job_id: "42" }) as {
    lineage: { available: boolean; reason: string; attempts: Array<{ source: string }> };
    grants: Array<{ available: boolean; reason: string }>;
    job_cost: { available: boolean; reason: string };
  };
  assert.equal(result.lineage.available, false);
  assert.equal(result.lineage.reason, "not permitted");
  assert.deepEqual(result.lineage.attempts.map(attempt => attempt.source), ["lineage-api", "system.access"]);
  assert.equal(result.grants[0]?.available, false);
  assert.equal(result.grants[0]?.reason, "not permitted");
  assert.equal(result.job_cost.reason, "DATABRICKS_WAREHOUSE_ID is not set");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.ok(calls >= 1);
});

test("system table lineage is the fallback and job cost uses bound parameters", async () => {
  const statements: Array<{ statement?: string; parameters?: Array<{ name: string; value: string }>; catalog?: string; query_tags?: unknown }> = [];
  const client = clientFor(async (url, init) => {
    if (url.pathname === "/api/2.0/lineage-tracking/table-lineage") return json({ message: "missing" }, 404);
    if (url.pathname === "/api/2.0/lineage-tracking/column-lineage") return json({ message: "missing" }, 404);
    if (url.pathname === "/api/2.0/sql/statements") {
      const body = await new Request(url, init).json() as { statement: string; parameters: Array<{ name: string; value: string }>; catalog?: string; query_tags?: unknown };
      statements.push(body);
      if (body.statement === TABLE_LINEAGE_SQL) {
        return json({
          statement_id: "lineage-stmt",
          status: { state: "SUCCEEDED" },
          manifest: { truncated: false },
          result: { data_array: [["upstream", "main.sales.raw_orders", "TABLE", "JOB", "99", "2026-01-01T00:00:00Z"], ["upstream", "s3://private/path", "PATH", "", "", ""]] },
        });
      }
      if (body.statement === COLUMN_LINEAGE_SQL) {
        return json({
          statement_id: "column-stmt",
          status: { state: "SUCCEEDED" },
          result: { data_array: [["downstream", "main.sales.daily", "amount", "JOB", "99"]] },
        });
      }
      if (body.statement === BILLING_COST_SQL) {
        return json({
          statement_id: "cost-stmt",
          status: { state: "FAILED", error: { error_code: "BAD_REQUEST", sql_state: "42501", message: "permission denied for secret-token" } },
        });
      }
      if (body.statement === BILLING_USAGE_SQL) {
        return json({
          statement_id: "usage-stmt",
          status: { state: "SUCCEEDED" },
          manifest: { truncated: true },
          result: { data_array: [["2026-04-01", "JOBS_SERVERLESS", "DBU", "1.5"]] },
        });
      }
      return json({ unexpected: body.statement }, 500);
    }
    if (url.pathname.includes("raw_orders")) return json({}, 403);
    if (url.pathname.startsWith("/api/2.1/unity-catalog/")) {
      return json({ privilege_assignments: [{ principal: "etl-agent", privileges: ["SELECT"] }] });
    }
    return json({}, 404);
  });
  const adapter = new DatabricksAdapter(client);
  const result = await adapter.execute({ kind: "uc_context", table: "main.sales.orders", column: "amount", job_id: "42" }) as {
    lineage: { available: boolean; source: string; window_days: number; upstreams: Array<{ table: string; entities?: Array<{ id: string }> }>; column: { source: string; downstreams: Array<{ column: string }> } };
    grants: Array<{ object: string; available: boolean }>;
    job_cost: { available: boolean; list_price_available: boolean; rows: Array<{ usage_quantity: string | null }>; truncated: boolean; statement_id: string };
  };

  assert.equal(result.lineage.available, true);
  assert.equal(result.lineage.source, "system.access");
  assert.equal(result.lineage.window_days, 30);
  assert.deepEqual(result.lineage.upstreams.map(node => node.table), ["main.sales.raw_orders"]);
  assert.equal(result.lineage.upstreams[0]?.entities?.[0]?.id, "99");
  assert.equal(result.lineage.column.source, "system.access");
  assert.equal(result.lineage.column.downstreams[0]?.column, "amount");
  assert.equal(result.grants.find(grant => grant.object === "main.sales.orders")?.available, true);
  assert.equal(result.grants.find(grant => grant.object === "main.sales.raw_orders")?.available, false);
  assert.equal(result.job_cost.available, true);
  assert.equal(result.job_cost.list_price_available, false);
  assert.equal(result.job_cost.rows[0]?.usage_quantity, "1.5");
  assert.equal(result.job_cost.truncated, true);
  assert.equal(result.job_cost.statement_id, "usage-stmt");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(JSON.stringify(result).includes("s3://"), false);

  const lineage = statements.find(body => body.statement === TABLE_LINEAGE_SQL);
  assert.equal(lineage?.parameters?.[0]?.value, "main.sales.orders");
  assert.equal(lineage?.statement?.includes("main.sales.orders"), false);
  assert.equal(lineage?.catalog, undefined);
  assert.deepEqual(statements.find(body => body.statement === BILLING_USAGE_SQL)?.parameters, [{ name: "job_id", value: "42", type: "STRING" }]);
  assert.equal(statements.some(body => body.statement?.includes("42")), false);
  assert.deepEqual(statements.find(body => body.statement === BILLING_COST_SQL)?.query_tags, [{ key: "etl_agent_tools", value: "job_cost" }]);
});

test("unfinished billing and non-inline results do not leak statement URLs or start a second query", async () => {
  const statements: string[] = [];
  const client = clientFor(async (url, init) => {
    if (url.pathname !== "/api/2.0/sql/statements") return json({ privilege_assignments: [] });
    const body = await new Request(url, init).json() as { statement: string };
    statements.push(body.statement);
    return json({
      statement_id: "pending-stmt",
      status: { state: "PENDING" },
      result: { external_links: [{ external_link: "https://storage.example/presigned?sig=super-secret-link" }] },
    });
  });
  const adapter = new DatabricksAdapter(client);
  const pending = await adapter.execute({ kind: "uc_context", table: "main.sales.orders", job_id: "7" }) as { job_cost: { reason: string; statement_id?: string } };
  assert.equal(pending.job_cost.reason, "query did not finish");
  assert.equal(pending.job_cost.statement_id, "pending-stmt");
  assert.equal(statements.length, 1);
  assert.equal(JSON.stringify(pending).includes("super-secret-link"), false);

  const inlineClient = clientFor(async (url, init) => {
    if (url.pathname !== "/api/2.0/sql/statements") return json({ privilege_assignments: [] });
    const body = await new Request(url, init).json() as { statement: string };
    if (body.statement !== BILLING_COST_SQL) return json({ status: { state: "FAILED" } }, 500);
    return json({
      statement_id: "inline-stmt",
      status: { state: "SUCCEEDED" },
      result: { external_links: [{ external_link: "https://storage.example/presigned?sig=super-secret-link" }] },
    });
  });
  const inline = await new DatabricksAdapter(inlineClient).execute({ kind: "uc_context", table: "main.sales.orders", job_id: "7" }) as { job_cost: { reason: string } };
  assert.equal(inline.job_cost.reason, "result was not returned inline");
  assert.equal(JSON.stringify(inline).includes("super-secret-link"), false);
});

test("unsafe table and job identifiers are rejected before any request", async () => {
  let calls = 0;
  const client = clientFor(() => {
    calls += 1;
    return json({});
  });
  const adapter = new DatabricksAdapter(client);
  await assert.rejects(adapter.execute({ kind: "uc_context", table: "main.sales.orders; drop table orders" }), /catalog\.schema\.table/);
  await assert.rejects(adapter.execute({ kind: "uc_context", table: "main.sales.orders", column: "amount;drop" }), /column/);
  await assert.rejects(adapter.execute({ kind: "uc_context", table: "main.sales.orders", job_id: "1 OR 1=1" }), /positive safe integer/);
  assert.equal(calls, 0);
  assert.equal(adapter.capabilities().operations.some(operation => operation.name === "uc_context" && operation.operationClass === "read"), true);
});
