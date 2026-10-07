import { z } from "zod";
import { accessesSchema, capabilitySchema, notesSchema, prominenceSchema, purposeSchema, roles } from "../system-snapshot/interpretation.ts";
import { exactReferences, uniqueReferences } from "../system-snapshot/refinements.ts";
import type { Prepared } from "./prepare.ts";

const endpointResponseSchema = z.strictObject({
  endpoints: z.array(z.strictObject({ endpoint: z.string(), purpose: purposeSchema, accesses: accessesSchema, notes: notesSchema })),
});
const overviewResponseSchema = z.strictObject({
  apps: z.array(z.strictObject({ app: z.string(), purpose: purposeSchema })),
  capabilities: z.array(capabilitySchema),
  endpoints: z.array(z.strictObject({ endpoint: z.string(), capability: z.string().nullable(), prominence: prominenceSchema })),
});

export function endpointResponseSchemaFor(endpoints: Prepared["endpoints"]) {
  return endpointResponseSchema.superRefine((result, ctx) => {
    exactReferences(ctx, ["endpoints"], result.endpoints.map((e) => e.endpoint), endpoints.map((e) => e.ref));
    result.endpoints.forEach((endpoint, i) => {
      const usages = endpoints.find((e) => e.ref === endpoint.endpoint)?.usages.map((u) => u.id) ?? [];
      exactReferences(ctx, ["endpoints", i, "accesses"], roles.flatMap((role) => endpoint.accesses[role]), usages);
      endpoint.notes.forEach((note, j) => {
        if (note.usages.some((id) => !usages.includes(id))) ctx.addIssue({ code: "custom", path: ["endpoints", i, "notes", j], message: "Note references an unknown usage" });
      });
    });
  });
}

export function overviewResponseSchemaFor(prepared: Prepared) {
  return overviewResponseSchema.superRefine((result, ctx) => {
    exactReferences(ctx, ["apps"], result.apps.map((app) => app.app), prepared.apps.map((app) => app.ref));
    exactReferences(ctx, ["endpoints"], result.endpoints.map((e) => e.endpoint), prepared.endpoints.map((e) => e.ref));
    uniqueReferences(ctx, ["capabilities"], result.capabilities.map((capability) => capability.id));
    result.capabilities.forEach((capability, i) => {
      if (!result.endpoints.some((e) => e.capability === capability.id)) ctx.addIssue({ code: "custom", path: ["capabilities", i], message: "Unused capability" });
    });
    result.endpoints.forEach((endpoint, i) => {
      if (endpoint.capability !== null && !result.capabilities.some((c) => c.id === endpoint.capability)) ctx.addIssue({ code: "custom", path: ["endpoints", i, "capability"], message: "Unknown capability" });
    });
  });
}

export type EndpointResponse = z.infer<typeof endpointResponseSchema>;
