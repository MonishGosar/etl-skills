import { DatabricksClient, DatabricksHttpError, numericId } from "./client.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const MAX_EDGES = 25;
const MAX_GRANT_OBJECTS = 8;
const MAX_ASSIGNMENTS = 25;
const MAX_PRIVILEGES = 20;
const GRANT_PAGE = 150;
const WINDOW_DAYS = 30;

export const TABLE_LINEAGE_SQL = `
SELECT direction, table_name, table_type, entity_type, entity_id, latest_event_time
FROM (
  SELECT 'upstream' AS direction,
         source_table_full_name AS table_name,
         source_type AS table_type,
         entity_type,
         entity_id,
         CAST(MAX(event_time) AS STRING) AS latest_event_time
  FROM system.access.table_lineage
  WHERE target_table_full_name = :lineage_table
    AND source_table_full_name IS NOT NULL
    AND event_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
  GROUP BY source_table_full_name, source_type, entity_type, entity_id
  UNION ALL
  SELECT 'downstream' AS direction,
         target_table_full_name AS table_name,
         target_type AS table_type,
         entity_type,
         entity_id,
         CAST(MAX(event_time) AS STRING) AS latest_event_time
  FROM system.access.table_lineage
  WHERE source_table_full_name = :lineage_table
    AND target_table_full_name IS NOT NULL
    AND event_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
  GROUP BY target_table_full_name, target_type, entity_type, entity_id
) AS lineage_edges
ORDER BY direction, table_name
LIMIT 50`.trim();

export const COLUMN_LINEAGE_SQL = `
SELECT direction, table_name, column_name, entity_type, entity_id
FROM (
  SELECT 'upstream' AS direction,
         source_table_full_name AS table_name,
         source_column_name AS column_name,
         entity_type,
         entity_id
  FROM system.access.column_lineage
  WHERE target_table_full_name = :lineage_table
    AND target_column_name = :lineage_column
    AND source_table_full_name IS NOT NULL
    AND event_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
  GROUP BY source_table_full_name, source_column_name, entity_type, entity_id
  UNION ALL
  SELECT 'downstream' AS direction,
         target_table_full_name AS table_name,
         target_column_name AS column_name,
         entity_type,
         entity_id
  FROM system.access.column_lineage
  WHERE source_table_full_name = :lineage_table
    AND source_column_name = :lineage_column
    AND target_table_full_name IS NOT NULL
    AND event_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
  GROUP BY target_table_full_name, target_column_name, entity_type, entity_id
) AS column_edges
ORDER BY direction, table_name, column_name
LIMIT 50`.trim();

export const BILLING_COST_SQL = `
SELECT usage_date, sku_name, usage_unit,
       CAST(SUM(usage_quantity) AS STRING) AS usage_quantity,
       CAST(SUM(usage_quantity * list_price) AS STRING) AS list_cost,
       MAX(currency_code) AS currency_code
FROM (
  SELECT u.usage_date, u.sku_name, u.usage_unit, u.usage_quantity,
         lp.pricing.effective_list.default AS list_price,
         lp.currency_code
  FROM system.billing.usage AS u
  LEFT JOIN system.billing.list_prices AS lp
    ON u.cloud = lp.cloud
   AND u.sku_name = lp.sku_name
   AND u.usage_start_time >= lp.price_start_time
   AND (lp.price_end_time IS NULL OR u.usage_end_time <= lp.price_end_time)
  WHERE u.usage_metadata.job_id = :job_id
    AND u.usage_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
) AS priced_usage
GROUP BY usage_date, sku_name, usage_unit
ORDER BY usage_date DESC
LIMIT 100`.trim();

export const BILLING_USAGE_SQL = `
SELECT usage_date, sku_name, usage_unit,
       CAST(SUM(usage_quantity) AS STRING) AS usage_quantity
FROM system.billing.usage
WHERE usage_metadata.job_id = :job_id
  AND usage_date >= CURRENT_DATE() - INTERVAL ${WINDOW_DAYS} DAY
GROUP BY usage_date, sku_name, usage_unit
ORDER BY usage_date DESC
LIMIT 100`.trim();

