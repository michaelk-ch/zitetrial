import type { CallGraph, SystemModel } from "../system-snapshot/system-model.ts";
import type { Usage } from "../system-snapshot/interpretation.ts";
import type { EndpointResponse } from "./responses.ts";
import { roles } from "../system-snapshot/interpretation.ts";

type CallNode = CallGraph["nodes"][number];
const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

/** Compact AI input plus lossless references back to the analyzed snapshot. No source reads. */
export function prepareInterpretation(model: SystemModel) {
  const apps = sorted(model.apps).map((app, i) => ({ ref: `a${i + 1}`, ...app }));
  const targets = [
    ...sorted(model.tables).map((table, i) => ({ ref: `t${i + 1}`, kind: "table" as const, ...table })),
    ...sorted(model.integrations).map((integration, i) => ({ ref: `i${i + 1}`, kind: "integration" as const, ...integration })),
  ];
  const nodes = new Map(model.callGraph.nodes.map((node) => [node.id, node]));
  const functions = new Map(sorted(model.callGraph.nodes).map((node, i) => [node.id, { ref: `f${i + 1}`, node }]));
  const usages: Usage[] = [];
  const endpoints = sorted(model.endpoints).map((endpoint, i) => {
    const endpointUsages: Usage[] = [];
    const addBranch = (entryNodeId: string, branchCallIndex: number | null) => {
      const entry = nodes.get(entryNodeId)!;
      const first = branchCallIndex === null ? entry : nodes.get(entry.calls[branchCallIndex].nodeId)!;
      const queue = [{ node: first, path: branchCallIndex === null ? [entry.id] : [entry.id, first.id] }];
      const visited = new Set<string>();
      const groups = new Map<string, Usage>();
      for (let i = 0; i < queue.length; i++) {
        const { node, path } = queue[i];
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        node.accesses.forEach((access, accessIndex) => {
          const target = access.kind === "table-access" ? { kind: "table" as const, id: access.tableId }
            : { kind: "integration" as const, id: access.integrationId };
          const operation = access.kind === "table-access" ? access.operation : null;
          const key = JSON.stringify([target, operation]);
          let usage = groups.get(key);
          if (!usage) {
            usage = { id: `u${usages.length + 1}`, endpointId: endpoint.id, target, operation,
              entryNodeId, branchCallIndex, sources: [], paths: [] };
            groups.set(key, usage);
            usages.push(usage);
            endpointUsages.push(usage);
          }
          usage.sources.push({ nodeId: node.id, accessIndex });
          if (usage.paths.length < 3 && !usage.paths.some((p) => p.join() === path.join())) usage.paths.push(path);
        });
        if (branchCallIndex !== null) for (const call of node.calls) {
          if (!visited.has(call.nodeId)) queue.push({ node: nodes.get(call.nodeId)!, path: [...path, call.nodeId] });
        }
      }
    };
    for (const entry of model.callGraph.entries.filter((entry) => entry.endpointId === endpoint.id)) {
      addBranch(entry.nodeId, null);
      nodes.get(entry.nodeId)!.calls.forEach((_, i) => addBranch(entry.nodeId, i));
    }
    // Partial models may contain relationships without call provenance; don't silently drop them.
    for (const relation of model.relationships) {
      if (relation.kind === "table-reference" || relation.endpointId !== endpoint.id) continue;
      const target = relation.kind === "table-access" ? { kind: "table" as const, id: relation.tableId }
        : { kind: "integration" as const, id: relation.integrationId };
      for (const operation of relation.kind === "table-access" ? relation.operations : [null]) {
        if (endpointUsages.some((u) => u.target.kind === target.kind && u.target.id === target.id && u.operation === operation)) continue;
        const usage: Usage = { id: `u${usages.length + 1}`, endpointId: endpoint.id, target, operation,
          entryNodeId: null, branchCallIndex: null, sources: [], paths: [] };
        usages.push(usage);
        endpointUsages.push(usage);
      }
    }
    return { ref: `e${i + 1}`, ...endpoint, usages: endpointUsages };
  });
  return { model, apps, targets, functions, endpoints, usages };
}

