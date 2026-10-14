import { scrubSecrets } from "./core.js";
import { createAccessTokenSource, resolveDatabricksAuth } from "./databricks-auth.js";
export { credentialSecretsFromEnv, OAuthM2MTokenSource, resolveDatabricksAuth } from "./databricks-auth.js";
function optionalValue(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function requireWorkspaceHost(value) {
    if (!value?.trim()) {
        throw new Error("Set DATABRICKS_HOST and either DATABRICKS_TOKEN or both DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET before launching the harness.");
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("DATABRICKS_HOST must be an HTTPS workspace origin without a path or credentials.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("DATABRICKS_HOST must be an HTTPS workspace origin without a path or credentials.");
    }
    return url.origin;
}
export function configFromEnv(env = process.env) {
    const host = requireWorkspaceHost(env.DATABRICKS_HOST);
    const auth = resolveDatabricksAuth(env);
    return {
        host,
        auth: auth.auth,
        ...(auth.auth === "pat"
            ? { token: auth.token }
            : { clientId: auth.clientId, clientSecret: auth.clientSecret, oauthScope: auth.oauthScope }),
        warehouse: optionalValue(env.DATABRICKS_WAREHOUSE_ID),
        catalog: optionalValue(env.DATABRICKS_CATALOG),
        schema: optionalValue(env.DATABRICKS_SCHEMA),
    };
}
export function databricksConfigured(env = process.env) {
    try {
        configFromEnv(env);
        return true;
    }
    catch {
        return false;
    }
}
export function workspaceLabelFromEnv(env = process.env) {
    if (!env.DATABRICKS_HOST)
        return "unconfigured";
    try {
        return requireWorkspaceHost(env.DATABRICKS_HOST);
    }
    catch {
        return "invalid-configuration";
    }
}
export class DatabricksHttpError extends Error {
    status;
    constructor(status) {
        super(`Databricks HTTP ${status}. Check workspace, permissions and request parameters. Requests are not automatically retried.`);
        this.name = "DatabricksHttpError";
        this.status = status;
    }
}
export class DatabricksClient {
    config;
    transport;
    tokenSource;
    constructor(config, transport = fetch, tokenSource) {
        this.config = config;
        this.transport = transport;
        this.tokenSource = tokenSource ?? createAccessTokenSource(config, transport);
    }
    async request(path, query = {}, body, signal) {
        const token = await this.tokenSource.getAccessToken(signal);
        const url = new URL(this.config.host);
        url.pathname = path;
        for (const [key, value] of Object.entries(query))
            if (value !== undefined)
                url.searchParams.set(key, String(value));
        let response;
        try {
            response = await this.transport(url, {
                method: body === undefined ? "GET" : "POST", redirect: "error",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
            });
        }
        catch {
            throw new Error("Databricks request interrupted or failed. Submission may have reached the server; inspect remote state before retrying.");
        }
        if (!response.ok) {
            if (response.status === 401)
                this.tokenSource.invalidate();
            throw new DatabricksHttpError(response.status);
        }
        const raw = await response.text();
        if (!raw)
            return {};
        const redacted = scrubSecrets(raw, [token, ...this.tokenSource.secrets()]);
        try {
            return JSON.parse(redacted);
        }
        catch {
            throw new Error("Databricks response could not be read. Requests are not automatically retried.");
        }
    }
}
export function required(value, name) {
    if (!value?.trim())
        throw new Error(`${name} is required.`);
    return value;
}
export function numericId(value, name) {
    const text = required(value, name);
    const id = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id < 1)
        throw new Error(`${name} must be a positive safe integer.`);
    return id;
}
