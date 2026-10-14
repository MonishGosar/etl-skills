import { describeAirflow } from "./airflow-client.js";
import { dbtConfigured } from "./dbt-adapter.js";

export function readOnlyCapabilities(env: NodeJS.ProcessEnv = process.env) {
  const airflow = describeAirflow(env);
  return {
    mode: "read-only" as const,
    providers: [
      {
        provider: "databricks" as const,
        configured: Boolean(env.DATABRICKS_HOST && env.DATABRICKS_TOKEN),
        operations: ["inspect", "query_status"],
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
