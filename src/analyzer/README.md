# Repository analyzer

`analyzeRepository(directory, metadata?)` reads a local Zite checkout and returns
a validated v1 `SystemModel`. It uses Node.js, ts-morph, and node-sql-parser, with
no Next.js or React imports. It never executes repository code or needs its
dependencies installed.

```ts
import { analyzeRepository } from "./src/analyzer/index.ts";

const model = await analyzeRepository("userdata/crm/<sha>");
// Optionally provide repository metadata:
// await analyzeRepository(directory, { name, url, commit });
```

The repository name comes from the root `zite.config.json`. A 40-character SHA
directory supplies the commit; other paths work too. URLs are supplied explicitly.
A future Next route handler can call the same function in the Node.js runtime
and return `Response.json(model)`.

## CLI

```sh
npm run analyze -- userdata/crm/e21ae1a273e47a2aa3d68de00c58570bfd010b4c model.json
```

Omit the output filename to write JSON to stdout. Use `npm run --silent analyze`
when piping stdout, to suppress npm's script banner. Analysis errors go to stderr
and set a nonzero exit status; partial-analysis diagnostics are part of the model.

## Analysis

- Load every schema table and app; map `external` access to `public` visibility.
- Treat files under `apps/*/src/api` as endpoints. Read `createEndpoint`'s
  description and start from its `execute` function.
- Follow named calls, aliases, re-exports, client factories, and callbacks through
  relative imports, `@/*`, and `@project/*`. Cache findings per function and
  handle recursive calls. Uncalled functions in an imported module contribute no
  findings.
- Classify `findAll`/`findOne` as reads and `create`/`update`/`delete`/`bulkCreate`
  as writes. Unknown methods remain `unknown` unless a known operation also exists.
- Parse read-only PostgreSQL queries, including joins, subqueries, CTEs, literal
  constants, and template fragments. SQL table names are PascalCase SDK names,
  while client properties are camelCase SDK names; display labels are not used
  for lookup.
- Detect service calls from SDK imports and instances. The small registry in
  `integrations.ts` covers Zite Email, Airtable, Anthropic, OpenAI, Gemini, Stripe,
  and Slack. Configuration, token checks, constructors, and PDF utilities don't
  count as integration use.
- Merge repeated endpoint/target edges and attach repository-relative source
  paths and one-based call-site lines, including findings in shared helpers.
  IDs and collection ordering are deterministic.

## Deliberate limits

This is a structural approximation of possible execution, not a runtime trace.
Both sides of branches and passed callbacks count. It doesn't evaluate inputs,
propagate arguments through arbitrary functions, interpret query builders,
model module initialization, or resolve arbitrary dynamic dispatch.

Runtime SQL fragments and computed table names produce diagnostics. When a
query cannot be fully parsed, recognizable quoted `FROM`/`JOIN` references are
retained. Tables introduced only by an unresolved fragment can be missed.
References absent from the schema (including platform tables like `ziteUsers`)
produce diagnostics rather than new table entities. Diagnostics are deduplicated
by finding, even when many endpoints reach the same helper.
