const SECRET_ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|client[_-]?secret)\b(\s*[:=]\s*)(["']?)([^\s"',}]+)/gi;
const PATTERNS = [
    { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "Bearer [REDACTED]" },
    { pattern: /Basic\s+[A-Za-z0-9+/=]{8,}/gi, replace: "Basic [REDACTED]" },
    { pattern: SECRET_ASSIGNMENT, replace: "$1$2$3[REDACTED]" },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED]" },
    { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "[REDACTED]" },
    { pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|snowflake|databricks|redis|amqp):\/\/[^:\s/@]+:[^@\s]+@/gi, replace: "[REDACTED_URL]" },
];
export function secretsFromEnv(env = process.env) {
    return [
        env.DATABRICKS_TOKEN,
        env.DATABRICKS_CLIENT_SECRET,
        env.AIRFLOW_TOKEN,
        env.AIRFLOW_PASSWORD,
        env.DBT_CLOUD_TOKEN,
        env.SNOWFLAKE_PASSWORD,
        env.SNOWFLAKE_OAUTH_TOKEN,
    ].filter((value) => Boolean(value && value.length >= 6));
}
export function scrubSecrets(text, extraSecrets = []) {
    let output = text;
    const unique = [...new Set(extraSecrets.filter(secret => secret.length >= 6))];
    unique.sort((left, right) => right.length - left.length);
    for (const secret of unique)
        output = output.split(secret).join("[REDACTED]");
    for (const { pattern, replace } of PATTERNS)
        output = output.replace(pattern, replace);
    return output;
}
