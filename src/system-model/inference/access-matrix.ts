import type { App, Endpoint, Relationship, SystemModel } from "../schema.ts";

type Operation = Extract<Relationship, { kind: "table-access" }>["operations"][number];
type Access = Map<string, Set<Operation>>;
export type MatrixGroup = { app: App; access: Access; endpoints: { endpoint: Endpoint; access: Access }[] };

function merge(access: Access, tableId: string, operations: Iterable<Operation>) {
  const combined = access.get(tableId) ?? new Set<Operation>();
  for (const operation of operations) combined.add(operation);
  access.set(tableId, combined);
}

/** App cells are the union of all endpoint operations, including unknown access. */
export function buildAccessMatrix(model: SystemModel): MatrixGroup[] {
  const byEndpoint = new Map<string, Access>();
  for (const relationship of model.relationships) {
    if (relationship.kind !== "table-access") continue;
    const access = byEndpoint.get(relationship.endpointId) ?? new Map();
    merge(access, relationship.tableId, relationship.operations);
    byEndpoint.set(relationship.endpointId, access);
  }
  const byApp = new Map<string, MatrixGroup["endpoints"]>();
  for (const endpoint of model.endpoints) {
    const endpoints = byApp.get(endpoint.appId) ?? [];
    endpoints.push({ endpoint, access: byEndpoint.get(endpoint.id) ?? new Map() });
    byApp.set(endpoint.appId, endpoints);
  }
  return [...model.apps].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((app) => {
    const endpoints = (byApp.get(app.id) ?? []).sort((a, b) => a.endpoint.name.localeCompare(b.endpoint.name) || a.endpoint.id.localeCompare(b.endpoint.id));
    const access: Access = new Map();
    for (const row of endpoints) {
      for (const [tableId, operations] of row.access) merge(access, tableId, operations);
    }
    return { app, endpoints, access };
  });
}

export function accessLabel(operations?: Set<Operation>): string {
  return ([ ["read", "R"], ["write", "W"], ["unknown", "?"] ] as const)
    .filter(([operation]) => operations?.has(operation)).map(([, label]) => label).join(", ");
}
