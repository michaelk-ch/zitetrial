import { z } from "zod";

const idSchema = z.string().min(1);
const nameSchema = z.string().min(1);

/** Opaque debugging strings, typically repository-relative path:line references. */
const evidenceSchema = z.array(z.string()).default([]);

export const appSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  visibility: z.enum(["internal", "public", "unknown"]),
  description: z.string().optional(),
});

export const tableSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
});

export const integrationSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  // Open strings allow additional providers and categories without a schema change.
  provider: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  description: z.string().optional(),
  evidence: evidenceSchema,
});

export const endpointSchema = z.strictObject({
  id: idSchema,
  appId: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  evidence: evidenceSchema,
});

export const relationshipSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("table-access"),
    endpointId: idSchema,
    tableId: idSchema,
    // A query can both read and write. Unknown means access was found but not classified.
    operations: z.array(z.enum(["read", "write", "unknown"])).min(1)
      .refine((values) => new Set(values).size === values.length, "Duplicate operations")
      .refine((values) => !values.includes("unknown") || values.length === 1,
        "Unknown cannot be combined with known operations"),
    evidence: evidenceSchema,
  }),
  z.strictObject({
    kind: z.literal("integration-use"),
    endpointId: idSchema,
    integrationId: idSchema,
    // Emit only observed calls; configured-but-unused integrations are omitted.
    evidence: evidenceSchema,
  }),
]);

export const diagnosticSchema = z.strictObject({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  evidence: evidenceSchema,
});

/** One repository snapshot, with one shared database and zero or more apps. */
export const systemModelSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: z.strictObject({
    name: nameSchema,
    url: z.url().optional(),
    commit: z.string().min(1).optional(),
  }),
  apps: z.array(appSchema),
  tables: z.array(tableSchema),
  integrations: z.array(integrationSchema),
  endpoints: z.array(endpointSchema),
  relationships: z.array(relationshipSchema),
  diagnostics: z.array(diagnosticSchema).default([]),
}).superRefine((model, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });

  // IDs are unique within each entity kind; named references remove ambiguity.
  const collectIds = (key: "apps" | "tables" | "integrations" | "endpoints") => {
    const ids = new Set<string>();
    model[key].forEach((entity, index) => {
      if (ids.has(entity.id)) issue([key, index, "id"], `Duplicate ID: ${entity.id}`);
      ids.add(entity.id);
    });
    return ids;
  };
  const apps = collectIds("apps");
  const tables = collectIds("tables");
  const integrations = collectIds("integrations");
  const endpoints = collectIds("endpoints");

  const requireId = (ids: Set<string>, id: string, path: (string | number)[]) => {
    if (!ids.has(id)) issue(path, `Unresolved reference: ${id}`);
  };

  model.endpoints.forEach((endpoint, index) => {
    requireId(apps, endpoint.appId, ["endpoints", index, "appId"]);
  });

  model.relationships.forEach((relationship, index) => {
    const path = ["relationships", index];
    requireId(endpoints, relationship.endpointId, [...path, "endpointId"]);
    if (relationship.kind === "table-access") {
      requireId(tables, relationship.tableId, [...path, "tableId"]);
    } else {
      requireId(integrations, relationship.integrationId, [...path, "integrationId"]);
    }
  });
});

export type App = z.infer<typeof appSchema>;
export type Table = z.infer<typeof tableSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type SystemModel = z.infer<typeof systemModelSchema>;

/** Validate at both JSON boundaries. Throws on invalid JSON or invalid model data. */
export function deserializeSystemModel(json: string): SystemModel {
  return systemModelSchema.parse(JSON.parse(json));
}

export function serializeSystemModel(model: SystemModel): string {
  return JSON.stringify(systemModelSchema.parse(model), null, 2);
}
