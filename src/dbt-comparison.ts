import type { DbtGraph, DbtInvocation } from "./dbt-adapter.js";
import { diagnoseDbtInvocation, reachableNodes } from "./dbt-adapter.js";

type Snapshot = { invocation: DbtInvocation; graph: DbtGraph };
const LIMIT = 25;

export function compareDbtSnapshots(before: Snapshot, after: Snapshot, nodeId?: string) {
  const successful = new Set(["success", "pass", "skipped"]);
  if (!before.invocation.results.length || before.invocation.results.some(r => !successful.has(r.status)) || !before.invocation.results.some(r => r.status !== "skipped")) {
    throw new Error("Baseline must contain successful executed results without failures, warnings, or unknown statuses.");
  }
  for (const snapshot of [before, after]) {
    if (!snapshot.graph.present || !snapshot.graph.nodes.size) throw new Error("Both comparisons require readable manifests with resource nodes.");
    if (snapshot.graph.invocationId && snapshot.invocation.invocationId && snapshot.graph.invocationId !== snapshot.invocation.invocationId) {
      throw new Error("Manifest and run results belong to different invocations.");
    }
  }
  if (before.graph.projectId && after.graph.projectId && before.graph.projectId !== after.graph.projectId) throw new Error("Artifacts belong to different dbt projects.");
  if (before.invocation.invocationId && before.invocation.invocationId === after.invocation.invocationId) throw new Error("Baseline and current artifacts describe the same invocation.");
  const beforeTime = Date.parse(before.invocation.generatedAt ?? "");
  const afterTime = Date.parse(after.invocation.generatedAt ?? "");
  if (Number.isFinite(beforeTime) && Number.isFinite(afterTime) && beforeTime >= afterTime) throw new Error("Baseline must precede the current invocation.");
  const brief = diagnoseDbtInvocation({ ...after, artifactsDir: "current artifacts" });
  const focus = nodeId ?? brief.failed?.id;
  if (focus && !after.graph.nodes.has(focus) && !before.graph.nodes.has(focus)) throw new Error("Selected node is absent from both manifests.");
  const upstream = focus ? new Set([...reachableNodes(focus, after.graph.parents), ...reachableNodes(focus, before.graph.parents)]) : new Set<string>();
  const downstream = focus ? new Set([...reachableNodes(focus, after.graph.children), ...reachableNodes(focus, before.graph.children)]) : new Set<string>();
  const notes = ["Manifest changes are investigation candidates, not proof of causality or a validated repair.", "Column metadata is declared dbt metadata, not a live warehouse schema snapshot."];
  if (!before.graph.projectId || !after.graph.projectId) notes.push("Project identity is incomplete; caller must establish that snapshots belong to the same project.");
  if (!Number.isFinite(beforeTime) || !Number.isFinite(afterTime)) notes.push("Artifact timestamps are unavailable or invalid; baseline ordering is unverified.");
  if (focus && !before.invocation.results.some(result => result.uniqueId === focus && ["success", "pass"].includes(result.status))) {
    notes.push("Selected subject was not executed successfully in the baseline; a comparable successful outcome for that subject is unverified.");
  }
  const changes = [];
  let incompleteNodes = 0;
  for (const id of new Set([...before.graph.nodes.keys(), ...after.graph.nodes.keys()])) {
    const old = before.graph.nodes.get(id);
    const current = after.graph.nodes.get(id);
    const kinds: string[] = [];
    if (!old) kinds.push("node_added");
    else if (!current) kinds.push("node_removed");
    else {
      if (old.codeHash && current.codeHash && old.codeHash !== current.codeHash) kinds.push("code");
      if (old.configHash && current.configHash && old.configHash !== current.configHash) kinds.push("configuration");
      if (!old.codeHash || !current.codeHash || !old.configHash || !current.configHash || !old.columns || !current.columns) incompleteNodes++;
    }
    const oldParents = new Set(before.graph.parents.get(id) ?? []);
    const newParents = new Set(after.graph.parents.get(id) ?? []);
    const addedRefs = [...newParents].filter(parent => !oldParents.has(parent));
    const removedRefs = [...oldParents].filter(parent => !newParents.has(parent));
    const dependenciesKnown = before.graph.parents.has(id) && after.graph.parents.has(id);
    if (old && current && dependenciesKnown && (addedRefs.length || removedRefs.length)) kinds.push("dependencies");
    const addedColumns = old?.columns && current?.columns ? [...current.columns.keys()].filter(c => !old.columns!.has(c)) : [];
    const removedColumns = old?.columns && current?.columns ? [...old.columns.keys()].filter(c => !current.columns!.has(c)) : [];
    const typeChanges = old?.columns && current?.columns ? [...current.columns].filter(([c, type]) => old.columns!.has(c) && old.columns!.get(c) !== type).map(([name, type]) => ({ name, before: old.columns!.get(name), after: type })) : [];
    if (addedColumns.length || removedColumns.length || typeChanges.length) kinds.push("column_metadata");
    if (!kinds.length) continue;
    const relation = id === focus ? "subject" : upstream.has(id) ? "upstream" : downstream.has(id) ? "downstream" : focus ? "unrelated" : "unscoped";
    changes.push({ id, name: current?.name ?? old!.name, relation, kinds,
      columns: { added: addedColumns.slice(0, LIMIT), removed: removedColumns.slice(0, LIMIT), typeChanged: typeChanges.slice(0, LIMIT) },
      references: { added: dependenciesKnown ? addedRefs.slice(0, LIMIT) : [], removed: dependenciesKnown ? removedRefs.slice(0, LIMIT) : [] },
      truncated: [addedColumns, removedColumns, typeChanges, addedRefs, removedRefs].some(values => values.length > LIMIT),
      evidence: ["baseline/manifest.json", "current/manifest.json"],
    });
  }
  const priority: Record<string, number> = { subject: 0, upstream: 1, downstream: 2, unrelated: 3, unscoped: 4 };
  changes.sort((a, b) => priority[a.relation] - priority[b.relation] || a.id.localeCompare(b.id));
  if (incompleteNodes) notes.push(`${incompleteNodes} common nodes have incomplete comparison metadata; absent evidence does not establish that code, configuration or columns are unchanged.`);
  if ([...before.graph.nodes.keys()].some(id => after.graph.nodes.has(id) && (!before.graph.parents.has(id) || !after.graph.parents.has(id)))) notes.push("Dependency maps are incomplete for some common nodes; missing dependency evidence is not treated as an added or removed reference.");
  return { provider: "dbt", baseline: { invocationId: before.invocation.invocationId ?? null, generatedAt: before.invocation.generatedAt ?? null, selection: "caller-supplied successful invocation; latest-success status is not auto-discovered" },
    current: { invocationId: after.invocation.invocationId ?? null, generatedAt: after.invocation.generatedAt ?? null },
    focusNode: focus ?? null, failedSubject: brief.failed, observedChangedNodes: changes.length,
    changedUpstreamNodes: changes.filter(c => c.relation === "upstream").length,
    changes: changes.slice(0, LIMIT), truncated: changes.length > LIMIT || changes.some(c => c.truncated), notes };
}
