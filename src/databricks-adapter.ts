import type { ApprovalRequest, EtlWorkspaceAdapter, ExecuteOptions, WorkspaceCapabilities } from "./core.js";
import { requireApproval } from "./core.js";
import { DatabricksClient, numericId, required } from "./client.js";

export type InspectAction =
  | "jobs" | "job" | "runs" | "run" | "output" | "table" | "notebook"
  | "pipelines" | "pipeline" | "pipeline_update";

export type DatabricksRequest =
  | { kind: "inspect"; action: InspectAction; id?: string; name?: string; path?: string; page_token?: string }
  | { kind: "pipeline"; action: "start" | "stop"; pipeline_id: string; full_refresh?: boolean; refresh_selection?: string[] }
  | { kind: "query"; action: "execute" | "status" | "cancel"; sql?: string; statement_id?: string }
  | { kind: "run"; action: "start" | "cancel"; id: string; idempotency_token?: string; parameters?: Record<string, string> }
  | { kind: "repair"; run_id: string; tasks: string[]; latest_repair_id?: string; rerun_dependent_tasks: boolean; evidence: string };

export class DatabricksAdapter implements EtlWorkspaceAdapter<DatabricksRequest> {
  constructor(readonly client: DatabricksClient) {}

  capabilities(): WorkspaceCapabilities {
    return {
      provider: "databricks",
      mode: "interactive-mutations",
      operations: [
        { name: "inspect", operationClass: "read", available: true },
        { name: "query_status", operationClass: "read", available: true },
        { name: "query_execute", operationClass: "execute", available: true },
        { name: "pipeline_control", operationClass: "control", available: true },
        { name: "job_control", operationClass: "control", available: true },
        { name: "job_repair", operationClass: "repair", available: true },
      ],
    };
  }

  async execute(request: DatabricksRequest, options: ExecuteOptions = {}): Promise<unknown> {
    switch (request.kind) {
      case "inspect": return this.inspect(request, options.signal);
      case "pipeline": return this.pipeline(request, options);
      case "query": return this.query(request, options);
      case "run": return this.run(request, options);
      case "repair": return this.repair(request, options);
    }
  }

  private async inspect(request: Extract<DatabricksRequest, { kind: "inspect" }>, signal?: AbortSignal) {
    switch (request.action) {
      case "jobs": return this.client.request("/api/2.2/jobs/list", { name: request.name, limit: 25, page_token: request.page_token }, undefined, signal);
      case "job": return this.client.request("/api/2.2/jobs/get", { job_id: numericId(request.id, "id") }, undefined, signal);
      case "runs": return this.client.request("/api/2.2/jobs/runs/list", { job_id: numericId(request.id, "id"), limit: 10, page_token: request.page_token }, undefined, signal);
      case "run": return this.client.request("/api/2.2/jobs/runs/get", { run_id: numericId(request.id, "id"), include_history: "true" }, undefined, signal);
      case "output": return this.client.request("/api/2.2/jobs/runs/get-output", { run_id: numericId(request.id, "task run id") }, undefined, signal);
      case "table": return this.client.request(`/api/2.1/unity-catalog/tables/${encodeURIComponent(required(request.name, "catalog.schema.table name"))}`, {}, undefined, signal);
      case "notebook": return this.client.request("/api/2.0/workspace/export", { path: required(request.path, "path"), format: "SOURCE" }, undefined, signal);
      case "pipelines": return this.client.request("/api/2.0/pipelines", { max_results: 25, page_token: request.page_token }, undefined, signal);
      case "pipeline": return this.client.request(`/api/2.0/pipelines/${encodeURIComponent(required(request.id, "pipeline id"))}`, {}, undefined, signal);
      case "pipeline_update": return this.client.request(`/api/2.0/pipelines/${encodeURIComponent(required(request.id, "pipeline id"))}/updates/${encodeURIComponent(required(request.name, "update id"))}`, {}, undefined, signal);
    }
  }

  private async approve(options: ExecuteOptions, operation: string, operationClass: ApprovalRequest["operationClass"], payload: unknown) {
    await requireApproval(options.approvalGate, {
      provider: "databricks",
      workspace: this.client.config.host,
      operation,
      operationClass,
      payload,
      warning: "This may incur cost or change data. Name-resolution defaults do not enforce sandbox isolation.",
    });
  }

  private async pipeline(request: Extract<DatabricksRequest, { kind: "pipeline" }>, options: ExecuteOptions) {
    const pipelineId = encodeURIComponent(required(request.pipeline_id, "pipeline_id"));
    const body = request.action === "start"
      ? { full_refresh: request.full_refresh ?? false, refresh_selection: request.refresh_selection }
      : {};
    await this.approve(options, `${request.action} pipeline`, "control", { pipeline_id: request.pipeline_id, ...body });
    return this.client.request(request.action === "start" ? `/api/2.0/pipelines/${pipelineId}/updates` : `/api/2.0/pipelines/${pipelineId}/stop`, {}, body, options.signal);
  }

  private async query(request: Extract<DatabricksRequest, { kind: "query" }>, options: ExecuteOptions) {
    if (request.action === "execute") {
      const body = {
        warehouse_id: required(this.client.config.warehouse, "DATABRICKS_WAREHOUSE_ID"),
        statement: required(request.sql, "sql"),
        catalog: this.client.config.catalog,
        schema: this.client.config.schema,
        wait_timeout: "10s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: 100,
        byte_limit: 16_000,
      };
      await this.approve(options, "execute SQL", "execute", body);
      return this.client.request("/api/2.0/sql/statements", {}, body, options.signal);
    }
    const id = encodeURIComponent(required(request.statement_id, "statement_id"));
    if (request.action === "cancel") {
      await this.approve(options, "cancel SQL statement", "control", { statement_id: request.statement_id });
      return this.client.request(`/api/2.0/sql/statements/${id}/cancel`, {}, {}, options.signal);
    }
    return this.client.request(`/api/2.0/sql/statements/${id}`, {}, undefined, options.signal);
  }

  private async run(request: Extract<DatabricksRequest, { kind: "run" }>, options: ExecuteOptions) {
    const token = request.action === "start" ? required(request.idempotency_token, "idempotency_token") : undefined;
    if (token && token.length > 64) throw new Error("idempotency_token must be at most 64 characters.");
    const body = request.action === "start"
      ? { job_id: numericId(request.id, "job id"), idempotency_token: token, job_parameters: request.parameters }
      : { run_id: numericId(request.id, "run id") };
    await this.approve(options, `${request.action} job/run`, "control", body);
    return this.client.request(request.action === "start" ? "/api/2.2/jobs/run-now" : "/api/2.2/jobs/runs/cancel", {}, body, options.signal);
  }

  private async repair(request: Extract<DatabricksRequest, { kind: "repair" }>, options: ExecuteOptions) {
    required(request.evidence, "evidence");
    if (!request.tasks.length || request.tasks.some(task => !task.trim())) throw new Error("Select at least one task.");
    const body = {
      run_id: numericId(request.run_id, "run_id"),
      rerun_tasks: request.tasks,
      latest_repair_id: request.latest_repair_id ? numericId(request.latest_repair_id, "latest_repair_id") : undefined,
      rerun_dependent_tasks: request.rerun_dependent_tasks,
    };
    await this.approve(options, "repair run", "repair", { ...body, evidence: request.evidence });
    return this.client.request("/api/2.2/jobs/runs/repair", {}, body, options.signal);
  }
}