export type LineageNode = {
  table: string;
  table_type?: string;
  latest_event_time?: string;
  entities?: Array<{ type: string; id: string }>;
  file_count?: number;
};

export type ColumnLineageNode = {
  table?: string;
  column: string;
};

type ColumnLineage = {
  available: boolean;
  source?: "lineage-api" | "system.access";
  reason?: string;
  upstreams: ColumnLineageNode[];
  downstreams: ColumnLineageNode[];
  truncated?: boolean;
  window_days?: number;
  statement_id?: string;
  attempts?: Array<{ source: string; reason: string }>;
};

export type UnityCatalogContext = {
  table: string;
  column?: string;
  lineage: {
    available: boolean;
    source?: "lineage-api" | "system.access";
    reason?: string;
    upstreams: LineageNode[];
    downstreams: LineageNode[];
    truncated?: boolean;
    omitted_edges?: number;
    window_days?: number;
    attempts?: Array<{ source: string; reason: string }>;
    column?: ColumnLineage;
  };
  grants_limited: boolean;
  grants: Array<{
    object: string;
    securable_type: "TABLE";
    available: boolean;
    reason?: string;
    attempts?: Array<{ source: string; reason: string }>;
    assignments?: Array<{ principal: string; privileges: string[] }>;
    grants_reason?: string;
    effective?: Array<{ principal: string; privileges: Array<{ privilege: string; inherited_from_type?: string; inherited_from_name?: string }> }>;
    effective_reason?: string;
    truncated?: boolean;
  }>;
  job_cost: {
    available: boolean;
    reason?: string;
    source?: "system.billing.usage";
    job_id?: string;
    window_days?: number;
    list_price_available?: boolean;
    list_price_reason?: string;
    currency_code?: string | null;
    rows?: Array<Record<string, string | null>>;
    statement_id?: string;
    truncated?: boolean;
    note?: string;
    attempts?: Array<{ source: string; reason: string }>;
  };
};

export function parseTableName(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 3 || parts.some(part => !IDENT.test(part))) {
    throw new Error("table must be a catalog.schema.table name made of letters, numbers, and underscores.");
  }
  return parts.join(".");
}

export function parseColumnName(value: string): string {
  const name = value.trim();
  if (!IDENT.test(name)) throw new Error("column must contain only letters, numbers, and underscores.");
  return name;
}

function safeTable(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return parseTableName(value); } catch { return undefined; }
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return undefined;
  return trimmed;
}

function tableNameFromInfo(info: unknown): { table?: string; table_type?: string } {
  if (!info || typeof info !== "object") return {};
  const record = info as Record<string, unknown>;
  const nested = record.tableInfo ?? record.table_info;
  const source = nested && typeof nested === "object" ? nested as Record<string, unknown> : record;
  const catalog = stringField(source, "catalog_name") ?? stringField(source, "catalog");
  const schema = stringField(source, "schema_name") ?? stringField(source, "schema");
  const name = stringField(source, "name") ?? stringField(source, "table_name");
  const full = stringField(source, "table_full_name") ?? stringField(source, "full_name");
  const tableType = stringField(source, "table_type") ?? stringField(source, "tableType");
  const table = catalog && schema && name && !name.includes(".")
    ? safeTable(`${catalog}.${schema}.${name}`)
    : safeTable(full) ?? (name ? safeTable(name) : undefined);
  return { table, table_type: tableType };
}

function entitiesFrom(record: Record<string, unknown>): Array<{ type: string; id: string }> {
  const groups: Array<[string, string, string]> = [
    ["jobInfos", "job", "job_id"],
    ["job_infos", "job", "job_id"],
    ["notebookInfos", "notebook", "notebook_id"],
    ["notebook_infos", "notebook", "notebook_id"],
    ["pipelineInfos", "pipeline", "pipeline_id"],
    ["pipeline_infos", "pipeline", "pipeline_id"],
    ["dashboardInfos", "dashboard", "dashboard_id"],
    ["queryInfos", "query", "query_id"],
  ];
  const entities: Array<{ type: string; id: string }> = [];
  for (const [key, type, idKey] of groups) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const id = stringField(entry, idKey);
      if (id && id.length <= 128) entities.push({ type, id });
      if (entities.length >= 5) return entities;
    }
  }
  return entities;
}

