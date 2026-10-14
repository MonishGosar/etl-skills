import { describeAirflow } from "./airflow-client.js";
import { configFromEnv, databricksConfigured } from "./client.js";
import { dbtConfigured } from "./dbt-adapter.js";

function databricksAuth(env: NodeJS.ProcessEnv): "pat" | "oauth-m2m" | "unconfigured" {
  if (!databricksConfigured(env)) return "unconfigured";
  return configFromEnv(env).auth ?? "unconfigured";
}

export function readOnlyCapabilities(env: NodeJS.ProcessEnv = process.env) {
  const airflow = describeAirflow(env);
  return {
    mode: "read-only" as const,
    providers: [
      {
        provider: "databricks" as const,
        configured: databricksConfigured(env),
        auth: databricksAuth(env),
        operations: ["inspect", "query_status", "uc_context"],
        unavailableMutations: ["query_execute", "query_cancel", "pipeline_control", "job_control", "job_repair"],
      },
      {
        provider: "dbt" as const,
        configured: dbtConfigured(env),
        operations: ["inspect", "diagnose"],
        unavailableMutations: ["run", "build", "test", "retry"],
      },
      {
        provider: "airflow" as const,
        configured: airflow.configured,
        apiVersion: airflow.apiVersion,
        authMode: airflow.authMode,
        operations: ["inspect", "diagnose"],
        unavailableMutations: ["trigger", "clear", "retry", "pause", "backfill"],
      },
    ],
  };
}
