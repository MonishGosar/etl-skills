import { AirflowClient, airflowConfigFromEnv, airflowWorkspaceLabel } from "./airflow-client.js";
import { ADDITIONAL_FAILURE_LIMIT, asRecord, capRefs, classifyFailure, failureExcerpt, stringField, stringList, suggestedNextStep, } from "./diagnosis.js";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
function taskLabel(task) {
    return task.mapIndex !== undefined && task.mapIndex >= 0 ? `${task.taskId}[${task.mapIndex}]` : task.taskId;
}
export function parseTaskInstance(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    const taskId = stringField(record, "task_id");
    if (!taskId)
        return undefined;
    const tryNumber = typeof record.try_number === "number" && Number.isSafeInteger(record.try_number) && record.try_number >= 1
        ? record.try_number
        : 1;
    const mapIndex = typeof record.map_index === "number" && Number.isSafeInteger(record.map_index) ? record.map_index : undefined;
    return {
        taskId,
        state: (stringField(record, "state") ?? "none").toLowerCase(),
        tryNumber,
        startDate: stringField(record, "start_date"),
        ...(mapIndex !== undefined ? { mapIndex } : {}),
        operator: stringField(record, "operator") ?? stringField(record, "operator_name"),
    };
}
export function parseTaskEdge(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    const taskId = stringField(record, "task_id");
    if (!taskId)
        return undefined;
    return { taskId, upstream: stringList(record.upstream_task_ids), downstream: stringList(record.downstream_task_ids) };
}
export function logText(payload) {
    const record = asRecord(payload);
    if (!record)
        return { text: typeof payload === "string" ? payload : "", truncated: false };
    const truncated = record.truncated === true;
    const content = record.content;
    if (typeof content === "string")
        return { text: content, truncated };
    if (Array.isArray(content))
        return { text: content.filter((line) => typeof line === "string").join("\n"), truncated };
    return { text: "", truncated };
}
function selectFailedTasks(instances, taskId) {
    const matching = taskId ? instances.filter(instance => instance.taskId === taskId) : instances;
    if (taskId)
        return matching;
    return matching.filter(instance => instance.state === "failed");
}
function byStart(left, right) {
    const leftTime = left.startDate ? Date.parse(left.startDate) : Number.POSITIVE_INFINITY;
    const rightTime = right.startDate ? Date.parse(right.startDate) : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime)
        return leftTime - rightTime;
    return left.taskId.localeCompare(right.taskId);
}
export class AirflowAdapter {
    client;
    workspace;
    constructor(client) {
        this.client = client;
        this.workspace = airflowWorkspaceLabel(client.config);
    }
    static fromEnv(env = process.env) {
        return new AirflowAdapter(new AirflowClient(airflowConfigFromEnv(env)));
    }
    static fromConfig(config, transport) {
        return new AirflowAdapter(new AirflowClient(config, transport));
    }
    async page(segments, key, query, signal) {
        const items = [];
        const seen = new Set();
        let total = Number.POSITIVE_INFINITY;
        let offset = 0;
        for (let pageIndex = 0; pageIndex < MAX_PAGES && items.length < PAGE_SIZE * MAX_PAGES && offset < total; pageIndex += 1) {
            const body = asRecord(await this.client.request(segments, { ...query, limit: PAGE_SIZE, offset }, signal));
            const batch = Array.isArray(body?.[key]) ? body[key].filter((entry) => Boolean(asRecord(entry))) : [];
            if (typeof body?.total_entries === "number")
                total = body.total_entries;
            if (!batch.length)
                break;
            const marker = stringField(batch[0], "task_id") ?? stringField(batch[0], "dag_id") ?? stringField(batch[0], "dag_run_id") ?? "";
            if (marker && seen.has(marker))
                break;
            if (marker)
                seen.add(marker);
            items.push(...batch);
            offset += batch.length;
            if (batch.length < PAGE_SIZE)
                break;
        }
        const truncated = Number.isFinite(total) ? items.length < total : false;
        return { items: items.slice(0, PAGE_SIZE * MAX_PAGES), total: Number.isFinite(total) ? total : items.length, truncated };
    }
    async taskInstances(dagId, dagRunId, signal) {
        const page = await this.page(["dags", dagId, "dagRuns", dagRunId, "taskInstances"], "task_instances", {}, signal);
        return {
            instances: page.items.map(parseTaskInstance).filter((instance) => Boolean(instance)),
            truncated: page.truncated,
        };
    }
    async taskEdges(dagId, signal) {
        try {
            const page = await this.page(["dags", dagId, "tasks"], "tasks", {}, signal);
            const edges = new Map();
            for (const item of page.items) {
                const edge = parseTaskEdge(item);
                if (edge)
                    edges.set(edge.taskId, edge);
            }
            return edges;
        }
        catch (error) {
            if (error instanceof Error && /Airflow HTTP (403|404)/.test(error.message))
                return undefined;
            throw error;
        }
    }
    async taskLog(dagId, dagRunId, task, signal) {
        const attempts = task.tryNumber > 1 ? [task.tryNumber, task.tryNumber - 1] : [task.tryNumber];
        let status;
        for (const tryNumber of attempts) {
            try {
                const payload = await this.client.request(["dags", dagId, "dagRuns", dagRunId, "taskInstances", task.taskId, "logs", String(tryNumber)], task.mapIndex !== undefined && task.mapIndex >= 0 ? { map_index: task.mapIndex, full_content: "true" } : { full_content: "true" }, signal, "log");
                const log = logText(payload);
                return { ...log, available: true, tryNumber };
            }
            catch (error) {
                status = error instanceof Error ? /HTTP (\d+)/.exec(error.message)?.[1] : undefined;
                if (status === "404" && tryNumber !== attempts.at(-1))
                    continue;
                return { text: "", truncated: false, available: false, status };
            }
        }
        return { text: "", truncated: false, available: false, status };
    }
    async diagnose(input, signal) {
        const dagId = requiredId(input.dagId, "dag_id");
        const dagRunId = requiredId(input.dagRunId, "dag_run_id");
        const dagRun = asRecord(await this.client.request(["dags", dagId, "dagRuns", dagRunId], {}, signal));
        if (!dagRun)
            throw new Error("Airflow returned an empty DAG run. No brief was produced.");
        const state = (stringField(dagRun, "state") ?? "unknown").toLowerCase();
        const { instances, truncated: instancesTruncated } = await this.taskInstances(dagId, dagRunId, signal);
        const edges = await this.taskEdges(dagId, signal);
        const evidence = [
            { source: "airflow:dag_run", observation: `DAG ${dagId} run ${dagRunId} is ${state} via Airflow API ${this.client.config.apiVersion}.` },
        ];
        if (instancesTruncated)
            evidence.push({ source: "airflow:task_instances", observation: "Task instance pages were capped. Impact may be incomplete." });
        if (!edges)
            evidence.push({ source: "airflow:tasks", observation: "The task graph was not readable. Upstream and downstream impact is limited to task states." });
        const failed = selectFailedTasks(instances, input.taskId).sort(byStart);
        if (!failed.length && state !== "failed") {
            return {
                provider: "airflow",
                outcome: "no_failure",
                failed: null,
                additionalFailures: [],
                errorExcerpt: "",
                impact: { upstream: [], downstream: [], truncated: instancesTruncated },
                likelyCause: { category: "unknown", summary: "No task instance is in state failed.", confidence: "high" },
                suggestedNextStep: "No failure to diagnose. Confirm the DAG id and DAG run id.",
                evidence,
            };
        }
        const primary = failed[0];
        if (!primary) {
            const note = typeof dagRun.note === "string" ? dagRun.note : "";
            const excerpt = failureExcerpt(note, undefined, this.client.secrets());
            const cause = classifyFailure({ message: excerpt.excerpt, status: state });
            evidence.push({ source: "airflow:dag_run", observation: "The DAG run failed without a task instance in state failed." });
            return {
                provider: "airflow",
                outcome: "failed",
                failed: { kind: "dag_run", id: dagRunId, name: dagId, status: state },
                additionalFailures: [],
                errorExcerpt: excerpt.excerpt || "The DAG run failed without a failed task instance.",
                impact: { upstream: [], downstream: [], truncated: instancesTruncated },
                likelyCause: note.trim() ? cause : {
                    category: "unknown",
                    summary: "The DAG run failed without a failed task instance or note.",
                    confidence: "low",
                },
                suggestedNextStep: note.trim() ? suggestedNextStep(cause.category) : "Check DAG-level callbacks and scheduler logs. No task instance was in state failed.",
                evidence,
            };
        }
        const log = await this.taskLog(dagId, dagRunId, primary, signal);
        const excerpt = failureExcerpt("", log.text, this.client.secrets());
        if (!log.available) {
            evidence.push({
                source: "airflow:task_log",
                observation: log.status
                    ? `The task log was not available (HTTP ${log.status}). The brief uses task state only.`
                    : "The task log was not available. The brief uses task state only.",
            });
        }
        else if (log.truncated || excerpt.truncated)
            evidence.push({ source: "airflow:task_log", observation: "The task log excerpt is capped. The rest of the log was not returned." });
        else
            evidence.push({ source: "airflow:task_log", observation: `Log try ${log.tryNumber ?? primary.tryNumber} for ${taskLabel(primary)} was read.` });
        const edge = edges?.get(primary.taskId);
        const stateByTask = new Map(instances.map(instance => [instance.taskId, instance.state]));
        if (edges && !edge) {
            evidence.push({ source: "airflow:tasks", observation: `${primary.taskId} was not in the task list. Upstream and downstream impact is unknown.` });
        }
        const toRef = (id) => ({ id, name: id, ...(stateByTask.has(id) ? { status: stateByTask.get(id) } : {}) });
        const upstream = (edge?.upstream ?? []).map(toRef);
        const downstream = (edge?.downstream ?? []).map(id => ({
            id,
            name: id,
            ...(stateByTask.has(id) ? { status: stateByTask.get(id) } : {}),
        }));
        const cappedUpstream = capRefs(upstream);
        const cappedDownstream = capRefs(downstream);
        const additional = failed.slice(1, 1 + ADDITIONAL_FAILURE_LIMIT).map(instance => ({
            id: taskLabel(instance),
            name: instance.taskId,
            status: instance.state,
        }));
        const cause = classifyFailure({ message: excerpt.excerpt, status: primary.state });
        evidence.push({
            source: "airflow:task_instances",
            observation: input.taskId
                ? `${taskLabel(primary)} was requested for diagnosis.`
                : `${taskLabel(primary)} is the earliest task in state failed.`,
        });
        if (instances.some(instance => instance.state === "upstream_failed" || instance.state === "skipped")) {
            evidence.push({ source: "airflow:task_instances", observation: "Tasks in upstream_failed or skipped are impact, not separate root causes." });
        }
        return {
            provider: "airflow",
            outcome: "failed",
            failed: {
                kind: "task",
                id: taskLabel(primary),
                name: primary.taskId,
                status: primary.state,
                ...(primary.operator ? { location: primary.operator } : {}),
            },
            additionalFailures: additional,
            errorExcerpt: excerpt.excerpt,
            impact: {
                upstream: cappedUpstream.refs,
                downstream: cappedDownstream.refs,
                truncated: cappedUpstream.truncated || cappedDownstream.truncated || instancesTruncated || failed.length > additional.length + 1,
            },
            likelyCause: cause,
            suggestedNextStep: suggestedNextStep(cause.category),
            evidence,
        };
    }
    async inspect(request, signal) {
        const offset = parseOffset(request.pageToken);
        if (request.action === "dags") {
            const body = asRecord(await this.client.request(["dags"], { limit: 25, offset }, signal)) ?? {};
            const dags = Array.isArray(body.dags) ? body.dags : [];
            return {
                dags: dags.map(item => {
                    const record = asRecord(item);
                    return { dag_id: record ? stringField(record, "dag_id") ?? "" : "", is_paused: record?.is_paused === true };
                }).filter(dag => dag.dag_id),
                total_entries: typeof body.total_entries === "number" ? body.total_entries : dags.length,
                next_page_token: nextToken(offset, dags.length, body.total_entries),
            };
        }
        const dagId = requiredId(request.dagId, "dag_id");
        if (request.action === "dag_runs") {
            const body = asRecord(await this.client.request(["dags", dagId, "dagRuns"], { limit: 25, offset }, signal)) ?? {};
            const runs = Array.isArray(body.dag_runs) ? body.dag_runs : [];
            return {
                dag_runs: runs.map(summarizeDagRun).filter((run) => Boolean(run)),
                total_entries: typeof body.total_entries === "number" ? body.total_entries : runs.length,
                next_page_token: nextToken(offset, runs.length, body.total_entries),
            };
        }
        const dagRunId = requiredId(request.dagRunId, "dag_run_id");
        if (request.action === "dag_run") {
            return summarizeDagRun(await this.client.request(["dags", dagId, "dagRuns", dagRunId], {}, signal));
        }
        if (request.action === "task_instances") {
            const loaded = await this.taskInstances(dagId, dagRunId, signal);
            return {
                task_instances: loaded.instances.map(instance => ({
                    task_id: taskLabel(instance),
                    state: instance.state,
                    try_number: instance.tryNumber,
                    start_date: instance.startDate ?? null,
                })),
                truncated: loaded.truncated,
            };
        }
        const taskId = requiredId(request.taskId, "task_id");
        const instance = request.tryNumber
            ? { taskId, state: "unknown", tryNumber: request.tryNumber, mapIndex: undefined }
            : (await this.taskInstances(dagId, dagRunId, signal)).instances.find(item => item.taskId === taskId);
        if (!instance)
            throw new Error("task_id was not found on this DAG run.");
        const log = await this.taskLog(dagId, dagRunId, instance, signal);
        const excerpt = failureExcerpt("", log.text, this.client.secrets());
        return {
            dag_id: dagId,
            dag_run_id: dagRunId,
            task_id: taskId,
            try_number: instance.tryNumber,
            excerpt: excerpt.excerpt,
            truncated: !log.available || log.truncated || excerpt.truncated,
        };
    }
}
function requiredId(value, name) {
    const text = value?.trim();
    if (!text)
        throw new Error(`${name} is required.`);
    return text;
}
function parseOffset(pageToken) {
    if (!pageToken)
        return 0;
    if (!/^\d+$/.test(pageToken))
        throw new Error("page_token must be a non-negative integer offset.");
    const offset = Number(pageToken);
    if (!Number.isSafeInteger(offset))
        throw new Error("page_token is too large.");
    return offset;
}
function nextToken(offset, count, total) {
    if (typeof total !== "number" || offset + count >= total)
        return null;
    return String(offset + count);
}
function summarizeDagRun(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    const dagId = stringField(record, "dag_id");
    const dagRunId = stringField(record, "dag_run_id");
    if (!dagId || !dagRunId)
        return undefined;
    return {
        dag_id: dagId,
        dag_run_id: dagRunId,
        state: (stringField(record, "state") ?? "unknown").toLowerCase(),
        start_date: stringField(record, "start_date") ?? null,
        end_date: stringField(record, "end_date") ?? null,
        logical_date: stringField(record, "logical_date") ?? stringField(record, "execution_date") ?? null,
    };
}