export function normalizeTableLineage(payload: unknown): { upstreams: LineageNode[]; downstreams: LineageNode[]; omitted_edges: number; truncated: boolean } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const upstream = normalizeEdges(record.upstreams);
  const downstream = normalizeEdges(record.downstreams);
  return {
    upstreams: upstream.nodes.slice(0, MAX_EDGES),
    downstreams: downstream.nodes.slice(0, MAX_EDGES),
    omitted_edges: upstream.omitted + downstream.omitted,
    truncated: upstream.nodes.length > MAX_EDGES || downstream.nodes.length > MAX_EDGES,
  };
}

function normalizeEdges(value: unknown): { nodes: LineageNode[]; omitted: number } {
  if (!Array.isArray(value)) return { nodes: [], omitted: 0 };
  const nodes: LineageNode[] = [];
  let omitted = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") { omitted += 1; continue; }
    const record = entry as Record<string, unknown>;
    const { table, table_type: tableType } = tableNameFromInfo(record);
    if (!table) { omitted += 1; continue; }
    const node: LineageNode = { table };
    if (tableType) node.table_type = tableType;
    const entities = entitiesFrom(record);
    if (entities.length) node.entities = entities;
    const files = record.fileInfos ?? record.file_infos;
    if (Array.isArray(files) && files.length) node.file_count = files.length;
    const eventTime = stringField(record, "latest_event_time") ?? stringField(record, "event_time");
    if (eventTime) node.latest_event_time = eventTime;
    nodes.push(node);
  }
  return { nodes, omitted };
}

export function normalizeColumnLineage(payload: unknown): { upstreams: ColumnLineageNode[]; downstreams: ColumnLineageNode[]; truncated: boolean } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const upstreams = columnEdges(record.upstream_cols ?? record.upstreams);
  const downstreams = columnEdges(record.downstream_cols ?? record.downstreams);
  return {
    upstreams: upstreams.slice(0, MAX_EDGES),
    downstreams: downstreams.slice(0, MAX_EDGES),
    truncated: upstreams.length > MAX_EDGES || downstreams.length > MAX_EDGES,
  };
}

function columnEdges(value: unknown): ColumnLineageNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: ColumnLineageNode[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const column = stringField(record, "column_name") ?? stringField(record, "name");
    if (!column || !IDENT.test(column)) continue;
    const catalog = stringField(record, "catalog_name");
    const schema = stringField(record, "schema_name");
    const tablePart = stringField(record, "table_name");
    const table = catalog && schema && tablePart ? safeTable(`${catalog}.${schema}.${tablePart}`) : undefined;
    nodes.push(table ? { table, column } : { column });
  }
  return nodes;
}

function reasonFromError(error: unknown): string {
  if (error instanceof DatabricksHttpError) {
    if (error.status === 401 || error.status === 403) return "not permitted";
    if (error.status === 404) return "not found";
  }
  return "request failed";
}

type StatementOutcome = {
  ok: boolean;
  reason?: string;
  rows: string[][];
  truncated: boolean;
  statementId?: string;
};

