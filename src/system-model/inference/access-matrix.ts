import type { App, Endpoint, SystemModel, TableOperation } from "../schema.ts";

export type Operation = TableOperation;
type Access = Map<string, Set<Operation>>;
/** Observed table operations and called integration IDs for one endpoint, or an app's union. */
export type Usage = { access: Access; integrations: Set<string> };
export type MatrixRow = Usage & { endpoint: Endpoint };
export type MatrixGroup = Usage & { app: App; endpoints: MatrixRow[] };

/** "any" matches any observed access, including unknown. */
export type ColumnFilter =
  | { kind: "table"; id: string; condition: Operation | "any" }
  | { kind: "integration"; id: string };

const emptyUsage = (): Usage => ({ access: new Map(), integrations: new Set() });
const operationPriority: Record<Operation, number> = { create: 3, delete: 3, update: 2, read: 1, join: 0, unknown: -1 };

function merge(access: Access, tableId: string, operations: Iterable<Operation>) {
  const combined = access.get(tableId) ?? new Set<Operation>();
  for (const operation of operations) combined.add(operation);
  access.set(tableId, combined);
}

/** Apply visibility and priority per endpoint before filtering and app aggregation. */
export function buildAccessMatrix(model: SystemModel, { showJoins = true, prioritize = false }: { showJoins?: boolean; prioritize?: boolean } = {}): MatrixGroup[] {
  const byEndpoint = new Map<string, Usage>();
  for (const relationship of model.relationships) {
    const usage = byEndpoint.get(relationship.endpointId) ?? emptyUsage();
    if (relationship.kind === "table-access") {
      const operations = relationship.operations.filter((operation) => showJoins || operation !== "join");
      if (operations.length) merge(usage.access, relationship.tableId, operations);
    } else usage.integrations.add(relationship.integrationId);
    byEndpoint.set(relationship.endpointId, usage);
  }
  if (prioritize) {
    for (const usage of byEndpoint.values()) {
      let highest = -1;
      for (const operations of usage.access.values()) {
        for (const operation of operations) highest = Math.max(highest, operationPriority[operation]);
      }
      for (const [tableId, operations] of usage.access) {
        for (const operation of operations) if (operationPriority[operation] < highest) operations.delete(operation);
        if (!operations.size) usage.access.delete(tableId);
      }
    }
  }
  const byApp = new Map<string, MatrixRow[]>();
  for (const endpoint of model.endpoints) {
    const endpoints = byApp.get(endpoint.appId) ?? [];
    endpoints.push({ endpoint, ...(byEndpoint.get(endpoint.id) ?? emptyUsage()) });
    byApp.set(endpoint.appId, endpoints);
  }
  return [...model.apps].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((app) => {
    const endpoints = (byApp.get(app.id) ?? []).sort((a, b) => a.endpoint.name.localeCompare(b.endpoint.name) || a.endpoint.id.localeCompare(b.endpoint.id));
    const usage = emptyUsage();
    for (const row of endpoints) {
      for (const [tableId, operations] of row.access) merge(usage.access, tableId, operations);
      for (const integrationId of row.integrations) usage.integrations.add(integrationId);
    }
    return { app, endpoints, ...usage };
  });
}

/** True when the usage satisfies every filter. */
export function matchesFilters(usage: Usage, filters: ColumnFilter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === "integration") return usage.integrations.has(filter.id);
    const operations = usage.access.get(filter.id);
    return filter.condition === "any" ? Boolean(operations?.size) : Boolean(operations?.has(filter.condition));
  });
}

/**
 * Keeps endpoints that match all column filters and whose name (or app name) contains the query.
 * Apps without matching endpoints are dropped, except endpoint-less apps matched by name when no
 * column filters are active. App aggregates are left unchanged.
 */
export function filterMatrix(groups: MatrixGroup[], { query = "", filters = [] }: { query?: string; filters?: ColumnFilter[] }): MatrixGroup[] {
  const needle = query.trim().toLowerCase();
  const contains = (name: string) => name.toLowerCase().includes(needle);
  return groups.flatMap((group) => {
    const appMatches = contains(group.app.name);
    const endpoints = group.endpoints.filter((row) => (appMatches || contains(row.endpoint.name)) && matchesFilters(row, filters));
    const keep = endpoints.length > 0 || (appMatches && filters.length === 0);
    return keep ? [{ ...group, endpoints }] : [];
  });
}

/** Table and integration IDs used by at least one endpoint in the given groups. */
export function usedColumns(groups: MatrixGroup[]): { tables: Set<string>; integrations: Set<string> } {
  const tables = new Set<string>();
  const integrations = new Set<string>();
  for (const { endpoints } of groups) {
    for (const row of endpoints) {
      for (const tableId of row.access.keys()) tables.add(tableId);
      for (const integrationId of row.integrations) integrations.add(integrationId);
    }
  }
  return { tables, integrations };
}

/** Compact cell label in a stable order, e.g. "RU" or "RJCUD". */
export function accessLabel(operations?: Set<Operation>): string {
  return ([ ["read", "R"], ["join", "J"], ["create", "C"], ["update", "U"], ["delete", "D"], ["unknown", "?"] ] as const)
    .filter(([operation]) => operations?.has(operation)).map(([, label]) => label).join("");
}
