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

Benchmark one complete analysis of a workspace:

```sh
npm run analyze -- --benchmark userdata/crm/e21ae1a273e47a2aa3d68de00c58570bfd010b4c
```

This prints the elapsed time in milliseconds for one `analyzeRepository` call,
excluding CLI startup, JSON serialization, and output writing. Benchmark mode
does not emit a model or accept an output filename.

## Analysis

- Load every schema table and app; map `external` access to `public` visibility.
- Resolve implicit SQL link tables from `linked_record` fields and their target
  table IDs. Their names concatenate the sorted PascalCase SDK table names.
  Referenced link tables become separate table entities with `table:link:` IDs,
  preserving SQL `read`/`join` roles. Inverse fields and multiple links between
  the same tables share one entity. These are SQL tables, not SDK clients;
  explicit schema tables take precedence on a name collision.
- Treat files under `apps/*/src/api` as endpoints. Read `createEndpoint`'s
  description and start from its `execute` function.
- Follow named calls, aliases, re-exports, client factories, and callbacks through
  relative imports, `@/*`, and `@project/*`. Cache findings per function and
  handle recursive calls. Uncalled functions in an imported module contribute no
  findings. Resolve called methods in static object/array registries, including
  array spreads, computed indexes, tuple destructuring, `for...of` loops, and
  registries returned by argument-free functions.
- Classify `findAll`/`findOne` as `read`, `create`/`bulkCreate` as `create`,
  `update` as `update`, and `delete` as `delete`. Unknown methods remain `unknown`
  unless a known operation also exists. Repeated access unions distinct operations.
  Computed table names can resolve through finite string-literal types, including
  TypeScript's branch narrowing. A cast at the access site alone is not evidence
  of the table name; declared types elsewhere are assumed accurate.
- Parse read-only PostgreSQL queries, including joins, subqueries, CTEs, literal
  constants, and template fragments. Physical tables in `FROM` are `read`; those
  introduced by an explicit `JOIN` are `join` (including outer and cross joins).
  A table can have both roles across queries or aliases. CTEs and subqueries are
  classified within their own query block; an outer join to a CTE/derived table
  does not change its internal roles. Comma-separated sources remain `read`.
  These are SQL roles, not proof of an endpoint's primary business entity or a
  reference lookup. Separate SDK lookups remain `read`.
  SQL table names are PascalCase SDK names,
  while client properties are camelCase SDK names; display labels are not used
  for lookup. Follow SQL fragments selected from static maps and local arrays
  accumulated with direct `push` calls before `join`. Only values flowing into
  a query are considered; unrelated SQL strings contribute no findings.
  Expand source-owned SQL helpers with argument bindings, returned clause arrays,
  mapped lists, literal replacements, and direct local assignments. TypeScript's
  standard library types distinguish numeric interpolations from unknown SQL;
  numeric values and parameter indexes do not affect table discovery.
  Normalize parser gaps around parameters, `LIKE` concatenation, time zones,
  and reserved aliases without removing operands or their subqueries.
- Detect service calls from SDK imports and instances. The small registry in
  `integrations.ts` covers Zite Email, Airtable, Anthropic, OpenAI, Gemini, Stripe,
  Slack, and Notion. Configuration, token checks, constructors, and PDF utilities don't
  count as integration use.
- Merge repeated endpoint/target edges without storing relationship IDs. Evidence
  is a list of debugging strings such as `packages/shared/server/settings.ts:234`,
  including findings in shared helpers. Apps and tables have no evidence.
  Entity IDs and collection ordering are deterministic.

## Deliberate limits

This is a structural approximation of possible execution, not a runtime trace.
Both sides of branches and passed callbacks count. An unknown registry key or
array index contributes every statically listed candidate; a constant key/index
selects only its entry. SQL evaluation unions a local variable's initializer and
direct assignments before its use; compound assignments and writes from closures
remain unresolved. Other mutable variables are not treated as constants.
Arguments are bound when expanding SQL-returning helpers, but the cached database
call graph still analyzes each function independently of its callers. It doesn't
interpret general query builders, model module initialization, or resolve arbitrary
dynamic dispatch. Array mutation through aliases or helper functions is not tracked.

