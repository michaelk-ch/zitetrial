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
  endpoint integration calls, plus table-to-table references declared in the schema.
- **Diagnostics** report unsupported patterns, unresolved SQL, or other gaps.
- **Call graph** records endpoint entry points, function contexts, known literal
  arguments, calls, and local accesses. `callGraph` is required, with explicit
  `entries` and `nodes` arrays even when empty.

App-to-endpoint ownership is stored once in `endpoint.appId`. Table access and
integration calls always originate from an endpoint, identified by `endpointId`.
The viewer can aggregate endpoint findings by app for its overview. Integration
relationships represent observed calls and need no separate usage classification.