function cell(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function statementFailureReason(payload: Record<string, unknown>): string {
  const status = payload.status && typeof payload.status === "object" ? payload.status as Record<string, unknown> : {};
  const error = status.error && typeof status.error === "object" ? status.error as Record<string, unknown> : {};
  const code = String(error.error_code ?? "");
  const sqlState = String(error.sql_state ?? "");
  const message = String(error.message ?? "");
  if (code === "UNAUTHENTICATED" || sqlState === "42501" || /permission|not authorized|unauthorized|access denied|insufficient/i.test(message)) return "not permitted";
  if (code === "NOT_FOUND" || sqlState === "42P01" || /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|not found/i.test(message)) return "not found";
  return "query failed";
}

async function executeFixedStatement(client: DatabricksClient, statement: string, parameters: Array<{ name: string; value: string; type: string }>, tag: string, signal?: AbortSignal): Promise<StatementOutcome> {
  const warehouse = client.config.warehouse;
  if (!warehouse) return { ok: false, reason: "DATABRICKS_WAREHOUSE_ID is not set", rows: [], truncated: false };
  let payload: unknown;
  try {
    payload = await client.request("/api/2.0/sql/statements", {}, {
      warehouse_id: warehouse,
      statement,
      parameters,
      wait_timeout: "10s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      row_limit: 100,
      byte_limit: 16_000,
      query_tags: [{ key: "etl_agent_tools", value: tag }],
    }, signal);
  } catch (error) {
    return { ok: false, reason: reasonFromError(error), rows: [], truncated: false };
  }
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const statementId = typeof body.statement_id === "string" ? body.statement_id : undefined;
  const status = body.status && typeof body.status === "object" ? body.status as Record<string, unknown> : {};
  const state = String(status.state ?? "");
  if (state === "PENDING" || state === "RUNNING") return { ok: false, reason: "query did not finish", rows: [], truncated: false, statementId };
  if (state !== "SUCCEEDED" && state !== "CLOSED") return { ok: false, reason: statementFailureReason(body), rows: [], truncated: false, statementId };
  const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
  if (Array.isArray(result.external_links) && result.external_links.length) {
    return { ok: false, reason: "result was not returned inline", rows: [], truncated: false, statementId };
  }
  const rawRows = Array.isArray(result.data_array) ? result.data_array : [];
  const rows = rawRows.map(row => Array.isArray(row) ? row.map(value => cell(value) ?? "") : []);
  const manifest = body.manifest && typeof body.manifest === "object" ? body.manifest as Record<string, unknown> : {};
  return { ok: true, rows, truncated: manifest.truncated === true, statementId };
}

function nodesFromSystemRows(rows: string[][]): { upstreams: LineageNode[]; downstreams: LineageNode[]; truncated: boolean } {
  const upstreams: LineageNode[] = [];
  const downstreams: LineageNode[] = [];
  for (const row of rows) {
    const direction = row[0];
    const table = safeTable(row[1]);
    if (!table || (direction !== "upstream" && direction !== "downstream")) continue;
    const node: LineageNode = { table };
    if (row[2]) node.table_type = row[2];
    if (row[3] && row[4]) node.entities = [{ type: row[3].toLowerCase().slice(0, 64), id: row[4].slice(0, 128) }];
    if (row[5]) node.latest_event_time = row[5];
    const target = direction === "upstream" ? upstreams : downstreams;
    const existing = target.find(item => item.table === table && item.table_type === node.table_type);
    if (existing && node.entities) existing.entities = [...(existing.entities ?? []), ...node.entities].slice(0, 5);
    else if (!existing) target.push(node);
  }
  return {
    upstreams: upstreams.slice(0, MAX_EDGES),
    downstreams: downstreams.slice(0, MAX_EDGES),
    truncated: upstreams.length > MAX_EDGES || downstreams.length > MAX_EDGES || rows.length >= 50,
  };
}

function columnNodesFromSystemRows(rows: string[][]): { upstreams: ColumnLineageNode[]; downstreams: ColumnLineageNode[]; truncated: boolean } {
  const upstreams: ColumnLineageNode[] = [];
  const downstreams: ColumnLineageNode[] = [];
  for (const row of rows) {
    const direction = row[0];
    const column = row[2];
    if (!column || !IDENT.test(column) || (direction !== "upstream" && direction !== "downstream")) continue;
    const table = safeTable(row[1]);
    const node: ColumnLineageNode = table ? { table, column } : { column };
    (direction === "upstream" ? upstreams : downstreams).push(node);
  }
  return {
    upstreams: upstreams.slice(0, MAX_EDGES),
    downstreams: downstreams.slice(0, MAX_EDGES),
    truncated: upstreams.length > MAX_EDGES || downstreams.length > MAX_EDGES || rows.length >= 50,
  };
}

async function readColumnLineage(client: DatabricksClient, table: string, column: string, signal?: AbortSignal): Promise<ColumnLineage> {
  const attempts: Array<{ source: string; reason: string }> = [];
  try {
    const payload = await client.request("/api/2.0/lineage-tracking/column-lineage", { table_name: table, column_name: column }, undefined, signal);
    const normalized = normalizeColumnLineage(payload);
    return { available: true, source: "lineage-api", ...normalized };
  } catch (error) {
    attempts.push({ source: "lineage-api", reason: reasonFromError(error) });
  }
  if (!client.config.warehouse) {
    attempts.push({ source: "system.access", reason: "DATABRICKS_WAREHOUSE_ID is not set" });
    return { available: false, reason: attempts[0]?.reason ?? "request failed", upstreams: [], downstreams: [], attempts };
  }
  const sql = await executeFixedStatement(client, COLUMN_LINEAGE_SQL, [
    { name: "lineage_table", value: table, type: "STRING" },
    { name: "lineage_column", value: column, type: "STRING" },
  ], "column_lineage", signal);
  if (!sql.ok) {
    attempts.push({ source: "system.access", reason: sql.reason ?? "query failed" });
    return { available: false, reason: sql.reason ?? "query failed", upstreams: [], downstreams: [], attempts, ...(sql.statementId ? { statement_id: sql.statementId } : {}) };
  }
  const normalized = columnNodesFromSystemRows(sql.rows);
  return { available: true, source: "system.access", window_days: WINDOW_DAYS, truncated: normalized.truncated || sql.truncated, upstreams: normalized.upstreams, downstreams: normalized.downstreams };
}

async function readLineage(client: DatabricksClient, table: string, column: string | undefined, signal?: AbortSignal): Promise<UnityCatalogContext["lineage"]> {
  const attempts: Array<{ source: string; reason: string }> = [];
  try {
    const payload = await client.request("/api/2.0/lineage-tracking/table-lineage", {
      table_name: table,
      include_entity_lineage: "true",
    }, undefined, signal);
    const normalized = normalizeTableLineage(payload);
    const columnLineage = column ? await readColumnLineage(client, table, column, signal) : undefined;
    return {
      available: true,
      source: "lineage-api",
      upstreams: normalized.upstreams,
      downstreams: normalized.downstreams,
      truncated: normalized.truncated,
      ...(normalized.omitted_edges ? { omitted_edges: normalized.omitted_edges } : {}),
      ...(columnLineage ? { column: columnLineage } : {}),
    };
  } catch (error) {
    attempts.push({ source: "lineage-api", reason: reasonFromError(error) });
  }
  if (!client.config.warehouse) {
    attempts.push({ source: "system.access", reason: "DATABRICKS_WAREHOUSE_ID is not set" });
    return {
      available: false,
      reason: attempts[0]?.reason ?? "request failed",
      upstreams: [],
      downstreams: [],
      attempts,
      ...(column ? { column: { available: false, reason: attempts[0]?.reason ?? "request failed", upstreams: [], downstreams: [], attempts } } : {}),
    };
  }
  const sql = await executeFixedStatement(client, TABLE_LINEAGE_SQL, [
    { name: "lineage_table", value: table, type: "STRING" },
  ], "table_lineage", signal);
  if (!sql.ok) {
    attempts.push({ source: "system.access", reason: sql.reason ?? "query failed" });
    return {
      available: false,
      reason: sql.reason,
      upstreams: [],
      downstreams: [],
      attempts,
      ...(column ? { column: { available: false, reason: sql.reason, upstreams: [], downstreams: [], attempts } } : {}),
    };
  }
  const normalized = nodesFromSystemRows(sql.rows);
  const columnLineage = column ? await readColumnLineage(client, table, column, signal) : undefined;
  return {
    available: true,
    source: "system.access",
    window_days: WINDOW_DAYS,
    upstreams: normalized.upstreams,
    downstreams: normalized.downstreams,
    truncated: normalized.truncated || sql.truncated,
    ...(columnLineage ? { column: columnLineage } : {}),
  };
}

function privilegeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) names.push(item.trim());
    else if (item && typeof item === "object" && typeof (item as { privilege?: unknown }).privilege === "string") {
      names.push((item as { privilege: string }).privilege);
    }
    if (names.length >= MAX_PRIVILEGES) break;
  }
  return names;
}