Runtime SQL fragments and computed table names produce diagnostics. When a
query cannot be fully parsed, recognizable quoted `FROM`/`JOIN` references and
their respective `read`/`join` roles are retained. Tables introduced only by an
unresolved fragment can be missed.
SQL template expansion is capped at 128 combinations, with a `sql-expansion-limit`
diagnostic if it exceeds that limit. Sampling covers both sides of a combination
before filling the remaining budget. Conditional array pushes are combined as
possible accesses; their conditions and execution order across branches are not
modeled. Registry entries and collection initializers are assumed not to be
replaced at runtime.
References absent from the schema and its implicit link tables produce diagnostics rather than new table
entities. Known Zite (`ziteUsers`) and PostgreSQL (`pg_timezone_names`) tables
produce informational notices; unknown tables still produce warnings. Diagnostics
are deduplicated by finding, even when many endpoints reach the same helper.

## Example diagnostic audit

Audited the local CRM `e21ae1a`, grants `d1b8e90`, and property `71bb2c6`
revisions. Tests regenerate their adjacent JSON models.

| Repository | Original warnings | Resolved | Reclassified as info | Remaining warnings |
| --- | ---: | ---: | ---: | ---: |
| CRM | 78 | 66 | 1 | 11 |
| Grant management | 40 | 25 | 2 | 13 |
| Property management | 90 | 76 | 1 | 13 |
| Total | 208 | 167 | 4 | 37 |

The models gain 77 endpoint/table/operation findings (39 CRM, 15 grants, 23
property), retaining all previous accesses. Examples include grants submission
queries, property report tenant subqueries, and CRM demo cleanup and tuple-based
mutations. All original parser warnings resolve; runtime values alone no longer
make otherwise known SQL look dynamic.

The remaining warnings describe implementation limits, not proof that static
analysis is impossible. Their codes and messages identify the missing capability:

| Code | Count | Investigated cause | What further support would require |
| --- | ---: | --- | --- |
| `sql-helper-argument` | 10 | CRM seed/record table helpers; grants `runSeries` and demo `ids`; property dashboard, portfolio, timeline, task-link and portal helpers | Propagate caller contexts into functions that execute SQL, beyond SQL-returning helper expansion. One of these parameters is a column, so not every warning implies a missing table. |
| `sql-builder-state` | 13 | Eleven grants `getReports` queries share a `Map`-cached parameter binder; property uses compound `openingWhere` assignments and a closure-cached `meParam` | Model collection writes, compound assignments, and closure state. These examples mainly affect predicates and placeholders, but arbitrary unresolved expressions can contain subqueries. |
| `sql-expansion-limit` | 5 | CRM `reportPipeline:70`, `undoImport:61`, shared `tasks:109`; property `clearDemoData:186,204` | Preserve correlations between repeated object selections and collect accesses without enumerating whole-query combinations. Raising the cap only postpones the problem. |
| `dynamic-table` | 7 | Five CRM company/contact mutations choose an SDK table from a SQL result's literal discriminator; two property cleanup mutations call a casing-based accessor | Track SQL result projections through loops; bind accessor arguments and evaluate string transformations. The tables are finite in these examples, but are not yet recovered by this analyzer. |
| `dynamic-sql` | 2 | CRM shared `demo:176` uses `Set(steps().map(...))`; property `clearDemoData:172` maps a filtered object registry | Evaluate these collection transformations while retaining object-field correlations. |

No source code from the example repositories is executed during this analysis.

The `baden-dampft` example is also covered: its 18 endpoints across three apps
produce no diagnostics. The model includes four explicit tables, the two queried
link tables (`FestivalDaysShifts` and `ShiftsVolunteers`), and the Notion integration
used by `tasks-list/listTasks`.
