import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { compareDbtSnapshots } from "./dbt-comparison.js";
import { secretsFromEnv } from "./redact.js";
import {
  ADDITIONAL_FAILURE_LIMIT,
  type DiagnosisBrief,
  type DiagnosisRef,
  asRecord,
  capRefs,
  classifyFailure,
  failureExcerpt,
  stringField,
  stringList,
  suggestedNextStep,
} from "./diagnosis.js";

const ARTIFACT_NAMES = new Set(["run_results.json", "manifest.json", "dbt.log"]);
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const FAILING_STATUSES = new Set(["error", "fail"]);

export type DbtResult = {
  uniqueId: string;
  status: string;
  message: string;
};

export type DbtInvocation = {
  invocationId?: string;
  generatedAt?: string;
  elapsedTime?: number;
  results: DbtResult[];
};

export type DbtNodeInfo = {
  name: string;
  resourceType?: string;
  path?: string;
  codeHash?: string;
  configHash?: string;
  columns?: Map<string, string | null>;
};

export type DbtGraph = {
  present: boolean;
  projectId?: string;
  invocationId?: string;
  nodes: Map<string, DbtNodeInfo>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
};

function fingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    const record = asRecord(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])])) : item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type DbtInspectAction = "run_results" | "node";

export function dbtConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DBT_ARTIFACTS_DIR?.trim() || env.DBT_PROJECT_DIR?.trim());
}

export function resolveDbtArtifactsDir(env: NodeJS.ProcessEnv, override?: string): string {
  const selected = override?.trim() || env.DBT_ARTIFACTS_DIR?.trim() || (env.DBT_PROJECT_DIR?.trim() ? resolve(env.DBT_PROJECT_DIR.trim(), "target") : "");
  if (!selected) throw new Error("Pass artifacts_dir or set DBT_ARTIFACTS_DIR or DBT_PROJECT_DIR.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(selected)) throw new Error("dbt artifacts must be a local directory path.");
  return resolve(selected);
}

export function parseDbtInvocation(value: unknown): DbtInvocation {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.results)) {
    throw new Error("run_results.json has no results array. The file contents were not returned.");
  }
  const metadata = asRecord(root.metadata);
  const results: DbtResult[] = [];
  for (const entry of root.results) {
    const record = asRecord(entry);
    if (!record) continue;
    const uniqueId = stringField(record, "unique_id");
    if (!uniqueId) continue;
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

export function parseDbtManifest(value: unknown | undefined): DbtGraph {
  const nodes = new Map<string, DbtNodeInfo>();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const root = asRecord(value);
  if (!root) return { present: false, nodes, parents, children };

  const collect = (bucket: unknown) => {
    const records = asRecord(bucket);
    if (!records) return;
    for (const [uniqueId, raw] of Object.entries(records)) {
      const node = asRecord(raw);
      if (!node) continue;
      const sourceName = stringField(node, "source_name");
      const name = stringField(node, "name") ?? uniqueId.split(".").at(-1) ?? uniqueId;
      const checksum = asRecord(node.checksum);
      const rawCode = stringField(node, "raw_code") ?? stringField(node, "raw_sql");
      const checksumHash = checksum?.name === "sha256" && typeof checksum.checksum === "string" && /^[a-f0-9]{64}$/i.test(checksum.checksum)
        ? checksum.checksum.toLowerCase() : undefined;
      const config = asRecord(node.config);
      const columns = asRecord(node.columns);
      nodes.set(uniqueId, {
        name: sourceName ? `${sourceName}.${name}` : name,
        resourceType: stringField(node, "resource_type"),
        path: stringField(node, "original_file_path") ?? stringField(node, "path"),
        codeHash: rawCode ? createHash("sha256").update(rawCode).digest("hex") : checksumHash,
        configHash: config ? fingerprint(config) : undefined,
        columns: columns ? new Map(Object.entries(columns).map(([key, value]) => [key, stringField(asRecord(value) ?? {}, "data_type") ?? null])) : undefined,
      });
      const depends = asRecord(node.depends_on);
      if (depends) parents.set(uniqueId, stringList(depends.nodes));
    }
  };
  collect(root.nodes);
  collect(root.sources);

  const parentMap = asRecord(root.parent_map);
  if (parentMap) {
    for (const [uniqueId, raw] of Object.entries(parentMap)) parents.set(uniqueId, stringList(raw));
  }
  const childMap = asRecord(root.child_map);
  if (childMap) {
    for (const [uniqueId, raw] of Object.entries(childMap)) children.set(uniqueId, stringList(raw));
  } else {
    for (const [uniqueId, upstream] of parents) {
      for (const parent of upstream) {
        const current = children.get(parent) ?? [];
        current.push(uniqueId);
        children.set(parent, current);
      }
    }
  }
  const metadata = asRecord(root.metadata);
  return { present: true, nodes, parents, children,
    projectId: metadata ? stringField(metadata, "project_id") : undefined,
    invocationId: metadata ? stringField(metadata, "invocation_id") : undefined };
}

export function reachableNodes(start: string, edges: Map<string, string[]>, onCycleToStart?: () => void): Set<string> {
  const visited = new Set<string>([start]);
  const pending = [...(edges.get(start) ?? [])];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === start) { onCycleToStart?.(); continue; }
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of edges.get(id) ?? []) pending.push(next);
  }
  visited.delete(start);
  return visited;
}