function pageTruncated(payload: unknown, shown: number, total: number): boolean {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return typeof record.next_page_token === "string" || shown < total;
}

function normalizeAssignments(payload: unknown): { assignments: Array<{ principal: string; privileges: string[] }>; truncated: boolean } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(record.privilege_assignments) ? record.privilege_assignments : [];
  const assignments: Array<{ principal: string; privileges: string[] }> = [];
  for (const entry of raw) {
    const principal = stringField(entry, "principal");
    if (!principal) continue;
    assignments.push({ principal, privileges: privilegeNames((entry as { privileges?: unknown }).privileges) });
  }
  return { assignments: assignments.slice(0, MAX_ASSIGNMENTS), truncated: pageTruncated(payload, Math.min(assignments.length, MAX_ASSIGNMENTS), assignments.length) };
}

function normalizeEffective(payload: unknown): { effective: UnityCatalogContext["grants"][number]["effective"]; truncated: boolean } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(record.privilege_assignments) ? record.privilege_assignments : [];
  const effective: NonNullable<UnityCatalogContext["grants"][number]["effective"]> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const principal = stringField(entry, "principal");
    if (!principal) continue;
    const privilegesRaw = (entry as { privileges?: unknown }).privileges;
    const privileges: Array<{ privilege: string; inherited_from_type?: string; inherited_from_name?: string }> = [];
    if (Array.isArray(privilegesRaw)) {
      for (const item of privilegesRaw) {
        if (typeof item === "string") privileges.push({ privilege: item });
        else if (item && typeof item === "object" && typeof (item as { privilege?: unknown }).privilege === "string") {
          const privilege = (item as { privilege: string }).privilege;
          const inheritedType = stringField(item, "inherited_from_type");
          const inheritedName = stringField(item, "inherited_from_name");
          privileges.push({
            privilege,
            ...(inheritedType ? { inherited_from_type: inheritedType } : {}),
            ...(inheritedName ? { inherited_from_name: inheritedName } : {}),
          });
        }
        if (privileges.length >= MAX_PRIVILEGES) break;
      }
    }
    effective.push({ principal, privileges });
    if (effective.length >= MAX_ASSIGNMENTS) break;
  }
  return { effective, truncated: pageTruncated(payload, effective.length, raw.length) };
}