export type Prepared = ReturnType<typeof prepareInterpretation>;

function catalog(prepared: Prepared) {
  const counts = new Map<string, number>();
  for (const diagnostic of prepared.model.diagnostics) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return {
    repository: prepared.model.repository.name,
    apps: prepared.apps.map(({ ref, name, description, visibility }) => ({ ref, name, description, visibility })),
    targets: prepared.targets.map(({ ref, kind, name, description }) => ({ ref, kind, name, description })),
    diagnostics: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
  };
}

function compactFunction(node: CallNode, ref: string) {
  const entries = Object.entries(node.arguments).sort(([a], [b]) => a.localeCompare(b));
  const included = entries.filter(([, value]) => typeof value !== "string" || value.length <= 160).slice(0, 16);
  return { ref, name: node.name, arguments: Object.fromEntries(included), omittedArguments: entries.length - included.length };
}

export function endpointInput(prepared: Prepared, endpoints: Prepared["endpoints"]) {
  const functionIds = new Set<string>();
  const appRef = (id: string) => prepared.apps.find((app) => app.id === id)!.ref;
  const targetRef = (usage: Usage) => prepared.targets.find((target) => target.kind === usage.target.kind && target.id === usage.target.id)!.ref;
  const compactEndpoints = endpoints.map((endpoint) => ({
    ref: endpoint.ref, app: appRef(endpoint.appId), name: endpoint.name, description: endpoint.description,
    usages: endpoint.usages.map((usage) => ({
      ref: usage.id, target: targetRef(usage), operation: usage.operation,
      sites: usage.sources.length, traced: usage.entryNodeId !== null,
      paths: usage.paths.map((path) => {
        const selected = path.length > 8 ? [...path.slice(0, 3), ...path.slice(-5)] : path;
        selected.forEach((id) => functionIds.add(id));
        return { via: selected.map((id) => prepared.functions.get(id)!.ref), omittedSteps: path.length - selected.length };
      }),
    })),
  }));
  return { ...catalog(prepared), endpoints: compactEndpoints,
    functions: [...functionIds].sort().map((id) => {
      const { node, ref } = prepared.functions.get(id)!;
      return compactFunction(node, ref);
    }) };
}

/** Bound batch size without dropping accesses from unusually large endpoints. */
export function endpointBatches(prepared: Prepared, maxEndpoints = 8, maxCharacters = 70_000) {
  const batches: Prepared["endpoints"][] = [];
  let current: Prepared["endpoints"] = [];
  for (const endpoint of prepared.endpoints) {
    if (current.length && (current.length >= maxEndpoints ||
      JSON.stringify(endpointInput(prepared, [...current, endpoint])).length > maxCharacters)) {
      batches.push(current);
      current = [];
    }
    current.push(endpoint);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Synthesis needs endpoint purposes and target roles, not call paths or usage IDs. */
export function overviewInput(prepared: Prepared, results: EndpointResponse["endpoints"]) {
  return { ...catalog(prepared), endpoints: prepared.endpoints.map((endpoint) => {
    const result = results.find((result) => result.endpoint === endpoint.ref)!;
    const accesses = Object.fromEntries(roles.map((role) => {
      const groups = new Map<string, Set<string>>();
      for (const id of result.accesses[role]) {
        const usage = endpoint.usages.find((usage) => usage.id === id)!;
        const target = prepared.targets.find((target) => target.kind === usage.target.kind && target.id === usage.target.id)!.ref;
        const operations = groups.get(target) ?? new Set<string>();
        if (usage.operation) operations.add(usage.operation);
        groups.set(target, operations);
      }
      return [role, [...groups].map(([target, operations]) => ({ target, operations: [...operations].sort() }))];
    }));
    return { ref: endpoint.ref, app: prepared.apps.find((app) => app.id === endpoint.appId)!.ref,
      name: endpoint.name, purpose: result.purpose, accesses };
  }) };
}
