import { z } from "zod";
import { tableOperationSchema } from "./system-model.ts";
import type { SystemModel } from "./system-model.ts";
import { exactReferences, uniqueReferences } from "./refinements.ts";

const id = z.string().min(1);
export const purposeSchema = z.string().min(1).max(240).refine((text) => text.trim().length > 0, "Text must not be blank");
export const roles = ["primary", "supporting", "secondary", "uncertain"] as const;
export type AccessRole = typeof roles[number];
export const prominenceSchema = z.enum(["core", "supporting", "utility", "uncertain"]);
export const accessesSchema = z.strictObject({
  primary: z.array(id), supporting: z.array(id), secondary: z.array(id), uncertain: z.array(id),
});
export const notesSchema = z.array(z.strictObject({ usages: z.array(id).min(1), text: purposeSchema }));
export const capabilitySchema = z.strictObject({
  id: id.max(60), label: id.max(80).refine((text) => text.trim().length > 0, "Label must not be blank"), purpose: purposeSchema,
});

export const usageSchema = z.strictObject({
  id, endpointId: id,
  target: z.strictObject({ kind: z.enum(["table", "integration"]), id }),
  operation: tableOperationSchema.nullable(),
  // An entry's own access has no branchCallIndex. Both are null for untraced relationships.
  entryNodeId: id.nullable(), branchCallIndex: z.number().int().nonnegative().nullable(),
  sources: z.array(z.strictObject({ nodeId: id, accessIndex: z.number().int().nonnegative() })),
  // Representative paths, not an enumeration of all routes through a cyclic graph.
  paths: z.array(z.array(id)),
});

/** AI interpretation with complete usage classifications and internally resolved references. */
export const interpretationSchema = z.strictObject({
  schemaVersion: z.literal(1), inputHash: id, model: id, version: z.number().int(), createdAt: id,
  apps: z.array(z.strictObject({ appId: id, purpose: purposeSchema })),
  capabilities: z.array(capabilitySchema),
  endpoints: z.array(z.strictObject({
    endpointId: id, purpose: purposeSchema, capabilityId: id.nullable(),
    prominence: prominenceSchema, accesses: accessesSchema, notes: notesSchema,
  })),
  usages: z.array(usageSchema),
  // Work represented by this artifact, including results reused from earlier runs.
  tokens: z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() }),
}).superRefine((result, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  uniqueReferences(ctx, ["apps"], result.apps.map((app) => app.appId));
  uniqueReferences(ctx, ["endpoints"], result.endpoints.map((endpoint) => endpoint.endpointId));
  uniqueReferences(ctx, ["capabilities"], result.capabilities.map((capability) => capability.id));
  uniqueReferences(ctx, ["usages"], result.usages.map((usage) => usage.id));
  const endpoints = new Set(result.endpoints.map((endpoint) => endpoint.endpointId));
  const capabilities = new Set(result.capabilities.map((capability) => capability.id));
  result.usages.forEach((usage, i) => {
    if (!endpoints.has(usage.endpointId)) issue(["usages", i, "endpointId"], `Unresolved endpoint: ${usage.endpointId}`);
  });
  result.endpoints.forEach((endpoint, i) => {
    const usages = result.usages.filter((usage) => usage.endpointId === endpoint.endpointId).map((usage) => usage.id);
    exactReferences(ctx, ["endpoints", i, "accesses"], roles.flatMap((role) => endpoint.accesses[role]), usages);
    endpoint.notes.forEach((note, j) => {
      if (note.usages.some((ref) => !usages.includes(ref))) issue(["endpoints", i, "notes", j, "usages"], "Note references an unknown usage");
    });
    if (endpoint.capabilityId !== null && !capabilities.has(endpoint.capabilityId)) issue(["endpoints", i, "capabilityId"], "Unknown capability");
  });
  result.capabilities.forEach((capability, i) => {
    if (!result.endpoints.some((endpoint) => endpoint.capabilityId === capability.id)) issue(["capabilities", i], "Unused capability");
  });
});

/** Bind an interpretation to the entities and provenance of its analyzed model. */
export function interpretationSchemaFor(model: SystemModel) {
  return interpretationSchema.superRefine((result, ctx) => {
    exactReferences(ctx, ["apps"], result.apps.map((app) => app.appId), model.apps.map((app) => app.id));
    exactReferences(ctx, ["endpoints"], result.endpoints.map((endpoint) => endpoint.endpointId), model.endpoints.map((endpoint) => endpoint.id));
    const tables = new Set(model.tables.map((table) => table.id));
    const integrations = new Set(model.integrations.map((integration) => integration.id));
    const nodes = new Map(model.callGraph.nodes.map((node) => [node.id, node]));
    result.usages.forEach((usage, i) => {
      const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["usages", i], message });
      if (!(usage.target.kind === "table" ? tables : integrations).has(usage.target.id)) issue(`Unresolved target: ${usage.target.id}`);
      if ((usage.target.kind === "integration") !== (usage.operation === null)) issue("Operation does not match target kind");
      if (usage.entryNodeId === null) {
        if (usage.branchCallIndex !== null || usage.sources.length || usage.paths.length) issue("Untraced usage cannot have call provenance");
      } else {
        const entry = nodes.get(usage.entryNodeId);
        if (!model.callGraph.entries.some((e) => e.endpointId === usage.endpointId && e.nodeId === usage.entryNodeId)) issue("Unknown endpoint entry");
        if (usage.branchCallIndex !== null && !entry?.calls[usage.branchCallIndex]) issue("Unknown entry branch");
      }
      for (const source of usage.sources) {
        const access = nodes.get(source.nodeId)?.accesses[source.accessIndex];
        const matches = access?.kind === "table-access"
          ? usage.target.kind === "table" && access.tableId === usage.target.id && access.operation === usage.operation
          : access?.kind === "integration-use" && usage.target.kind === "integration" && access.integrationId === usage.target.id;
        if (!matches) issue("Source access does not match usage");
      }
      for (const path of usage.paths) {
        if (path[0] !== usage.entryNodeId || path.some((id, j) => !nodes.has(id) ||
          (j > 0 && !nodes.get(path[j - 1])?.calls.some((call) => call.nodeId === id)))) issue("Invalid call path");
      }
    });
  });
}

export type Usage = z.infer<typeof usageSchema>;
export type Interpretation = z.infer<typeof interpretationSchema>;