function displayName(graph: DbtGraph, uniqueId: string): string {
  return graph.nodes.get(uniqueId)?.name ?? uniqueId.split(".").at(-1) ?? uniqueId;
}

function refsFor(ids: string[], graph: DbtGraph, statusById: Map<string, string>): DiagnosisRef[] {
  return ids.map(id => ({
    id,
    name: displayName(graph, id),
    ...(statusById.has(id) ? { status: statusById.get(id) } : {}),
  }));
}

export function diagnoseDbtInvocation(input: {
  invocation: DbtInvocation;
  graph: DbtGraph;
  artifactsDir: string;
  log?: string;
  logTruncated?: boolean;
  manifestNote?: string;
  secrets?: readonly string[];
}): DiagnosisBrief {
  const secrets = input.secrets ?? [];
  const statusById = new Map(input.invocation.results.map(result => [result.uniqueId, result.status]));
  const evidence: DiagnosisBrief["evidence"] = [{
    source: "run_results.json",
    observation: input.invocation.invocationId
      ? `Invocation ${input.invocation.invocationId} contains ${input.invocation.results.length} results.`
      : `run_results.json contains ${input.invocation.results.length} results.`,
  }];
  if (input.invocation.generatedAt) evidence.push({ source: "run_results.json", observation: `Artifacts generated at ${input.invocation.generatedAt}.` });
  if (input.manifestNote) evidence.push({ source: "manifest.json", observation: input.manifestNote });
  else if (!input.graph.present) evidence.push({ source: "manifest.json", observation: "manifest.json was not available. Upstream and downstream impact is unknown." });
  else evidence.push({ source: "manifest.json", observation: "Upstream and downstream ids come from the manifest parent and child maps." });

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

  const failedIds = new Set(failed.map(result => result.uniqueId));
  let cyclic = false;
  const rootCandidates = failed.filter(result => ![...reachableNodes(result.uniqueId, input.graph.parents, () => { cyclic = true; })].some(id => failedIds.has(id)));
  const primary = cyclic ? failed[0] : rootCandidates[0] ?? failed[0];
  const node = input.graph.nodes.get(primary.uniqueId);
  const excerpt = failureExcerpt(primary.message, input.log, secrets);
  if (input.logTruncated || excerpt.truncated) {
    evidence.push({ source: "dbt.log", observation: "The error excerpt is capped. The rest of the log was not returned." });
  } else if (excerpt.logUsed) {
    evidence.push({ source: "dbt.log", observation: "A bounded excerpt from dbt.log was included with the run_results message." });
  } else {
    evidence.push({ source: "dbt.log", observation: input.log ? "dbt.log did not add a separate error beyond run_results.json." : "dbt.log was not read." });
  }
  const causeText = primary.message.trim() ? failureExcerpt(primary.message, undefined, secrets).excerpt : failed.length === 1 ? excerpt.excerpt : "";
  const cause = classifyFailure({ message: causeText, status: primary.status, resourceType: node?.resourceType });
  if (!primary.message.trim() && failed.length > 1) evidence.push({ source: "dbt.log", observation: "The primary subject has no direct error message. Invocation-wide log errors are not attributed to this subject." });
  const upstream = capRefs(refsFor(input.graph.parents.get(primary.uniqueId) ?? [], input.graph, statusById));
  const downstream = capRefs(refsFor(input.graph.children.get(primary.uniqueId) ?? [], input.graph, statusById));
  const additional = failed.filter(result => result !== primary).slice(0, ADDITIONAL_FAILURE_LIMIT).map(result => ({
    id: result.uniqueId,
    name: displayName(input.graph, result.uniqueId),
    status: result.status,
  }));
  if (failed.length > 1 || cyclic) {
    evidence.push({
      source: "run_results.json",
      observation: !cyclic && rootCandidates.length
        ? `${failed.length} nodes failed; ${rootCandidates.length} upstream-most failing candidates remain. The first candidate in artifact order is the primary subject, not proof of a unique cause.`
        : `${failed.length} nodes failed in a cyclic or incomplete graph. Primary subject falls back to artifact order; causal ordering is unverified.`,
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

async function directoryRealPath(directory: string): Promise<string> {
  try {
    const root = await realpath(directory);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("dbt artifacts path must be a directory containing run_results.json.");
    return root;
  } catch (error) {
    if (error instanceof Error && /must be a directory/.test(error.message)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("dbt artifacts directory was not found.");
    throw new Error("dbt artifacts directory could not be read.");
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function artifactPath(root: string, filename: string): Promise<string | undefined> {
  if (!ARTIFACT_NAMES.has(filename)) throw new Error("Unsupported dbt artifact name.");
  const candidate = resolve(root, filename);
  try {
    const fileReal = await realpath(candidate);
    if (!insideRoot(root, fileReal)) throw new Error(`${filename} resolves outside the artifacts directory.`);
    return fileReal;
  } catch (error) {
    if (error instanceof Error && /outside/.test(error.message)) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${filename} could not be read.`);
  }
}

async function readJsonArtifact(path: string, filename: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${filename} is not a file.`);
  if (info.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`${filename} exceeds the 20MB read limit. The file contents were not returned.`);
  }
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${filename} is not valid JSON. The file contents were not returned.`);
  }
}

async function readTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("dbt log path is not a file.");
    const length = Math.min(info.size, maxBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), truncated: info.size > maxBytes };
  } finally {
    await handle.close();
  }
}

async function configuredLog(env: NodeJS.ProcessEnv, root: string): Promise<{ text: string; truncated: boolean } | undefined> {
  const explicit = env.DBT_LOG_PATH?.trim();
  if (explicit) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(explicit)) throw new Error("DBT_LOG_PATH must be a local file path.");
    try {
      return await readTail(await realpath(resolve(explicit)), MAX_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("DBT_LOG_PATH could not be read.");
    }
  }
  const local = await artifactPath(root, "dbt.log");
  if (local) return readTail(local, MAX_LOG_BYTES);
  if (!env.DBT_PROJECT_DIR?.trim()) return undefined;
  const projectLog = resolve(env.DBT_PROJECT_DIR.trim(), "logs", "dbt.log");
  try {
    const projectRoot = await realpath(resolve(env.DBT_PROJECT_DIR.trim()));
    const fileReal = await realpath(projectLog);
    if (!insideRoot(projectRoot, fileReal)) return undefined;
    return await readTail(fileReal, MAX_LOG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export class DbtAdapter {
  readonly workspace: string;

  constructor(private readonly artifactsDir: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.workspace = artifactsDir;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, artifactsDir?: string): DbtAdapter {
    return new DbtAdapter(resolveDbtArtifactsDir(env, artifactsDir), env);
  }

  private async load(signal?: AbortSignal, includeLog = true): Promise<{ invocation: DbtInvocation; graph: DbtGraph; manifestNote?: string; log?: string; logTruncated: boolean }> {
    if (signal?.aborted) throw new Error("dbt artifact read interrupted.");
    const root = await directoryRealPath(this.artifactsDir);
    const resultsPath = await artifactPath(root, "run_results.json");
    if (!resultsPath) throw new Error("run_results.json was not found in the dbt artifacts directory.");
    const invocation = parseDbtInvocation(await readJsonArtifact(resultsPath, "run_results.json"));
    let graph = parseDbtManifest(undefined);
    let manifestNote: string | undefined;
    const manifestPath = await artifactPath(root, "manifest.json");
    if (manifestPath) {
      try {
        const info = await stat(manifestPath);
        if (info.size > MAX_ARTIFACT_BYTES) {
          manifestNote = "manifest.json exceeds the 20MB read limit. Upstream and downstream impact is unknown.";
        } else {
          graph = parseDbtManifest(await readJsonArtifact(manifestPath, "manifest.json"));
        }
      } catch (error) {
        if (error instanceof Error && /not valid JSON|not a file/.test(error.message)) {
          manifestNote = "manifest.json could not be parsed. Upstream and downstream impact is unknown.";
        } else {
          throw error;
        }
      }
    }
    if (graph.invocationId && invocation.invocationId && graph.invocationId !== invocation.invocationId) {
      throw new Error("Manifest and run results belong to different invocations.");
    }
    const log = includeLog ? await configuredLog(this.env, root) : undefined;
    if (signal?.aborted) throw new Error("dbt artifact read interrupted.");
    return { invocation, graph, manifestNote, log: log?.text, logTruncated: log?.truncated ?? false };
  }

  private secrets(): string[] {
    return secretsFromEnv(this.env);
  }

  async diagnose(signal?: AbortSignal): Promise<DiagnosisBrief> {
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

  async compareRuns(baselineDir: string, nodeId?: string, signal?: AbortSignal) {
    const baseline = DbtAdapter.fromEnv(this.env, baselineDir);
    if (await directoryRealPath(this.artifactsDir) === await directoryRealPath(baseline.artifactsDir)) {
      throw new Error("Baseline and current artifacts must be different directories.");
    }
    const before = await baseline.load(signal, false);
    const after = await this.load(signal, false);
    const result = compareDbtSnapshots(before, after, nodeId);
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return failureExcerpt(value, undefined, this.secrets()).excerpt;
      if (Array.isArray(value)) return value.map(redact);
      const record = asRecord(value);
      return record ? Object.fromEntries(Object.entries(record).map(([key, item]) => [key, redact(item)])) : value;
    };
    return redact(result);
  }

  async inspect(action: DbtInspectAction, id?: string, signal?: AbortSignal): Promise<unknown> {
    const loaded = await this.load(signal);
    if (action === "run_results") {
      const counts: Record<string, number> = {};
      for (const result of loaded.invocation.results) counts[result.status] = (counts[result.status] ?? 0) + 1;
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
    if (!uniqueId) throw new Error("id is required to inspect a dbt node.");
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