async function readGrants(client: DatabricksClient, objectName: string, signal?: AbortSignal): Promise<UnityCatalogContext["grants"][number]> {
  try {
    const encoded = objectName.split(".").map(part => encodeURIComponent(part)).join(".");
    const query = { max_results: GRANT_PAGE };
    const [grants, effective] = await Promise.all([
      client.request(`/api/2.1/unity-catalog/permissions/TABLE/${encoded}`, query, undefined, signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, reason: reasonFromError(error) })),
      client.request(`/api/2.1/unity-catalog/effective-permissions/TABLE/${encoded}`, query, undefined, signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, reason: reasonFromError(error) })),
    ]);
    if (!grants.ok && !effective.ok) {
      return {
        object: objectName,
        securable_type: "TABLE",
        available: false,
        reason: grants.reason,
        attempts: [
          { source: "grants", reason: grants.reason },
          { source: "effective-permissions", reason: effective.reason },
        ],
      };
    }
    const assignments = grants.ok ? normalizeAssignments(grants.value) : undefined;
    const effectivePrivileges = effective.ok ? normalizeEffective(effective.value) : undefined;
    return {
      object: objectName,
      securable_type: "TABLE",
      available: true,
      ...(assignments ? { assignments: assignments.assignments } : {}),
      ...(!grants.ok ? { grants_reason: grants.reason } : {}),
      ...(effectivePrivileges ? { effective: effectivePrivileges.effective } : {}),
      ...(!effective.ok ? { effective_reason: effective.reason } : {}),
      truncated: Boolean(assignments?.truncated || effectivePrivileges?.truncated),
    };
  } catch {
    return { object: objectName, securable_type: "TABLE", available: false, reason: "request failed" };
  }
}

