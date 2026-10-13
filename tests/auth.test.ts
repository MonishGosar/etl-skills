import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromEnv, DatabricksClient, databricksConfigured } from "../src/client.ts";
import { OAuthM2MTokenSource } from "../src/databricks-auth.ts";

const host = "https://example.com";

test("oauth machine-to-machine config is selected when only client credentials are set", () => {
  assert.deepEqual(configFromEnv({
    DATABRICKS_HOST: host,
    DATABRICKS_CLIENT_ID: "client-id",
    DATABRICKS_CLIENT_SECRET: "client-secret-value",
    DATABRICKS_OAUTH_SCOPE: "sql,unity-catalog",
    DATABRICKS_WAREHOUSE_ID: "warehouse-1",
  }), {
    host,
    auth: "oauth-m2m",
    clientId: "client-id",
    clientSecret: "client-secret-value",
    oauthScope: "sql,unity-catalog",
    warehouse: "warehouse-1",
    catalog: undefined,
    schema: undefined,
  });
  assert.equal(databricksConfigured({ DATABRICKS_HOST: host, DATABRICKS_CLIENT_ID: "client-id", DATABRICKS_CLIENT_SECRET: "client-secret-value" }), true);
  assert.equal(databricksConfigured({ DATABRICKS_HOST: host }), false);
});

test("mixed Databricks credentials are rejected without echoing secrets", () => {
  assert.throws(() => configFromEnv({
    DATABRICKS_HOST: host,
    DATABRICKS_TOKEN: "pat-secret-value",
    DATABRICKS_CLIENT_ID: "client-id",
    DATABRICKS_CLIENT_SECRET: "oauth-secret-value",
  }), (error: Error) => {
    assert.match(error.message, /ambiguous/);
    assert.equal(error.message.includes("pat-secret-value"), false);
    assert.equal(error.message.includes("oauth-secret-value"), false);
    return true;
  });
  assert.throws(() => configFromEnv({
    DATABRICKS_HOST: host,
    DATABRICKS_AUTH: "oauth-m2m",
    DATABRICKS_TOKEN: "pat-secret-value",
    DATABRICKS_CLIENT_ID: "client-id",
    DATABRICKS_CLIENT_SECRET: "oauth-secret-value",
  }), /no DATABRICKS_TOKEN/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: host, DATABRICKS_AUTH: "pat", DATABRICKS_CLIENT_ID: "client-id", DATABRICKS_CLIENT_SECRET: "oauth-secret-value" }), /DATABRICKS_TOKEN/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: host, DATABRICKS_CLIENT_ID: "client-id" }), /both DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: host, DATABRICKS_AUTH: "bearer", DATABRICKS_TOKEN: "pat-secret-value" }), /pat or oauth-m2m/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: host, DATABRICKS_CLIENT_ID: "client-id", DATABRICKS_CLIENT_SECRET: "oauth-secret-value", DATABRICKS_OAUTH_SCOPE: "all apis" }), /DATABRICKS_OAUTH_SCOPE/);
  assert.throws(() => configFromEnv({ DATABRICKS_HOST: host, DATABRICKS_TOKEN: "token with space" }), /single-line/);
});

test("oauth token fetch uses basic auth, caches, and refreshes before expiry", async () => {
  let now = 1_000_000;
  let tokenCalls = 0;
  const seen: Array<{ authorization: string | null; body: string; url: string }> = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    tokenCalls += 1;
    seen.push({ authorization: request.headers.get("authorization"), body: await request.text(), url: request.url });
    const accessToken = tokenCalls === 1 ? "access-token-one" : "access-token-two";
    return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600, token_type: "Bearer", echo: "client-secret-value" }), { status: 200 });
  };
  const source = new OAuthM2MTokenSource({
    host, clientId: "client-id", clientSecret: "client-secret-value", scope: "all-apis", transport, now: () => now,
  });

  assert.equal(await source.getAccessToken(), "access-token-one");
  assert.equal(await source.getAccessToken(), "access-token-one");
  assert.equal(tokenCalls, 1);
  assert.equal(seen[0]?.url, "https://example.com/oidc/v1/token");
  assert.equal(seen[0]?.authorization, `Basic ${Buffer.from("client-id:client-secret-value").toString("base64")}`);
  assert.equal(seen[0]?.body, "grant_type=client_credentials&scope=all-apis");
  assert.equal(seen[0]?.body.includes("client-secret-value"), false);
  assert.equal(seen[0]?.url.includes("client-secret-value"), false);

  now = 4_540_000;
  assert.equal(await source.getAccessToken(), "access-token-two");
  assert.equal(tokenCalls, 2);
});

test("concurrent oauth token requests share one fetch", async () => {
  let tokenCalls = 0;
  let release: (response: Response) => void = () => {};
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const source = new OAuthM2MTokenSource({
    host, clientId: "client-id", clientSecret: "client-secret-value", scope: "all-apis",
    transport: async () => {
      tokenCalls += 1;
      return gate;
    },
  });
  const first = source.getAccessToken();
  const second = source.getAccessToken();
  release(new Response(JSON.stringify({ access_token: "access-token-value", expires_in: 3600 }), { status: 200 }));
  assert.equal(await first, "access-token-value");
  assert.equal(await second, "access-token-value");
  assert.equal(tokenCalls, 1);
});

test("oauth errors and API payloads redact the client secret and access token", async () => {
  const source = new OAuthM2MTokenSource({
    host, clientId: "client-id", clientSecret: "client-secret-value", scope: "all-apis",
    transport: async () => new Response("client-secret-value", { status: 401 }),
  });
  await assert.rejects(source.getAccessToken(), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes("client-secret-value"), false);
    return true;
  });

  let now = 1_000_000;
  let tokenCalls = 0;
  let apiCalls = 0;
  const authorizations: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oidc/v1/token") {
      tokenCalls += 1;
      const accessToken = tokenCalls === 1 ? "access-token-one" : "access-token-two";
      return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), { status: 200 });
    }
    apiCalls += 1;
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (apiCalls < 3) return new Response(JSON.stringify({ leak: "client-secret-value" }), { status: 401 });
    return new Response(JSON.stringify({ leak: "client-secret-value", access: "access-token-two" }), { status: 200 });
  };
  const refreshing = new OAuthM2MTokenSource({
    host, clientId: "client-id", clientSecret: "client-secret-value", scope: "all-apis", transport, now: () => now,
  });
  const client = new DatabricksClient({
    host, auth: "oauth-m2m", clientId: "client-id", clientSecret: "client-secret-value", oauthScope: "all-apis",
  }, transport, refreshing);

  await assert.rejects(client.request("/api/2.0/jobs/list"), /HTTP 401/);
  await assert.rejects(client.request("/api/2.0/jobs/list"), /HTTP 401/);
  const payload = await client.request("/api/2.0/jobs/list");
  assert.deepEqual(payload, { leak: "[REDACTED]", access: "[REDACTED]" });
  assert.equal(tokenCalls, 2);
  assert.deepEqual(authorizations, ["Bearer access-token-one", "Bearer access-token-two", "Bearer access-token-two"]);
  assert.equal(JSON.stringify(payload).includes("client-secret-value"), false);
});
