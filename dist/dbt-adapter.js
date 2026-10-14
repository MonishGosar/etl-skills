import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { secretsFromEnv } from "./redact.js";
import { ADDITIONAL_FAILURE_LIMIT, asRecord, capRefs, classifyFailure, failureExcerpt, stringField, stringList, suggestedNextStep, } from "./diagnosis.js";
const ARTIFACT_NAMES = new Set(["run_results.json", "manifest.json", "dbt.log"]);
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const FAILING_STATUSES = new Set(["error", "fail"]);
export function dbtConfigured(env = process.env) {
    return Boolean(env.DBT_ARTIFACTS_DIR?.trim() || env.DBT_PROJECT_DIR?.trim());
}
export function resolveDbtArtifactsDir(env, override) {
    const selected = override?.trim() || env.DBT_ARTIFACTS_DIR?.trim() || (env.DBT_PROJECT_DIR?.trim() ? resolve(env.DBT_PROJECT_DIR.trim(), "target") : "");
    if (!selected)
        throw new Error("Pass artifacts_dir or set DBT_ARTIFACTS_DIR or DBT_PROJECT_DIR.");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(selected))
        throw new Error("dbt artifacts must be a local directory path.");
    return resolve(selected);
}
export function parseDbtInvocation(value) {
    const root = asRecord(value);
    if (!root || !Array.isArray(root.results)) {
        throw new Error("run_results.json has no results array. The file contents were not returned.");
    }
    const metadata = asRecord(root.metadata);
    const results = [];
    for (const entry of root.results) {
        const record = asRecord(entry);
        if (!record)
            continue;
        const uniqueId = stringField(record, "unique_id");
        if (!uniqueId)
            continue;
        results.push({
            uniqueId,
            status: (stringField(record, "status") ?? "unknown").toLowerCase(),
            message: typeof record.message === "string" ? record.message : "",
        });
    }
    return {
        invocationId: metadata ? stringField(metadata, "invocation_id") : undefined,
        generatedAt: metadata ? stringField(metadata, "generated_at") : undefined,
        elapsedTime: typeof root.elapsed_time === "number" ? root.elapsed_time : undefined,
        results,
    };
}
export function parseDbtManifest(value) {
    const nodes = new Map();
    const parents = new Map();
    const children = new Map();
    const root = asRecord(value);
    if (!root)
        return { present: false, nodes, parents, children };
    const collect = (bucket) => {
        const records = asRecord(bucket);
        if (!records)
            return;
        for (const [uniqueId, raw] of Object.entries(records)) {
            const node = asRecord(raw);
            if (!node)
                continue;
            const sourceName = stringField(node, "source_name");
            const name = stringField(node, "name") ?? uniqueId.split(".").at(-1) ?? uniqueId;
            nodes.set(uniqueId, {
                name: sourceName ? `${sourceName}.${name}` : name,
                resourceType: stringField(node, "resource_type"),
                path: stringField(node, "original_file_path") ?? stringField(node, "path"),
            });
            const depends = asRecord(node.depends_on);
            if (depends)
                parents.set(uniqueId, stringList(depends.nodes));
        }
    };
    collect(root.nodes);
    collect(root.sources);
    const parentMap = asRecord(root.parent_map);
    if (parentMap) {
        for (const [uniqueId, raw] of Object.entries(parentMap))
            parents.set(uniqueId, stringList(raw));
    }
    const childMap = asRecord(root.child_map);
    if (childMap) {
        for (const [uniqueId, raw] of Object.entries(childMap))
            children.set(uniqueId, stringList(raw));
    }
    else {
        for (const [uniqueId, upstream] of parents) {
            for (const parent of upstream) {
                const current = children.get(parent) ?? [];
                current.push(uniqueId);
                children.set(parent, current);
            }
        }
    }
    return { present: true, nodes, parents, children };
}
function displayName(graph, uniqueId) {
    return graph.nodes.get(uniqueId)?.name ?? uniqueId.split(".").at(-1) ?? uniqueId;
}
function refsFor(ids, graph, statusById) {
    return ids.map(id => ({
        id,
        name: displayName(graph, id),
        ...(statusById.has(id) ? { status: statusById.get(id) } : {}),
    }));
}
export function diagnoseDbtInvocation(input) {
    const secrets = input.secrets ?? [];
    const statusById = new Map(input.invocation.results.map(result => [result.uniqueId, result.status]));
    const evidence = [{
            source: "run_results.json",
            observation: input.invocation.invocationId
                ? `Invocation ${input.invocation.invocationId} contains ${input.invocation.results.length} results.`
                : `run_results.json contains ${input.invocation.results.length} results.`,
        }];
    if (input.invocation.generatedAt)
        evidence.push({ source: "run_results.json", observation: `Artifacts generated at ${input.invocation.generatedAt}.` });
    if (input.manifestNote)
        evidence.push({ source: "manifest.json", observation: input.manifestNote });
    else if (!input.graph.present)
        evidence.push({ source: "manifest.json", observation: "manifest.json was not available. Upstream and downstream impact is unknown." });
    else
        evidence.push({ source: "manifest.json", observation: "Upstream and downstream ids come from the manifest parent and child maps." });
    const failed = input.invocation.results.filter(result => FAILING_STATUSES.has(result.status));
    if (!failed.length) {
        return {
            provider: "dbt",
            outcome: "no_failure",
            failed: null,
            additionalFailures: [],
            errorExcerpt: "",
            impact: { upstream: [], downstream: [], truncated: false },
            likelyCause: {
                category: "unknown",
                summary: "No node finished with status error or fail.",
                confidence: "high",
            },
            suggestedNextStep: "No failure to diagnose. Confirm this artifacts directory is from the invocation you care about.",
            evidence,
        };
    }
    const primary = failed[0];
    const node = input.graph.nodes.get(primary.uniqueId);
    const excerpt = failureExcerpt(primary.message, input.log, secrets);
    if (input.logTruncated || excerpt.truncated) {
        evidence.push({ source: "dbt.log", observation: "The error excerpt is capped. The rest of the log was not returned." });
    }
    else if (excerpt.logUsed) {
        evidence.push({ source: "dbt.log", observation: "A bounded excerpt from dbt.log was included with the run_results message." });
    }
    else {
        evidence.push({ source: "dbt.log", observation: input.log ? "dbt.log did not add a separate error beyond run_results.json." : "dbt.log was not read." });
    }
    const cause = classifyFailure({ message: excerpt.excerpt, status: primary.status, resourceType: node?.resourceType });
    const upstream = capRefs(refsFor(input.graph.parents.get(primary.uniqueId) ?? [], input.graph, statusById));
    const downstream = capRefs(refsFor(input.graph.children.get(primary.uniqueId) ?? [], input.graph, statusById));
    const additional = failed.slice(1, 1 + ADDITIONAL_FAILURE_LIMIT).map(result => ({
        id: result.uniqueId,
        name: displayName(input.graph, result.uniqueId),
        status: result.status,
    }));
    if (failed.length > 1) {
        evidence.push({
            source: "run_results.json",
            observation: `${failed.length} nodes failed. The brief uses the first error or fail result as the primary node.`,
        });
    }
    evidence.push({
        source: "run_results.json",
        observation: `${primary.uniqueId} finished with status ${primary.status}.`,
    });
    return {
        provider: "dbt",
        outcome: "failed",
        failed: {
            kind: "node",
            id: primary.uniqueId,
            name: displayName(input.graph, primary.uniqueId),
            status: primary.status,
            ...(node?.path ? { location: node.path } : {}),
        },
        additionalFailures: additional,
        errorExcerpt: excerpt.excerpt,
        impact: {
            upstream: upstream.refs,
            downstream: downstream.refs,
            truncated: upstream.truncated || downstream.truncated || failed.length > additional.length + 1,
        },
        likelyCause: cause,
        suggestedNextStep: suggestedNextStep(cause.category),
        evidence,
    };
}
async function directoryRealPath(directory) {
    try {
        const root = await realpath(directory);
        const info = await stat(root);
        if (!info.isDirectory())
            throw new Error("dbt artifacts path must be a directory containing run_results.json.");
        return root;
    }
    catch (error) {
        if (error instanceof Error && /must be a directory/.test(error.message))
            throw error;
        const code = error.code;
        if (code === "ENOENT")
            throw new Error("dbt artifacts directory was not found.");
        throw new Error("dbt artifacts directory could not be read.");
    }
}
function insideRoot(root, candidate) {
    const rel = relative(root, candidate);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
async function artifactPath(root, filename) {
    if (!ARTIFACT_NAMES.has(filename))
        throw new Error("Unsupported dbt artifact name.");
    const candidate = resolve(root, filename);
    try {
        const fileReal = await realpath(candidate);
        if (!insideRoot(root, fileReal))
            throw new Error(`${filename} resolves outside the artifacts directory.`);
        return fileReal;
    }
    catch (error) {
        if (error instanceof Error && /outside/.test(error.message))
            throw error;
        if (error.code === "ENOENT")
            return undefined;
        throw new Error(`${filename} could not be read.`);
    }
}
async function readJsonArtifact(path, filename) {
    const info = await stat(path);
    if (!info.isFile())
        throw new Error(`${filename} is not a file.`);
    if (info.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`${filename} exceeds the 20MB read limit. The file contents were not returned.`);
    }
    const raw = await readFile(path, "utf8");
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`${filename} is not valid JSON. The file contents were not returned.`);
    }
}
async function readTail(path, maxBytes) {
    const handle = await open(path, "r");
    try {
        const info = await handle.stat();
        if (!info.isFile())
            throw new Error("dbt log path is not a file.");
        const length = Math.min(info.size, maxBytes);
        const start = Math.max(0, info.size - length);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return { text: buffer.toString("utf8"), truncated: info.size > maxBytes };
    }
    finally {
        await handle.close();
    }
}
async function configuredLog(env, root) {
    const explicit = env.DBT_LOG_PATH?.trim();
    if (explicit) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(explicit))
            throw new Error("DBT_LOG_PATH must be a local file path.");
        try {
            return await readTail(await realpath(resolve(explicit)), MAX_LOG_BYTES);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw new Error("DBT_LOG_PATH could not be read.");
        }
    }
    const local = await artifactPath(root, "dbt.log");
    if (local)
        return readTail(local, MAX_LOG_BYTES);
    if (!env.DBT_PROJECT_DIR?.trim())
        return undefined;
    const projectLog = resolve(env.DBT_PROJECT_DIR.trim(), "logs", "dbt.log");
    try {
        const projectRoot = await realpath(resolve(env.DBT_PROJECT_DIR.trim()));
        const fileReal = await realpath(projectLog);
        if (!insideRoot(projectRoot, fileReal))
            return undefined;
        return await readTail(fileReal, MAX_LOG_BYTES);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        return undefined;
    }
}
export class DbtAdapter {
    artifactsDir;
    env;
    workspace;
    constructor(artifactsDir, env = process.env) {
        this.artifactsDir = artifactsDir;
        this.env = env;
        this.workspace = artifactsDir;
    }
    static fromEnv(env = process.env, artifactsDir) {
        return new DbtAdapter(resolveDbtArtifactsDir(env, artifactsDir), env);
    }
    async load(signal) {
        if (signal?.aborted)
            throw new Error("dbt artifact read interrupted.");
        const root = await directoryRealPath(this.artifactsDir);
        const resultsPath = await artifactPath(root, "run_results.json");
        if (!resultsPath)
            throw new Error("run_results.json was not found in the dbt artifacts directory.");
        const invocation = parseDbtInvocation(await readJsonArtifact(resultsPath, "run_results.json"));
        let graph = parseDbtManifest(undefined);
        let manifestNote;
        const manifestPath = await artifactPath(root, "manifest.json");
        if (manifestPath) {
            try {
                const info = await stat(manifestPath);
                if (info.size > MAX_ARTIFACT_BYTES) {
                    manifestNote = "manifest.json exceeds the 20MB read limit. Upstream and downstream impact is unknown.";
                }
                else {
                    graph = parseDbtManifest(await readJsonArtifact(manifestPath, "manifest.json"));
                }
            }
            catch (error) {
                if (error instanceof Error && /not valid JSON|not a file/.test(error.message)) {
                    manifestNote = "manifest.json could not be parsed. Upstream and downstream impact is unknown.";
                }
                else {
                    throw error;
                }
            }
        }
        const log = await configuredLog(this.env, root);
        return { invocation, graph, manifestNote, log: log?.text, logTruncated: log?.truncated ?? false };
    }
    secrets() {
        return secretsFromEnv(this.env);
    }
    async diagnose(signal) {
        const loaded = await this.load(signal);
        return diagnoseDbtInvocation({
            invocation: loaded.invocation,
            graph: loaded.graph,
            artifactsDir: this.workspace,
            log: loaded.log,
            logTruncated: loaded.logTruncated,
            manifestNote: loaded.manifestNote,
            secrets: this.secrets(),
        });
    }
    async inspect(action, id, signal) {
        const loaded = await this.load(signal);
        if (action === "run_results") {
            const counts = {};
            for (const result of loaded.invocation.results)
                counts[result.status] = (counts[result.status] ?? 0) + 1;
            const failed = loaded.invocation.results.filter(result => FAILING_STATUSES.has(result.status));
            const shown = failed.slice(0, ADDITIONAL_FAILURE_LIMIT);
            return {
                invocation_id: loaded.invocation.invocationId ?? null,
                generated_at: loaded.invocation.generatedAt ?? null,
                counts,
                failed: shown.map(result => ({
                    id: result.uniqueId,
                    name: displayName(loaded.graph, result.uniqueId),
                    status: result.status,
                    message_excerpt: failureExcerpt(result.message, undefined, this.secrets()).excerpt,
                })),
                truncated: failed.length > shown.length,
            };
        }
        const uniqueId = id?.trim();
        if (!uniqueId)
            throw new Error("id is required to inspect a dbt node.");
        const node = loaded.graph.nodes.get(uniqueId);
        const result = loaded.invocation.results.find(entry => entry.uniqueId === uniqueId);
        const statusById = new Map(loaded.invocation.results.map(entry => [entry.uniqueId, entry.status]));
        return {
            unique_id: uniqueId,
            name: displayName(loaded.graph, uniqueId),
            resource_type: node?.resourceType ?? null,
            original_file_path: node?.path ?? null,
            status: result?.status ?? null,
            message_excerpt: result ? failureExcerpt(result.message, undefined, this.secrets()).excerpt : "",
            upstream: capRefs(refsFor(loaded.graph.parents.get(uniqueId) ?? [], loaded.graph, statusById)).refs,
            downstream: capRefs(refsFor(loaded.graph.children.get(uniqueId) ?? [], loaded.graph, statusById)).refs,
        };
    }
}
