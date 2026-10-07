import { endpointResponseSchema, overviewResponseSchema, roles } from "./schema.ts";
import type { Prepared } from "./prepare.ts";

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid interpretation: ${message}`);
}

function exact(actual: string[], expected: string[], label: string) {
  const missing = expected.filter((ref) => !actual.includes(ref));
  const unknown = actual.filter((ref) => !expected.includes(ref));
  const duplicates = actual.filter((ref, i) => actual.indexOf(ref) !== i);
  const errors = Object.entries({ missing, unknown, duplicates }).filter(([, refs]) => refs.length)
    .map(([kind, refs]) => `${kind}: ${refs.join(", ")}`);
  require(!errors.length, `${label} references must cover the supplied set exactly (${errors.join("; ")})`);
}

function sentence(text: string) {
  require(text.trim().length > 0 && text.length <= 240, "text must contain 1–240 characters");
}

export function validateEndpoints(value: unknown, endpoints: Prepared["endpoints"]) {
  const result = endpointResponseSchema.parse(value);
  exact(result.endpoints.map((e) => e.endpoint), endpoints.map((e) => e.ref), "endpoint");
  for (const endpoint of result.endpoints) {
    sentence(endpoint.purpose);
    const usages = endpoints.find((e) => e.ref === endpoint.endpoint)!.usages.map((u) => u.id);
    exact(roles.flatMap((role) => endpoint.accesses[role]), usages, `usage for ${endpoint.endpoint}`);
    for (const note of endpoint.notes) {
      sentence(note.text);
      require(note.usages.length > 0 && note.usages.every((id) => usages.includes(id)), "note references an unknown usage");
    }
  }
  return result;
}

export function validateOverview(value: unknown, prepared: Prepared) {
  const result = overviewResponseSchema.parse(value);
  exact(result.apps.map((app) => app.app), prepared.apps.map((app) => app.ref), "app");
  exact(result.endpoints.map((e) => e.endpoint), prepared.endpoints.map((e) => e.ref), "endpoint");
  const capabilities = result.capabilities.map((c) => c.id);
  require(new Set(capabilities).size === capabilities.length, "duplicate capability IDs");
  for (const app of result.apps) sentence(app.purpose);
  for (const capability of result.capabilities) {
    sentence(capability.purpose);
    require(capability.label.trim().length > 0 && capability.label.length <= 80, "capability label must contain 1–80 characters");
    require(capability.id.length > 0 && capability.id.length <= 60, "invalid capability ID");
    require(result.endpoints.some((e) => e.capability === capability.id), "unused capability");
  }
  for (const endpoint of result.endpoints) require(endpoint.capability === null || capabilities.includes(endpoint.capability), "unknown capability reference");
  return result;
}
