export type ProviderName = "databricks";

export type OperationClass = "read" | "execute" | "control" | "repair";

export type ApprovalRequest = {
  provider: ProviderName;
  workspace: string;
  operation: string;
  operationClass: Exclude<OperationClass, "read">;
  payload: unknown;
  warning: string;
};

export interface ApprovalGate {
  confirm(request: ApprovalRequest): Promise<boolean>;
}

export type ExecuteOptions = {
  signal?: AbortSignal;
  approvalGate?: ApprovalGate;
};

export type WorkspaceCapabilities = {
  provider: ProviderName;
  mode: "read-only" | "interactive-mutations";
  operations: Array<{
    name: string;
    operationClass: OperationClass;
    available: boolean;
  }>;
};

export interface EtlWorkspaceAdapter<Request> {
  capabilities(): WorkspaceCapabilities;
  execute(request: Request, options?: ExecuteOptions): Promise<unknown>;
}

export async function requireApproval(gate: ApprovalGate | undefined, request: ApprovalRequest): Promise<void> {
  if (!gate) {
    throw new Error(`${request.operation} requires a tested interactive approval gate. This transport is read-only.`);
  }
  if (!await gate.confirm(request)) throw new Error("Execution declined. No request submitted.");
}

export type EtlToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    provider: ProviderName;
    workspace: string;
    status: "ok";
    truncated: boolean;
    data: unknown;
  };
  details: { truncated: boolean };
};

export function toolResult(provider: ProviderName, workspace: string, data: unknown, limit = 24_000): EtlToolResult {
  const fullEnvelope = { provider, workspace, status: "ok" as const, truncated: false, data };
  const serialized = JSON.stringify(fullEnvelope, null, 2);
  const truncated = serialized.length > limit;
  const envelope = truncated
    ? { provider, workspace, status: "ok" as const, truncated: true, data: { omitted: true, reason: "Result exceeded the structured output limit. Narrow the request or follow pagination." } }
    : fullEnvelope;
  const suffix = "\n[Output truncated; narrow the request or follow pagination.]";
  const text = truncated
    ? `${serialized.slice(0, Math.max(0, limit - suffix.length))}${suffix.slice(0, limit)}`.slice(0, limit)
    : serialized;
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope,
    details: { truncated },
  };
}

export function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown ETL tool failure.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
