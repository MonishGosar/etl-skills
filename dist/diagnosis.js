import { scrubSecrets } from "./redact.js";
export const IMPACT_LIMIT = 25;
export const ADDITIONAL_FAILURE_LIMIT = 10;
export const EXCERPT_LIMIT = 2_000;
export const LOG_TAIL_LIMIT = 64_000;
const NEXT_STEPS = {
    compilation: "Open the failing file cited in the excerpt and fix the compile error. Do not rerun until the project compiles.",
    database: "Compare the warehouse error with the failing node or task. Confirm the relation, schema, and SQL before rebuilding anything downstream.",
    test_failure: "Open the failing test and inspect the rows that violated it. Fix the upstream model or the test expectation before rebuilding downstream nodes.",
    permission: "Grant the missing privilege to the run identity, then rerun only the failed step after the grant is visible. Do not copy credentials into the brief or the chat.",
    timeout: "Check warehouse load and this step's runtime. Narrow the work or raise the timeout before retrying.",
    dependency: "Fix the earliest upstream failure. Downstream skips and upstream_failed tasks are effects of that failure.",
    configuration: "Check the dbt target, profile environment variables, or Airflow connection named in the excerpt. Confirm names and hosts without copying secret values.",
    resource: "Check executor memory, disk, and pool slots. A retry without more capacity is likely to fail the same way.",
    unknown: "Read the error excerpt and the cited artifact or task log. Treat the cause as unverified until a source line explains it.",
};
export function suggestedNextStep(category) {
    return NEXT_STEPS[category];
}
export function classifyFailure(input) {
    const text = input.message.toLowerCase();
    const status = (input.status ?? "").toLowerCase();
    if (/does not exist or not authorized|not authorized or does not exist/.test(text)) {
        return {
            category: "database",
            summary: "The warehouse could not find the object, or the run identity is not authorized to use it.",
            confidence: "medium",
        };
    }
    if (/(?:^|\n)\s*compilation error\b|parsing error|unknown macro|\bis undefined\b|syntax error in model/.test(text)) {
        return {
            category: "compilation",
            summary: "The project failed to compile before the warehouse finished the statement.",
            confidence: "high",
        };
    }
    if (/permission denied|access denied|not authorized|insufficient privileges|authorization failed/.test(text)) {
        return {
            category: "permission",
            summary: "The run identity is missing a grant or role required by this step.",
            confidence: "high",
        };
    }
    if (/timeout|timed out|statement timeout|deadline exceeded/.test(text)) {
        return { category: "timeout", summary: "The step exceeded its time limit.", confidence: "high" };
    }
    if (/out of memory|oomkilled|disk full|no space left|sigkill|sigterm|zombie task/.test(text)) {
        return {
            category: "resource",
            summary: "The worker ran out of memory, disk, or was killed before the step finished.",
            confidence: "high",
        };
    }
    if (/could not connect|connection refused|name or service not known|could not resolve|profiles\.yml|dbt profile|invalid profile|target named|authentication failed|login failed|modulenotfounderror|no module named|airflow connection/.test(text)) {
        return {
            category: "configuration",
            summary: "A connection, profile, target, or import required by this step is missing or unreachable.",
            confidence: "high",
        };
    }
    if (status === "fail" || (input.resourceType === "test" && /configured to fail|got \d+ results|failure in test/.test(text))) {
        return {
            category: "test_failure",
            summary: "A data test failed. The model or source returned rows that violate the test.",
            confidence: "high",
        };
    }
    if (status === "upstream_failed" || status === "skipped" || /upstream failure|skipped because of upstream/.test(text)) {
        return {
            category: "dependency",
            summary: "This step did not run because an upstream step failed.",
            confidence: "high",
        };
    }
    if (/database error|sql compilation error|relation .+ does not exist|object .+ does not exist|programmingerror|operationalerror/.test(text)) {
        return { category: "database", summary: "The warehouse rejected the statement.", confidence: "high" };
    }
    if (!input.message.trim()) {
        return {
            category: "unknown",
            summary: "The step failed without an error message in the available evidence.",
            confidence: "low",
        };
    }
    return {
        category: "unknown",
        summary: "The failure does not match a known cause category. Use the error excerpt as the evidence.",
        confidence: "low",
    };
}
export function boundText(text, limit) {
    if (text.length <= limit)
        return { text, truncated: false };
    const suffix = "\n[excerpt truncated]";
    return { text: `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`, truncated: true };
}
function focusLog(text) {
    const markers = [
        "Traceback (most recent call last)",
        "Compilation Error",
        "Database Error",
        "ERROR -",
        "Failure in test",
        "Error in model",
    ];
    let start = -1;
    for (const marker of markers) {
        const index = text.lastIndexOf(marker);
        if (index > start)
            start = index;
    }
    if (start < 0)
        return text;
    for (const marker of markers) {
        const covering = text.lastIndexOf(marker, start);
        if (covering >= 0 && covering <= start && covering + marker.length > start)
            start = covering;
    }
    return text.slice(start);
}
export function failureExcerpt(message, log, secrets) {
    const scrubbedMessage = scrubSecrets(message, secrets).trim();
    const tail = log && log.length > LOG_TAIL_LIMIT ? log.slice(log.length - LOG_TAIL_LIMIT) : log;
    const scrubbedLog = tail ? focusLog(scrubSecrets(tail, secrets).trim()) : "";
    const logUsed = Boolean(scrubbedLog) && !scrubbedMessage.includes(scrubbedLog.slice(0, Math.min(80, scrubbedLog.length)));
    const combined = [scrubbedMessage, logUsed ? scrubbedLog : ""].filter(Boolean).join("\n\n");
    const bounded = boundText(combined, EXCERPT_LIMIT);
    return {
        excerpt: bounded.text,
        truncated: bounded.truncated || Boolean(log && log.length > LOG_TAIL_LIMIT),
        logUsed,
    };
}
export function capRefs(refs, limit = IMPACT_LIMIT) {
    return { refs: refs.slice(0, limit), truncated: refs.length > limit };
}
export function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    return undefined;
}
export function stringField(record, key) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}
export function stringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
