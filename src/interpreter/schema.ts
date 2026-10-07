import { z } from "zod";
import { tableOperationSchema } from "../system-model/schema.ts";

export const roles = ["primary", "supporting", "secondary", "uncertain"] as const;
export type AccessRole = typeof roles[number];
export const prominenceSchema = z.enum(["core", "supporting", "utility", "uncertain"]);
const accessesSchema = z.strictObject({
  primary: z.array(z.string()), supporting: z.array(z.string()),
  secondary: z.array(z.string()), uncertain: z.array(z.string()),
});
const notesSchema = z.array(z.strictObject({ usages: z.array(z.string()), text: z.string() }));

// Normalized responses used locally; format.ts defines the per-request API schemas.
export const endpointResponseSchema = z.strictObject({
  endpoints: z.array(z.strictObject({
    endpoint: z.string(), purpose: z.string(), accesses: accessesSchema, notes: notesSchema,
  })),
});
export const overviewResponseSchema = z.strictObject({
  apps: z.array(z.strictObject({ app: z.string(), purpose: z.string() })),
  capabilities: z.array(z.strictObject({ id: z.string(), label: z.string(), purpose: z.string() })),
  endpoints: z.array(z.strictObject({
    endpoint: z.string(), capability: z.string().nullable(), prominence: prominenceSchema,
  })),
});

export const usageSchema = z.strictObject({
  id: z.string(), endpointId: z.string(),
  target: z.strictObject({ kind: z.enum(["table", "integration"]), id: z.string() }),
  operation: tableOperationSchema.nullable(),
  // An entry's own access has no branchCallIndex. Both are null for untraced relationships.
  entryNodeId: z.string().nullable(), branchCallIndex: z.number().int().nonnegative().nullable(),
  sources: z.array(z.strictObject({ nodeId: z.string(), accessIndex: z.number().int().nonnegative() })),
  // Representative paths, not an enumeration of all routes through a cyclic graph.
  paths: z.array(z.array(z.string())),
});

/** Sidecar interpretation of one exact analyzed snapshot. The facts stay in SystemModel. */
export const interpretationSchema = z.strictObject({
  schemaVersion: z.literal(1), inputHash: z.string(), model: z.string(), version: z.number().int(),
  createdAt: z.string(),
  apps: z.array(z.strictObject({ appId: z.string(), purpose: z.string() })),
  capabilities: overviewResponseSchema.shape.capabilities,
  endpoints: z.array(z.strictObject({
    endpointId: z.string(), purpose: z.string(), capabilityId: z.string().nullable(),
    prominence: prominenceSchema, accesses: accessesSchema, notes: notesSchema,
  })),
  usages: z.array(usageSchema),
  // Work represented by this artifact, including results reused from earlier runs.
  tokens: z.strictObject({ input: z.number(), output: z.number() }),
});

export type Usage = z.infer<typeof usageSchema>;
export type Interpretation = z.infer<typeof interpretationSchema>;
export type EndpointResponse = z.infer<typeof endpointResponseSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
