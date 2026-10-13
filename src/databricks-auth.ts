import { scrubSecrets } from "./core.js";

export type DatabricksAuthMode = "pat" | "oauth-m2m";

export type ResolvedDatabricksAuth = {
  auth: DatabricksAuthMode;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  oauthScope?: string;
};

export interface AccessTokenSource {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  secrets(): readonly string[];
  invalidate(): void;
}

const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function assertSingleLine(value: string, name: string): void {
  if (/\s/.test(value)) throw new Error(`${name} must be a single-line value without whitespace.`);
}

function oauthScope(env: NodeJS.ProcessEnv): string {
  const scope = present(env.DATABRICKS_OAUTH_SCOPE) ?? "all-apis";
  if (scope.length > 512 || !SCOPE.test(scope)) {
    throw new Error("DATABRICKS_OAUTH_SCOPE must be a comma-separated list of scope names such as all-apis.");
  }
  return scope;
}

export function resolveDatabricksAuth(env: NodeJS.ProcessEnv): ResolvedDatabricksAuth {
  const requested = present(env.DATABRICKS_AUTH)?.toLowerCase();
  if (requested && requested !== "pat" && requested !== "oauth-m2m") {
    throw new Error("DATABRICKS_AUTH must be pat or oauth-m2m.");
  }
  const token = present(env.DATABRICKS_TOKEN);
  const clientId = present(env.DATABRICKS_CLIENT_ID);
  const clientSecret = present(env.DATABRICKS_CLIENT_SECRET);
  const hasPat = Boolean(token);
  const hasPartialOauth = Boolean(clientId) !== Boolean(clientSecret);
  if (hasPartialOauth) {
    throw new Error("OAuth machine-to-machine authentication requires both DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET.");
  }
  const hasOauth = Boolean(clientId && clientSecret);
  if (requested === "pat") {
    if (!token || hasOauth) throw new Error("DATABRICKS_AUTH=pat requires DATABRICKS_TOKEN and no DATABRICKS_CLIENT_ID or DATABRICKS_CLIENT_SECRET.");
    assertSingleLine(token, "DATABRICKS_TOKEN");
    return { auth: "pat", token };
  }
  if (requested === "oauth-m2m") {
    if (!clientId || !clientSecret || hasPat) {
      throw new Error("DATABRICKS_AUTH=oauth-m2m requires DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET and no DATABRICKS_TOKEN.");
    }
    assertSingleLine(clientId, "DATABRICKS_CLIENT_ID");
    assertSingleLine(clientSecret, "DATABRICKS_CLIENT_SECRET");
    return { auth: "oauth-m2m", clientId, clientSecret, oauthScope: oauthScope(env) };
  }
  if (hasPat && hasOauth) {
    throw new Error("Databricks credentials are ambiguous. Set DATABRICKS_AUTH to pat or oauth-m2m and unset the other credential family.");
  }
  if (token) {
    assertSingleLine(token, "DATABRICKS_TOKEN");
    return { auth: "pat", token };
  }
  if (clientId && clientSecret) {
    assertSingleLine(clientId, "DATABRICKS_CLIENT_ID");
    assertSingleLine(clientSecret, "DATABRICKS_CLIENT_SECRET");
    return { auth: "oauth-m2m", clientId, clientSecret, oauthScope: oauthScope(env) };
  }
  throw new Error("Set DATABRICKS_HOST and either DATABRICKS_TOKEN or both DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET before launching the harness.");
}

export function credentialSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.DATABRICKS_TOKEN, env.DATABRICKS_CLIENT_SECRET].filter((value): value is string => Boolean(value && value.trim().length >= 4));
}

export class PatTokenSource implements AccessTokenSource {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> { return this.token; }
  secrets(): readonly string[] { return [this.token]; }
  invalidate(): void {}
}

type CachedToken = { accessToken: string; expiresAtMs: number; skewMs: number };

export class OAuthM2MTokenSource implements AccessTokenSource {
  private cached?: CachedToken;
  private inflight?: Promise<string>;
  private generation = 0;
  private refreshBudget = 1;
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  private readonly transport: typeof fetch;

  constructor(private readonly options: {
    host: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    transport?: typeof fetch;
    now?: () => number;
    refreshSkewMs?: number;
  }) {
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  secrets(): readonly string[] {
    return [this.options.clientSecret, this.cached?.accessToken].filter((value): value is string => Boolean(value));
  }

  invalidate(): void {
    if (this.refreshBudget <= 0) return;
    this.refreshBudget -= 1;
    this.generation += 1;
    this.cached = undefined;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const cached = this.cached;
    if (cached && this.now() + cached.skewMs < cached.expiresAtMs) return cached.accessToken;
    if (!this.inflight) {
      const generation = this.generation;
      this.inflight = this.fetchToken(signal, generation).finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  private async fetchToken(signal: AbortSignal | undefined, generation: number): Promise<string> {
    const url = new URL("/oidc/v1/token", this.options.host);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: this.options.scope }).toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Databricks OAuth token request failed. Requests are not automatically retried.");
    }
    if (!response.ok) {
      throw new Error(`Databricks OAuth token request failed with HTTP ${response.status}. Requests are not automatically retried.`);
    }
    const raw = await response.text();
    const redacted = scrubSecrets(raw, [this.options.clientSecret]);
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(redacted) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new Error("Databricks OAuth token response could not be read. Requests are not automatically retried.");
    }
    const accessToken = parsed.access_token;
    const expiresIn = Number(parsed.expires_in);
    if (typeof accessToken !== "string" || accessToken.length < 1 || /\s/.test(accessToken) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Databricks OAuth token response was missing an access token or expiry. Requests are not automatically retried.");
    }
    const lifetimeMs = expiresIn * 1000;
    const skewMs = Math.min(this.refreshSkewMs, lifetimeMs / 2);
    if (generation === this.generation) this.cached = { accessToken, expiresAtMs: this.now() + lifetimeMs, skewMs };
    return accessToken;
  }
}

export function createAccessTokenSource(config: { host: string; auth?: DatabricksAuthMode; token?: string; clientId?: string; clientSecret?: string; oauthScope?: string }, transport: typeof fetch = fetch): AccessTokenSource {
  const auth = config.auth ?? (config.token ? "pat" : "oauth-m2m");
  if (auth === "oauth-m2m") {
    if (!config.clientId || !config.clientSecret) throw new Error("OAuth machine-to-machine authentication requires a client ID and secret.");
    return new OAuthM2MTokenSource({
      host: config.host,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.oauthScope ?? "all-apis",
      transport,
    });
  }
  if (!config.token) throw new Error("Personal access token authentication requires DATABRICKS_TOKEN.");
  return new PatTokenSource(config.token);
}
