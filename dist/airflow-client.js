import { scrubSecrets } from "./redact.js";
const JSON_BODY_LIMIT = 1_000_000;
const LOG_BODY_LIMIT = 5_000_000;
const LOG_TAIL_BYTES = 64_000;
export function airflowConfigFromEnv(env = process.env) {
    if (!env.AIRFLOW_BASE_URL?.trim())
        throw new Error("Set AIRFLOW_BASE_URL before reading Airflow.");
    let url;
    try {
        url = new URL(env.AIRFLOW_BASE_URL.trim());
    }
    catch {
        throw new Error("AIRFLOW_BASE_URL must be an origin.");
    }
    const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) {
        throw new Error("AIRFLOW_BASE_URL must be an HTTPS origin, or HTTP on localhost.");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("AIRFLOW_BASE_URL must be an origin without a path or credentials.");
    }
    if (env.AIRFLOW_API_VERSION !== "v1" && env.AIRFLOW_API_VERSION !== "v2") {
        throw new Error("Set AIRFLOW_API_VERSION to v1 for Airflow 2 or v2 for Airflow 3.");
    }
    const authMode = env.AIRFLOW_AUTH_MODE?.trim() || "bearer";
    if (authMode === "aws-mwaa" || authMode === "google-iap") {
        throw new Error(`${authMode} authentication is not available in this read-only release. Use bearer or basic.`);
    }
    if (authMode !== "bearer" && authMode !== "basic")
        throw new Error("AIRFLOW_AUTH_MODE must be bearer or basic.");
    if (authMode === "bearer" && !env.AIRFLOW_TOKEN?.trim())
        throw new Error("Set AIRFLOW_TOKEN for bearer authentication.");
    if (authMode === "basic" && (!env.AIRFLOW_USERNAME?.trim() || !env.AIRFLOW_PASSWORD)) {
        throw new Error("Set AIRFLOW_USERNAME and AIRFLOW_PASSWORD for basic authentication.");
    }
    return {
        baseUrl: url.origin,
        apiVersion: env.AIRFLOW_API_VERSION,
        authMode,
        token: env.AIRFLOW_TOKEN,
        username: env.AIRFLOW_USERNAME,
        password: env.AIRFLOW_PASSWORD,
        environment: env.AIRFLOW_ENVIRONMENT?.trim() || undefined,
    };
}
export function describeAirflow(env = process.env) {
    try {
        const config = airflowConfigFromEnv(env);
        return { configured: true, apiVersion: config.apiVersion, authMode: config.authMode };
    }
    catch {
        return { configured: false, apiVersion: null, authMode: null };
    }
}
export function airflowWorkspaceLabel(config) {
    const label = config.environment?.trim();
    if (!label || /[\r\n]/.test(label) || label.length > 40)
        return config.baseUrl;
    return `${config.baseUrl} (${label})`;
}
export class AirflowClient {
    config;
    transport;
    constructor(config, transport = fetch) {
        this.config = config;
        this.transport = transport;
    }
    secrets() {
        return [this.config.token, this.config.password, this.config.username].filter((value) => Boolean(value));
    }
    async request(segments, query = {}, signal, mode = "json") {
        if (!segments.length || segments.some(segment => !segment || segment.includes("/") || segment === "." || segment === "..")) {
            throw new Error("Airflow request path is invalid.");
        }
        const url = new URL(this.config.baseUrl);
        url.pathname = `/api/${this.config.apiVersion}`;
        for (const segment of segments)
            url.pathname = `${url.pathname}/${encodeURIComponent(segment)}`;
        for (const [key, value] of Object.entries(query))
            if (value !== undefined)
                url.searchParams.set(key, String(value));
        const headers = { Accept: "application/json" };
        if (this.config.authMode === "bearer")
            headers.Authorization = `Bearer ${this.config.token}`;
        else
            headers.Authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`;
        let response;
        try {
            response = await this.transport(url, {
                method: "GET",
                redirect: "error",
                headers,
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
            });
        }
        catch {
            throw new Error("Airflow request interrupted or failed. No mutation was submitted.");
        }
        if (!response.ok) {
            try {
                await response.body?.cancel();
            }
            catch { /* The status is the evidence. The body is discarded. */ }
            // Do not echo error bodies: they can contain credentials or source data.
            throw new Error(`Airflow HTTP ${response.status}. Check the deployment, permissions, and request parameters. Requests are not automatically retried.`);
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        const hardLimit = mode === "log" ? LOG_BODY_LIMIT : JSON_BODY_LIMIT;
        if (Number.isFinite(declared) && declared > hardLimit) {
            try {
                await response.body?.cancel();
            }
            catch { /* ignore */ }
            throw new Error("Airflow response exceeded the read limit. Narrow the request or follow pagination.");
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > hardLimit) {
            throw new Error("Airflow response exceeded the read limit. Narrow the request or follow pagination.");
        }
        const keepTail = mode === "log" && buffer.byteLength > LOG_TAIL_BYTES;
        const text = (keepTail ? buffer.subarray(buffer.byteLength - LOG_TAIL_BYTES) : buffer).toString("utf8");
        const scrubbed = scrubSecrets(text, this.secrets());
        if (!scrubbed)
            return {};
        const contentType = response.headers.get("content-type") ?? "";
        const looksJson = !keepTail && (contentType.includes("json") || /^[\s]*[[{]/.test(scrubbed));
        if (!looksJson)
            return { content: scrubbed, truncated: keepTail };
        try {
            return JSON.parse(scrubbed);
        }
        catch {
            return { content: scrubbed, truncated: keepTail };
        }
    }
}
