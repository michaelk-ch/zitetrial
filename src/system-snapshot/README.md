# System snapshot

`index.ts` defines `SystemSnapshot = { analysis: SystemModel, interpretation: Interpretation }`.
`system-model.ts` holds the analyzer's facts; `interpretation.ts` holds AI purposes,
capabilities, endpoint prominence, and access roles. All three contracts use Zod
refinements for validation, including unique IDs, complete coverage, and resolved
references. Snapshot validation also checks interpretation targets and provenance
against the analysis. These schema modules work in the browser with only Zod.

`buildSystemSnapshot(directory, options?)` in `build.ts` runs both stages and returns
a complete, validated snapshot. The API's `POST /api/workspaces/[workspace]/snapshot`
takes no body, resolves the first discovered revision, and returns the snapshot
directly. Unknown workspaces return 404; failed stages return an error, never a
partial snapshot. The API supplies a worker-thread analyzer to keep CPU work off
the server's main thread. The ordinary TypeScript pipeline is also available via
`npm run snapshot -- <checkout> [snapshot.json]`.

Both stages use the atomic disk cache in `userdata/.snapshots/`. Analysis keys
include the checkout path, source/config file contents, and `ANALYSIS_VERSION` in
`build.ts`; bump that version when analyzer behavior changes. Installed dependencies,
hidden/generated directories, and declaration files are ignored, as in analysis.
Replacing or editing source files at the same path invalidates analysis. AI caches
remain keyed by the analyzed facts, prompts, schemas, and model configuration.
Successful stages and batches survive later failures, and cached snapshots need
no API key. `--cache-dir` changes the shared cache directory.

## System model v1

The [analyzer](../analyzer/README.md) reads repository files and produces the
analysis portion of the snapshot.

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
