import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromEnv, DatabricksClient, numericId, workspaceLabelFromEnv } from "../src/client.ts";
import { scrubSecrets, toolError } from "../src/core.ts";

test("config requires a secure workspace origin and token", () => {
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: "http://example.com", DATABRICKS_TOKEN: "x" }), /HTTPS/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: "https://example.com/api", DATABRICKS_TOKEN: "x" }), /origin/);
  assert.deepEqual(configFromEnv({ DATABRICKS_HOST: "https://example.com", DATABRICKS_TOKEN: "secret", DATABRICKS_WAREHOUSE_ID: "w", DATABRICKS_CATALOG: " " }), {
    host: "https://example.com", auth: "pat", token: "secret", warehouse: "w", catalog: undefined, schema: undefined,
  });
});

test("workspace labels never echo malformed host credentials", () => {
  assert.equal(workspaceLabelFromEnv({}), "unconfigured");
  assert.equal(workspaceLabelFromEnv({ DATABRICKS_HOST: "https://example.com" }), "https://example.com");
  assert.equal(workspaceLabelFromEnv({ DATABRICKS_HOST: "https://user:secret@example.com/path" }), "invalid-configuration");
});

test("IDs are positive safe integers", () => {
  assert.equal(numericId("42", "run_id"), 42);
  for (const input of ["", "0", "-1", "1.2", "9007199254740992"]) assert.throws(() => numericId(input, "run_id"));
});

test("client sends bearer requests and redacts token in JSON", async () => {
  let seen: Request | undefined;
  const client = new DatabricksClient({ host: "https://example.com", token: "secret" }, async (input, init) => {
    seen = new Request(input, init);
    return new Response(JSON.stringify({ value: "secret", ok: true }), { status: 200 });
  });
  const payload = await client.request("/api/test", { page: 2 });
  assert.equal(seen?.url, "https://example.com/api/test?page=2");
  assert.equal(seen?.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(payload, { value: "[REDACTED]", ok: true });
});

test("tool errors scrub credential values and ignore short strings", () => {
  assert.equal(scrubSecrets("prefix secret-value suffix", ["ab", "secret-value"]), "prefix [REDACTED] suffix");
  const result = toolError(new Error("failed with secret-value"), ["secret-value"]);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text.includes("secret-value"), false);
  assert.match(result.content[0].text, /\[REDACTED\]/);
});

test("client does not expose error response bodies", async () => {
  const client = new DatabricksClient({ host: "https://example.com", token: "secret" }, async () => new Response("password=secret", { status: 500 }));
  await assert.rejects(client.request("/api/test"), /Databricks HTTP 500/);
});
