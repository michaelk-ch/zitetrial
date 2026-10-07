# System model v1

`schema.ts` is the shared contract between the analyzer and viewer. It is ordinary
TypeScript with only a Zod dependency, so it works without Next.js, React, or file
system access. The [analyzer](../analyzer/README.md) reads repository files and
produces this model for the viewer.

The model describes a single repository snapshot and its shared database:

- **Apps** identify public/internal apps (or unknown visibility).
- **Tables** identify database tables as a whole, without fields.
- **Integrations** identify services such as email, Stripe, or AI. Provider and
  category are open strings so new services require no schema change. Include only
  integrations used by endpoints; ignore configured-but-unused services.
- **Endpoints** belong to apps and provide a first level of drill-down.
- **Relationships** describe endpoint table access (read/join/create/update/delete/unknown) and
  endpoint integration calls.
- **Diagnostics** report unsupported patterns, unresolved SQL, or other gaps.

App-to-endpoint ownership is stored once in `endpoint.appId`. Table access and
integration calls always originate from an endpoint, identified by `endpointId`.
The viewer can aggregate endpoint findings by app for its overview. Integration
relationships represent observed calls and need no separate usage classification.

Table operations are the union of observed accesses. `read` covers SDK reads and
SQL `FROM` sources; `join` identifies physical tables in explicit SQL joins.
Each CTE/subquery keeps its own `FROM`/`JOIN` roles. `create` includes bulk creates;
`update` and `delete` describe their corresponding SDK calls. A table may have
both `read` and `join`, along with any mutations. `unknown` is used only when no
known operation was observed. The CRUD view uses R/J/C/U/D and filters each
operation separately; integration calls use a dot. Regenerate older analyzer JSON
containing the former `write` operation; it is no longer accepted by the contract.

Endpoints, integrations, relationships, and diagnostics can carry `evidence` as
plain debugging strings, typically `packages/shared/server/settings.ts:234`.
These strings are opaque: the schema does not parse paths or line numbers.
Apps and tables do not carry evidence. Shared-code findings can point into
`packages/shared` while their relationship's `endpointId` identifies the caller.

## Inference

`inference/` holds pure functions that derive views from a model, such as
`access-matrix.ts` (per-app and per-endpoint table access and integration calls, plus column filtering, for the CRUD view).

## Validation and serialization

Use `systemModelSchema.parse(value)` or `.safeParse(value)` for input data.
TypeScript types are inferred from the schemas. `serializeSystemModel` and
`deserializeSystemModel` validate both sides of a JSON round trip.

Entity IDs are opaque strings unique within their collection. Prefer deterministic IDs
derived from repo-relative paths or table/provider names when building the analyzer.
Relationships have no IDs; they use endpoint and table/integration references.
Validation rejects dangling references,
duplicate IDs, invalid operations, and unknown object properties.
`schemaVersion: 1` provides a future migration boundary.

All root collections are explicit, even when empty. Evidence and diagnostics
default to empty arrays. Optional properties mean “not determined”. This supports a
partial model: emit the entities/relationships that can be resolved, and record
unresolved findings in diagnostics instead of inventing targets. Empty diagnostics
does not guarantee complete analysis.

The contract uses only JSON-compatible values. Repository metadata stores a name,
optional URL, and optional commit SHA. The local `userdata/<workspace>/<sha>` checkout
path is analyzer input and is deliberately absent from the portable model.

Table fields and references, layout, colors, selection state, parsed syntax trees, SQL text, pages, and
endpoint-to-endpoint calls are deferred. This keeps the first version focused on
the spec's app/table/integration overview and endpoint drill-down.
