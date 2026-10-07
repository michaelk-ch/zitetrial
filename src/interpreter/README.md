# System interpretation

`interpretSystem(model, options?)` reads an analyzed `SystemModel` and returns a
separate, validated interpretation. It never reads repository source files or
changes analyzer facts. The CLI and Next API call the same ordinary TypeScript
pipeline.

## Run it

Put the usual server-side secret in the project's ignored `.env.local`:

```dotenv
OPENAI_API_KEY=your-key
```

Open a workspace to build or load its complete snapshot, then choose **Interpretation**.
The tab groups endpoints by application and capability, orders them by prominence,
and lets you inspect primary/supporting/secondary/uncertain access roles and their
call paths. **Download snapshot** exports both analysis and interpretation, including
usage sources. Workspace loading generates missing interpretation batches; changing
tabs makes no API calls. The graph and table views display the analyzed facts; their
**Interpreted** mode hides utility endpoints and keeps each endpoint's primary accesses
(falling back to uncertain, then supporting, then secondary ones when none are primary).

From the CLI, first analyze a checkout, then interpret its JSON:

```sh
npm run analyze -- userdata/crm/<sha> model.json
npm run interpret -- model.json interpretation.json
```

The npm command loads `.env` followed by `.env.local`; environment variables take
precedence. `OPENAI_INTERPRETATION_MODEL` or `--model` overrides the default
`gpt-5.4-mini-2026-03-17`. Models must support Responses, strict structured outputs,
and low reasoning effort. No API key is needed to read a fully cached result.

Inspect exactly what the endpoint pass would receive without calling OpenAI:

```sh
npm run interpret -- model.json input-preview.json --dry-run
```

This reports endpoint/usage counts, batch character counts, and all endpoint-pass
inputs. Character counts are not token estimates. Omit the output filename for
JSON on stdout; use `npm run --silent interpret` when piping. Progress goes to
stderr. The dry run does not include the overview input, which depends on the
first pass's results.

## Two passes

1. Classify usages and summarize endpoints, in batches of up to eight endpoints
   targeting at most 70,000 input characters. A larger individual endpoint gets
   its own batch; usages are never silently dropped to meet the target.
2. Synthesize application purposes, capability groups, and endpoint prominence
   from the first pass's compact summaries and aggregated target roles. No call
   graph is sent again.

Calls use the OpenAI SDK's Responses API with strict JSON Schema, low reasoning
effort, `store: false`, and a 16,000-token output limit. Refusals and incomplete
responses fail explicitly. Per-request schemas require the exact endpoint, app,
and usage aliases as object keys. Each usage has one role value, so coverage and
valid references are enforced by Structured Outputs rather than asking the model
to copy IDs into lists. Results are normalized into the sidecar's role lists locally.
Schemas are generated from Zod. Beyond schema validation,
we check exact endpoint/app/usage coverage, duplicate and unknown references,
capability assignments, and concise text. A semantically invalid result gets one
repair attempt with the previous response and specific validation error. A failed batch does not prevent earlier successful batches from
being reused on the next run.

See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
and [model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

## Compact input and traceability

Apps, endpoints, targets, and functions receive short prompt aliases. The result
expands entity aliases back to model IDs. Usage IDs are local to the sidecar and
resolve through its `usages` collection, not new relationship IDs in SystemModel.

A usage groups access sites by endpoint, entry call branch, target, and operation.
Thus a Companies read through authorization is separate from a Companies read
through automation. Direct accesses have no branch call index. Each usage retains
the exact source node IDs and access indexes, plus up to three representative
shortest paths. Traversal handles cycles without enumerating infinitely many paths.
Relationships missing call provenance still become usages, marked as untraced.

Prompts omit evidence strings and source IDs. Function contexts are defined once
per batch; paths reference them. Paths over eight steps show the first three and
last five, with an omitted-step count. At most sixteen known arguments per function
are included; strings over 160 characters are omitted, with an omitted-argument
count. Original sources and representative full paths stay available locally.
Diagnostics are summarized by code/count across the repository, not assigned to
specific endpoints. Endpoint descriptions and all other repository text are data,
never instructions.

Access roles are relative to an endpoint's purpose. Prominence is relative to
explaining the endpoint's application, not traffic or security importance.
Capabilities are groupings, not inferred chronological journeys. Unknown runtime
conditions, sampled paths, omitted literal context, and analyzer limitations mean
some classifications should remain uncertain. This first version has no additional
source-reading or graph-retrieval tools for the model.

## Caching

Results live in `userdata/.snapshots/`, which is ignored by Git and workspace
discovery. Pass `--cache-dir` or `cacheDirectory` to use another directory.

- Each validated API result is cached by its exact input, prompt, output schema,
  model, request parameters, and interpretation version. Changing only the overview
  prompt can reuse endpoint batches.
- The assembled sidecar is cached against the complete analyzed snapshot and both
  passes' configuration. Its `inputHash` binds usage references to that snapshot.
- Writes are atomic. Invalid/corrupt entries are misses; failed API responses are
  not cached. Concurrent requests in one process share pending work. Separate
  processes share completed disk entries but can duplicate simultaneous misses.
- No expiration or automatic regeneration: unchanged inputs reuse their results.
  Edit prompts to iterate, change the configured model to compare models, or clear
  the cache directory to regenerate everything. Bump `INTERPRETATION_VERSION` when
  changing preparation or interpretation semantics.
- The API key is never part of cached data or prompts. The artifact's token counts
  describe total work represented by the result, including reused batches; they
  are not a per-run bill. CLI progress identifies cache hits.

The viewer calls `POST /api/workspaces/[workspace]/snapshot` once for a complete
`{ analysis, interpretation }` result. The shared pipeline analyzes the selected
checkout and passes those exact facts into the interpreter. Clients do not upload
a model or coordinate stages. `readInterpretation(model)` remains a read-only
cache lookup for internal/debugging use.

Offline tests cover provenance grouping, response coverage, cache invalidation,
resuming partial runs, concurrent deduplication, corrupt caches, and the SDK wire
request/error handling. Live classification quality needs an API key and human
review of the example results.
