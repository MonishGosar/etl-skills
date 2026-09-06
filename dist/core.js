export async function requireApproval(gate, request) {
    if (!gate) {
        throw new Error(`${request.operation} requires a tested interactive approval gate. This transport is read-only.`);
    }
    if (!await gate.confirm(request))
        throw new Error("Execution declined. No request submitted.");
}
export function toolResult(provider, workspace, data, limit = 24_000) {
    const fullEnvelope = { provider, workspace, status: "ok", truncated: false, data };
    const serialized = JSON.stringify(fullEnvelope, null, 2);
    const truncated = serialized.length > limit;
    const envelope = truncated
        ? { provider, workspace, status: "ok", truncated: true, data: { omitted: true, reason: "Result exceeded the structured output limit. Narrow the request or follow pagination." } }
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
export function toolError(error) {
    const message = error instanceof Error ? error.message : "Unknown ETL tool failure.";
    return { content: [{ type: "text", text: message }], isError: true };
}