function grantTargets(table: string, lineage: UnityCatalogContext["lineage"]): { objects: string[]; limited: boolean } {
  const related: string[] = [];
  for (const node of [...lineage.upstreams, ...lineage.downstreams]) {
    const name = safeTable(node.table);
    if (name && name !== table && !related.includes(name)) related.push(name);
  }
  const objects = [table, ...related];
  return { objects: objects.slice(0, MAX_GRANT_OBJECTS), limited: objects.length > MAX_GRANT_OBJECTS };
}

function costRows(rows: string[][], withPrice: boolean): Array<Record<string, string | null>> {
  return rows.map(row => {
    const record: Record<string, string | null> = {
      usage_date: row[0] || null,
      sku_name: row[1] || null,
      usage_unit: row[2] || null,
      usage_quantity: row[3] || null,
    };
    if (withPrice) {
      record.list_cost = row[4] || null;
      record.currency_code = row[5] || null;
    }
    return record;
  });
}

async function readJobCost(client: DatabricksClient, jobId: string | undefined, signal?: AbortSignal): Promise<UnityCatalogContext["job_cost"]> {
  if (!jobId) return { available: false, reason: "not requested" };
  if (!client.config.warehouse) return { available: false, reason: "DATABRICKS_WAREHOUSE_ID is not set", job_id: jobId };
  const parameters = [{ name: "job_id", value: jobId, type: "STRING" }];
  const priced = await executeFixedStatement(client, BILLING_COST_SQL, parameters, "job_cost", signal);
  if (priced.ok) {
    const rows = costRows(priced.rows, true);
    return {
      available: true,
      source: "system.billing.usage",
      job_id: jobId,
      window_days: WINDOW_DAYS,
      list_price_available: true,
      currency_code: rows.find(row => row.currency_code)?.currency_code ?? null,
      rows,
      ...(priced.statementId ? { statement_id: priced.statementId } : {}),
      truncated: priced.truncated,
      note: "list_cost uses the published list price (pricing.effective_list.default), which can differ from the invoiced amount.",
    };
  }
  if (priced.reason === "query did not finish" || priced.reason === "result was not returned inline" || priced.reason === "request failed") {
    return { available: false, reason: priced.reason, job_id: jobId, ...(priced.statementId ? { statement_id: priced.statementId } : {}) };
  }
  const usage = await executeFixedStatement(client, BILLING_USAGE_SQL, parameters, "job_usage", signal);
  if (!usage.ok) {
    return {
      available: false,
      reason: usage.reason,
      job_id: jobId,
      ...(usage.statementId ? { statement_id: usage.statementId } : {}),
      attempts: [
        { source: "system.billing.usage+list_prices", reason: priced.reason ?? "query failed" },
        { source: "system.billing.usage", reason: usage.reason ?? "query failed" },
      ],
    };
  }
  return {
    available: true,
    source: "system.billing.usage",
    job_id: jobId,
    window_days: WINDOW_DAYS,
    list_price_available: false,
    list_price_reason: priced.reason,
    rows: costRows(usage.rows, false),
    ...(usage.statementId ? { statement_id: usage.statementId } : {}),
    truncated: usage.truncated,
    note: "Usage quantity is in Databricks units. List price was not included.",
  };
}

export async function readUnityCatalogContext(client: DatabricksClient, request: { table: string; column?: string; job_id?: string }, signal?: AbortSignal): Promise<UnityCatalogContext> {
  const table = parseTableName(request.table);
  const column = request.column === undefined ? undefined : parseColumnName(request.column);
  const jobId = request.job_id === undefined ? undefined : String(numericId(request.job_id, "job_id"));
  const lineage = await readLineage(client, table, column, signal);
  const targets = grantTargets(table, lineage);
  const grants = await Promise.all(targets.objects.map(objectName => readGrants(client, objectName, signal)));
  const job_cost = await readJobCost(client, jobId, signal);
  return { table, ...(column ? { column } : {}), lineage, grants_limited: targets.limited, grants, job_cost };
}

