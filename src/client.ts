export type Config = {
  host: string; token: string; warehouse?: string; catalog?: string; schema?: string;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABRICKS_HOST || !env.DATABRICKS_TOKEN) {
    throw new Error("Set DATABRICKS_HOST and DATABRICKS_TOKEN before launching Pi.");
  }
  const url = new URL(env.DATABRICKS_HOST);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("DATABRICKS_HOST must be an HTTPS workspace origin without a path or credentials.");
  }
  return { host: url.origin, token: env.DATABRICKS_TOKEN, warehouse: env.DATABRICKS_WAREHOUSE_ID,
    catalog: env.DATABRICKS_CATALOG, schema: env.DATABRICKS_SCHEMA };
}

export class DatabricksClient {
  constructor(readonly config: Config, private readonly transport: typeof fetch = fetch) {}

  async request(path: string, query: Record<string, string | number | undefined> = {}, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(this.config.host);
    url.pathname = path;
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.transport(url, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Databricks request interrupted or failed. Submission may have reached the server; inspect remote state before retrying.");
    }
    if (!response.ok) throw new Error(`Databricks HTTP ${response.status}. Check workspace, permissions and request parameters. Requests are not automatically retried.`);
    // Do not echo error bodies: they can contain credentials or source data.
    const raw = await response.text();
    if (!raw) return {};
    return JSON.parse(raw.split(this.config.token).join("[REDACTED]"));
  }
}

export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}

export function numericId(value: string | undefined, name: string): number {
  const text = required(value, name);
  const id = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id < 1) throw new Error(`${name} must be a positive safe integer.`);
  return id;
}

export function result(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  const truncated = text.length > 24_000;
  return { content: [{ type: "text" as const, text: truncated ? text.slice(0, 24_000) + "\n[Output truncated; narrow the request or use pagination.]" : text }],
    details: { truncated } };
}
