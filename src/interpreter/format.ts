import { z } from "zod";
import type { AIRequest } from "./openai.ts";
import type { Prepared } from "./prepare.ts";
import { prominenceSchema, roles } from "../system-snapshot/interpretation.ts";
import type { AccessRole } from "../system-snapshot/interpretation.ts";

const sentence = z.string().min(1).max(240);
const role = z.enum(roles);

function output<T extends z.ZodType, R>(schema: T, name: string, decode: (value: z.infer<T>) => R) {
  const format: AIRequest["format"] = {
    type: "json_schema", name, strict: true,
    schema: z.toJSONSchema(schema, { reused: "ref" }),
  };
  return { format, parse: (value: unknown) => decode(schema.parse(value)) };
}

/** Required alias keys make coverage part of the API contract, not a copying task. */
export function endpointOutput(endpoints: Prepared["endpoints"]) {
  const schema = z.strictObject({ endpoints: z.strictObject(Object.fromEntries(endpoints.map((endpoint) => {
    const refs = endpoint.usages.map((usage) => usage.id);
    return [endpoint.ref, z.strictObject({
      purpose: sentence,
      accesses: z.strictObject(Object.fromEntries(refs.map((ref) => [ref, role]))),
      notes: z.array(z.strictObject({
        usages: refs.length ? z.array(z.enum(refs)).min(1) : z.array(z.string()).max(0), text: sentence,
      })).max(refs.length),
    })];
  }))) });
  return output(schema, "endpoint_interpretations", (value) => ({
    endpoints: Object.entries(value.endpoints).map(([endpoint, detail]) => {
      const accesses: Record<AccessRole, string[]> = { primary: [], supporting: [], secondary: [], uncertain: [] };
      for (const [ref, role] of Object.entries(detail.accesses)) accesses[role].push(ref);
      return { endpoint, purpose: detail.purpose, accesses, notes: detail.notes };
    }),
  }));
}

export function overviewOutput(prepared: Prepared) {
  const app = z.strictObject({ purpose: sentence });
  const endpoint = z.strictObject({ capability: z.string().nullable(), prominence: prominenceSchema });
  const schema = z.strictObject({
    apps: z.strictObject(Object.fromEntries(prepared.apps.map(({ ref }) => [ref, app]))),
    capabilities: z.array(z.strictObject({ id: z.string(), label: z.string(), purpose: z.string() })),
    endpoints: z.strictObject(Object.fromEntries(prepared.endpoints.map(({ ref }) => [ref, endpoint]))),
  });
  return output(schema, "system_overview", (value) => ({
    apps: Object.entries(value.apps).map(([app, detail]) => ({ app, ...detail })),
    capabilities: value.capabilities,
    endpoints: Object.entries(value.endpoints).map(([endpoint, detail]) => ({ endpoint, ...detail })),
  }));
}
