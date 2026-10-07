import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeRepository } from "./index.ts";
import { sqlTables } from "./sql.ts";
import { deserializeSystemModel, serializeSystemModel } from "../system-model/schema.ts";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zite-analyzer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const all = {
    "zite.config.json": JSON.stringify({ project: { name: "Example" } }),
    "zite.schema.json": JSON.stringify({ tables: [
      { id: "t1", name: "Customers", sdkName: "customers" },
      { id: "t2", name: "Order Items", sdkName: "orderItems" },
      { id: "t3", name: "Unused", sdkName: "unused" },
    ] }),
    "apps/staff/zite.config.json": JSON.stringify({ accessMode: "internal", integrations: { unused: { provider: "stripe" } } }),
    "apps/portal/zite.config.json": JSON.stringify({ accessMode: "external" }),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

test("follows called shared exports, aliases, re-exports, callbacks, and recursion without unrelated effects", async (t) => {
  const root = await fixture(t, {
    "packages/shared/barrel.ts": `export { readCustomers as load, send } from './data';`,
    "packages/shared/data.ts": `
      import { zite as db } from 'zitejs/db';
      import { Email } from 'zitejs/email';
      import Anthropic from '@anthropic-ai/sdk';
      export function configured() { return Boolean(process.env.ZITE_ANTHROPIC_ACCESS_TOKEN); }
      export function readCustomers() { configured(); return db.customers.findAll({}); }
      export function send() { return Email.send({ to: 'someone@example.com' }); }
      export function unused() { db.unused.delete({}); send(); new Anthropic({}).messages.create({}); }
    `,
    "apps/staff/src/api/read.ts": `
      import { createEndpoint as endpoint } from 'zitejs/backend';
      import { load, send } from '@project/shared/barrel';
      import { readAgain } from '@/loop';
      export default endpoint({ description: 'Read customers', execute: async () => {
        const neverCalled = () => send();
        return readAgain();
      }});
    `,
    "apps/staff/src/loop.ts": `
      import { load } from '@project/shared/barrel';
      export function readAgain() { if (false) readAgain(); return load(); }
    `,
    "apps/portal/src/api/update.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      import { load, send } from '@project/shared/barrel';
      export default createEndpoint({ execute: async () => {
        await load();
        await Promise.resolve().then(send);
        await Promise.all([1].map(() => zite['customers'].update({})));
      }});
    `,
  });
  const model = await analyzeRepository(root, { commit: "abc123", url: "https://example.com/repo" });
  assert.deepEqual(model.apps.map((a) => a.visibility).sort(), ["internal", "public"]);
  assert.equal(model.endpoints.length, 2);
  assert.equal(model.tables.length, 3);
  assert.equal(model.repository.commit, "abc123");
  assert.deepEqual(model.diagnostics, []);
  const read = model.endpoints.find((e) => e.name === "read");
  assert.equal(read.description, "Read customers");
  const access = model.relationships.filter((r) => r.endpointId === read.id);
  assert.equal(access.length, 1);
  assert.equal(access[0].tableId, "table:customers");
  assert.deepEqual(access[0].operations, ["read"]);
  assert.equal(access[0].evidence[0], "packages/shared/data.ts:6");
  const update = model.relationships.find((r) => r.endpointId.includes("update") && r.kind === "table-access");
  assert.deepEqual(update.operations, ["read", "update"]);
  assert.deepEqual(model.integrations.map((i) => i.provider), ["zite_email"]);
  assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
  assert.deepEqual(await analyzeRepository(root, model.repository), model);
});

test("extracts SQL joins, subqueries, CTEs, and imported fragments; reports partial queries and dynamic targets", async (t) => {
  const root = await fixture(t, {
    "packages/shared/query.ts": 'export const FROM = `FROM "OrderItems" i JOIN "Customers" c ON c.id = i."customerId"`;',
    "apps/staff/src/api/report.ts": `
      import { zite } from 'zitejs/db';
      import { createEndpoint } from 'zitejs/backend';
      import { FROM } from '@project/shared/query';
      export default createEndpoint({ execute: async ({ input }) => {
        await zite.sql({ query: \`SELECT * \${FROM} WHERE \${input.filter}\` });
        await zite.sql({ query: 'WITH active AS (SELECT * FROM "Customers") SELECT * FROM active' });
        await zite.sql({ query: 'SELECT * FROM "Missing"' });
        await zite[input.table].delete({});
        await zite.orderItems.unrecognized({});
      }});
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.relationships.map((r) => [r.tableId, r.operations]), [
    ["table:customers", ["join", "read"]], ["table:orderItems", ["read"]],
  ]);
  assert.deepEqual(model.diagnostics.map((d) => d.code).sort(), [
    "dynamic-sql", "dynamic-table", "unknown-db-method", "unresolved-table",
  ]);
  assert.ok(model.relationships.every((r) => r.evidence.every((e) => typeof e === "string")));
  assert.deepEqual(sqlTables('SELECT * FROM "Customers" WHERE EXISTS (SELECT 1 FROM "OrderItems")').accesses.map(({ name }) => name).sort(), ["Customers", "OrderItems"]);
  assert.deepEqual(sqlTables('SELECT * FROM "Customers" WHERE id::text = ANY($1::text[])'), {
    accesses: [{ name: "Customers", operation: "read" }], partial: false, failed: false,
  });
  assert.deepEqual(sqlTables('WITH "Customers" AS (SELECT * FROM "Customers") SELECT * FROM "Customers"').accesses.map(({ name }) => name), ["Customers"]);
  const broken = sqlTables(`SELECT 'FROM "Unused"' FROM "Customers" WHERE ??? /* JOIN "Unused" */`);
  assert.equal(broken.failed, true);
  assert.deepEqual(broken.accesses.map(({ name }) => name), ["Customers"]);
});

test("resolves schema-backed SQL link tables, deduplicating inverse fields without inventing SDK clients", async (t) => {
  const linked = (tableId) => ({ definition: { type: "linked_record", template: { tableId } } });
  const root = await fixture(t, {
    "zite.schema.json": JSON.stringify({ tables: [
      { id: "t2", name: "Line Items", sdkName: "orderItems", fields: [linked("t1"), linked("t1")] },
      { id: "t1", name: "Clients", sdkName: "customers", fields: [linked("t2"), linked("missing")] },
      { id: "t3", name: "Unused", sdkName: "unused" },
    ] }),
    "apps/staff/src/api/links.ts": `
      import { zite } from 'zitejs/db';
      import { createEndpoint } from 'zitejs/backend';
      export default createEndpoint({ execute: async () => {
        await zite.sql({ query: 'SELECT * FROM "CustomersOrderItems"' });
        await zite.sql({ query: 'SELECT * FROM "Customers" JOIN "CustomersOrderItems" ON true' });
        await zite.sql({ query: 'SELECT * FROM "CustomersUnused"' });
        await zite.customersOrderItems.findAll({});
      }});
    `,
  });
  const model = await analyzeRepository(root);
  assert.equal(model.tables.length, 4);
  assert.deepEqual(model.relationships.filter((r) => r.kind === "table-access").map((r) => [r.tableId, r.operations]), [
    ["table:customers", ["read"]], ["table:link:CustomersOrderItems", ["join", "read"]],
  ]);
  assert.deepEqual(model.diagnostics.map((d) => d.code).sort(), ["unresolved-table", "unresolved-table", "unresolved-table-reference"]);
  assert.ok(model.diagnostics.some((d) => d.message.includes('CustomersUnused')));
  assert.ok(model.diagnostics.some((d) => d.message.includes('customersOrderItems')));
});

test("extracts directed table references without endpoints, deduplicating fields and preserving inverse and self references", async (t) => {
  const linked = (tableId, isInverse = false) => ({
    definition: { type: "linked_record", template: { tableId, isInverse, allowMultiple: true } },
  });
  const root = await fixture(t, {
    "zite.schema.json": JSON.stringify({ tables: [
      { id: "t2", name: "Line Items", sdkName: "orderItems", fields: [linked("t1"), linked("t1")] },
      { id: "t1", name: "Clients", sdkName: "customers", fields: [linked("t2", true), linked("t1"), linked("missing")] },
      { id: "t3", name: "Unused", sdkName: "unused", fields: [
        { sdkName: "customerId", definition: { type: "single_line_text", template: { tableId: "t1" } } },
      ] },
    ] }),
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.endpoints, []);
  assert.equal(model.tables.length, 3);
  assert.deepEqual(model.relationships, [
    { kind: "table-reference", sourceTableId: "table:customers", targetTableId: "table:customers", evidence: ["zite.schema.json"] },
    { kind: "table-reference", sourceTableId: "table:customers", targetTableId: "table:orderItems", evidence: ["zite.schema.json"] },
    { kind: "table-reference", sourceTableId: "table:orderItems", targetTableId: "table:customers", evidence: ["zite.schema.json"] },
  ]);
  assert.equal(model.diagnostics.length, 1);
  assert.equal(model.diagnostics[0].code, "unresolved-table-reference");
  assert.deepEqual(model.diagnostics[0].evidence, ["zite.schema.json"]);
  assert.ok(model.diagnostics[0].message.includes('missing'));
  assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
  assert.deepEqual(await analyzeRepository(root), model);
});

test("detects Notion calls through an aliased client but excludes construction and unused helpers", async (t) => {
  const root = await fixture(t, {
    "packages/shared/notion.ts": `
      import { Client as NotionClient } from '@notionhq/client';
      const client = new NotionClient({ auth: process.env.ZITE_NOTION_ACCESS_TOKEN });
      export function list() { return client.dataSources.query({}); }
      export function unused() { return client.pages.create({}); }
    `,
    "apps/staff/src/api/list.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { list } from '@project/shared/notion';
      export default createEndpoint({ execute: list });
    `,
    "apps/staff/src/api/configure.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { Client } from '@notionhq/client';
      export default createEndpoint({ execute: () => new Client({}) });
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(model.integrations.map((i) => [i.name, i.provider]), [["Notion", "notion"]]);
  assert.deepEqual(model.relationships, [{
    kind: "integration-use", endpointId: "endpoint:apps/staff/src/api/list",
    integrationId: "integration:notion", evidence: ["packages/shared/notion.ts:4"],
  }]);
});

test("preserves CRUD operations and combines distinct accesses to the same table", async (t) => {
  const root = await fixture(t, {
    "apps/staff/src/api/mutate.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite as db } from 'zitejs/db';
      export default createEndpoint({ execute: async () => {
        await db.customers.findOne({});
        await db.customers.findAll({});
        await db.customers.create({});
        await db.customers.bulkCreate({});
        await db.customers.update({});
        await db.customers.delete({});
        await db.customers.unrecognized({});
        await db.sql({ query: 'SELECT * FROM "OrderItems" JOIN "Customers" ON true' });
        await db.unused.unrecognized({});
      }});
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.relationships.map((r) => [r.tableId, r.operations]), [
    ["table:customers", ["create", "delete", "join", "read", "update"]],
    ["table:orderItems", ["read"]],
    ["table:unused", ["unknown"]],
  ]);
  assert.equal(model.relationships[0].evidence.length, 8);
  assert.deepEqual(model.diagnostics.map((d) => d.code), ["unknown-db-method", "unknown-db-method"]);
});

test("SQL classifies FROM and explicit JOIN separately in each query block", () => {
  const read = (name) => ({ name, operation: "read" });
  const join = (name) => ({ name, operation: "join" });
  for (const keyword of ["JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN"]) {
    const result = sqlTables(`SELECT * FROM "OrderItems" i ${keyword} "Customers" c ${keyword === "CROSS JOIN" ? "" : 'ON c.id = i."customerId"'}`);
    assert.equal(result.failed, false, keyword);
    assert.deepEqual(result.accesses, [read("OrderItems"), join("Customers")]);
  }
  for (const [query, expected] of [
    ['SELECT * FROM "Customers" c JOIN "Customers" parent ON true JOIN "Customers" owner ON true', [read("Customers"), join("Customers")]],
    ['SELECT * FROM "OrderItems", "Customers"', [read("OrderItems"), read("Customers")]],
    ['SELECT * FROM "OrderItems" WHERE EXISTS (SELECT 1 FROM "Customers" c JOIN "Unused" u ON true)', [read("OrderItems"), read("Customers"), join("Unused")]],
    ['WITH c AS (SELECT * FROM "Customers" JOIN "Unused" ON true) SELECT * FROM "OrderItems" JOIN c ON true', [read("Customers"), join("Unused"), read("OrderItems")]],
    ['SELECT * FROM "OrderItems" JOIN (SELECT * FROM "Customers" JOIN "Unused" ON true) c ON true', [read("OrderItems"), read("Customers"), join("Unused")]],
    ['SELECT * FROM "OrderItems" UNION ALL SELECT * FROM "Customers" JOIN "Unused" ON true', [read("OrderItems"), read("Customers"), join("Unused")]],
    ['SELECT * FROM "public"."OrderItems" JOIN "public"."Customers" ON true', [read("OrderItems"), join("Customers")]],
    ['WITH RECURSIVE c AS (SELECT * FROM "Customers" UNION ALL SELECT u.* FROM "Unused" u JOIN c ON true) SELECT * FROM c', [read("Customers"), read("Unused")]],
  ]) {
    const result = sqlTables(query);
    assert.equal(result.failed, false, query);
    assert.deepEqual(result.accesses, expected, query);
  }
  const broken = sqlTables(`SELECT 'JOIN "Unused"' FROM /* source */ "OrderItems" JOIN "Customers" ON true WHERE ??? -- FROM "Unused"`);
  assert.equal(broken.failed, true);
  assert.deepEqual(broken.accesses, [read("OrderItems"), join("Customers")]);
});

test("observes SDK method calls through factories, excluding constructors, token checks, and PDF", async (t) => {
  const root = await fixture(t, {
    "packages/shared/ai.ts": `
      import Anthropic from '@anthropic-ai/sdk';
      export function configured() { return Boolean(process.env.ZITE_ANTHROPIC_ACCESS_TOKEN); }
      function client() { return new Anthropic({}); }
      export function ask() { return client().messages.create({}); }
    `,
    "apps/staff/src/api/ask.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import Stripe from 'stripe';
      import { Pdf } from 'zitejs/pdf';
      import { ask } from '@project/shared/ai';
      export default createEndpoint({ execute: () => {
        const stripe = new Stripe('unused', { httpClient: Stripe.createFetchHttpClient() });
        Pdf.generate({});
        return ask();
      }});
    `,
    "apps/staff/src/api/check.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { configured } from '@project/shared/ai';
      export default createEndpoint({ execute: configured });
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.integrations.map((i) => i.provider), ["anthropic"]);
  assert.equal(model.relationships.length, 1);
  assert.ok(model.relationships[0].endpointId.endsWith("/ask"));
  assert.equal(model.relationships[0].evidence[0], "packages/shared/ai.ts:5");
});

test("expands SQL helpers, bound methods, returned clauses, tuple loops, and literal registries", async (t) => {
  const root = await fixture(t, {
    "packages/shared/queries.ts": `
      export class Params {
        values: unknown[] = [];
        add(value: unknown) { this.values.push(value); return '$' + this.values.length; }
      }
      export function clauses(p: { add: (value: unknown) => string }, value: unknown) {
        const parts = ['true'];
        if (value) parts.push(\`EXISTS (SELECT 1 FROM "OrderItems" WHERE id = \${p.add(value)})\`);
        const unused = () => parts.push('EXISTS (SELECT 1 FROM "Unused")');
        return parts;
      }
      export const select = (table: string) => \`SELECT * FROM "\${table}" __WHERE__\`;
      export function plans() { return [{ query: 'SELECT * FROM "OrderItems"' }]; }
    `,
    "apps/staff/src/api/helpers.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      import { Params, clauses, select, plans } from '@project/shared/queries';
      const queries = { 'people.list': 'SELECT * FROM "Customers"' };
      export default createEndpoint({ execute: async ({ input }) => {
        const p = new Params();
        await zite.sql({ query: select('Customers').replace('__WHERE__', 'WHERE ' + clauses(p, input.id).join(' AND ')) });
        await zite.sql({ query: queries['people.list'] });
        for (const plan of plans()) await zite.sql({ query: plan.query });
        for (const [client, table] of [['customers', 'Customers'], ['orderItems', 'OrderItems']] as const) {
          await zite.sql({ query: \`SELECT * FROM "\${table}" WHERE id IN (\${input.ids.map((_, i: number) => '$' + (i + 1)).join(',')}) LIMIT \${Math.min(10, input.limit)}\` });
          await zite[client].delete({});
        }
      }});
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(model.relationships.map((r) => [r.tableId, r.operations]), [
    ['table:customers', ['delete', 'read']], ['table:orderItems', ['delete', 'read']],
  ]);
});

test("normalizes PostgreSQL grammar gaps without losing operand tables or reading string contents", () => {
  for (const query of [
    `SELECT * FROM "Customers" WHERE id::text = $1 LIMIT $2 OFFSET $3`,
    `SELECT * FROM "Customers" WHERE name NOT LIKE '%' || (SELECT name FROM "OrderItems" LIMIT 1) || '%'`,
    `SELECT * FROM "Customers" WHERE name ILIKE '%' || name::text || '%'`,
    `SELECT COALESCE(created_at, updated_at) AS at, id AS key FROM "Customers" ORDER BY at, key`,
    `SELECT * FROM "Customers" WHERE (COALESCE(created_at, updated_at) AT TIME ZONE $1)::date > $2::date`,
    `SELECT 'FROM "Unused" LIKE $1 AT TIME ZONE $2 AS at' FROM "Customers" /* JOIN "Unused" */`,
  ]) {
    const result = sqlTables(query);
    assert.equal(result.failed, false, query);
    assert.equal(result.partial, false);
    assert.deepEqual(result.accesses.map(({ name }) => name).sort(), query.includes('FROM "OrderItems"') ? ['Customers', 'OrderItems'] : ['Customers']);
  }
});

test("unions direct SQL assignments and distinguishes builder state, helper arguments, and platform tables", async (t) => {
  const root = await fixture(t, {
    "apps/staff/src/api/diagnostics.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      const run = (query: string) => zite.sql({ query });
      export default createEndpoint({ execute: async ({ input }) => {
        let clause = '';
        if (input.related) clause = 'WHERE EXISTS (SELECT 1 FROM "OrderItems")';
        await zite.sql({ query: 'SELECT * FROM "Customers" ' + clause });
        clause = 'WHERE EXISTS (SELECT 1 FROM "Unused")';
        let accumulated = '';
        if (input.filter) accumulated += input.filter;
        await zite.sql({ query: 'SELECT * FROM "Customers" ' + accumulated });
        const cache = new Map<string, string>();
        cache.set('filter', input.filter);
        await zite.sql({ query: 'SELECT * FROM "Customers" WHERE ' + cache.get('filter') });
        await run(input.query);
        await zite.sql({ query: 'SELECT * FROM "ziteUsers"' });
        await zite.sql({ query: 'SELECT * FROM pg_timezone_names' });
      }});
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.relationships.map((r) => r.tableId), ['table:customers', 'table:orderItems']);
  assert.deepEqual(model.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code).sort(), [
    'sql-builder-state', 'sql-builder-state', 'sql-helper-argument',
  ]);
  assert.deepEqual(model.diagnostics.filter((d) => d.severity === 'info').map((d) => d.code).sort(), ['platform-table', 'system-table']);
});

test("reports bounded SQL expansion while sampling every table choice", async (t) => {
  const root = await fixture(t, {
    "apps/staff/src/api/combinations.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      const columns = ${JSON.stringify(Array.from({ length: 20 }, (_, i) => 'c' + i))};
      const tables = ['Customers', 'OrderItems', 'Unused'];
      export default createEndpoint({ execute: ({ input }) => zite.sql({
        query: \`SELECT "\${columns[input.a]}", "\${columns[input.b]}" FROM "\${tables[input.table]}"\`,
      }) });
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.relationships.map((r) => r.tableId), ['table:customers', 'table:orderItems', 'table:unused']);
  assert.deepEqual(model.diagnostics.map((d) => d.code), ['sql-expansion-limit']);
});

test("recovers SQL from conditional pushes and selected plans without scanning unrelated strings", async (t) => {
  const root = await fixture(t, {
    "packages/shared/plans.ts": `
      export const PLANS = {
        people: { select: 'c.* FROM "Customers" c', order: 'c.id' },
        orders: { select: 'i.* FROM "OrderItems" i JOIN "Customers" c ON true', order: 'i.id' },
      };
      export const UNRELATED = { select: '* FROM "Unused"' };
    `,
    "apps/staff/src/api/search.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      export default createEndpoint({ execute: async ({ input }) => {
        const parts: string[] = [];
        const unused = () => parts.push('SELECT * FROM "Unused"');
        if (input.people) parts.push('SELECT id FROM "Customers"');
        if (input.orders) parts.push('SELECT id FROM "OrderItems"');
        { const parts = []; parts.push('SELECT * FROM "Unused"'); }
        await zite.sql({ query: \`SELECT * FROM (\${parts.join(' UNION ALL ')}) results\` });
        parts.push('SELECT * FROM "Unused"');
      }});
    `,
    "apps/staff/src/api/export.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      import { PLANS, UNRELATED } from '@project/shared/plans';
      export default createEndpoint({ execute: ({ input }) => {
        const plan = PLANS[input.kind];
        return zite.sql({ query: \`SELECT \${plan.select} WHERE \${input.filter} ORDER BY \${plan.order}\` });
      }});
    `,
    "apps/staff/src/api/fixedExport.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      import { PLANS } from '@project/shared/plans';
      export default createEndpoint({ execute: () => zite.sql({ query: \`SELECT \${PLANS.people.select}\` }) });
    `,
  });
  const model = await analyzeRepository(root);
  const access = (name) => model.relationships.filter((r) => r.endpointId.endsWith('/' + name)).map((r) => [r.tableId, r.operations]);
  for (const name of ["search", "export"]) assert.deepEqual(access(name), [
    ["table:customers", name === "export" ? ["join", "read"] : ["read"]], ["table:orderItems", ["read"]],
  ]);
  assert.deepEqual(access("fixedExport"), [["table:customers", ["read"]]]);
  assert.ok(model.diagnostics.some((d) => d.code === "dynamic-sql" && d.evidence[0].startsWith('apps/staff/src/api/export.ts:')));
});

test("resolves finite computed table names with branch-specific mutation evidence", async (t) => {
  const root = await fixture(t, {
    "apps/staff/src/api/remove.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      export default createEndpoint({ execute: ({ input }) => {
        const table = String(input.table) as 'customers' | 'orderItems';
        if (table === 'customers') {
          return Promise.resolve().then(() => zite[table].update({}));
        } else {
          return Promise.resolve().then(() => zite[table].delete({}));
        }
      }});
    `,
    "apps/staff/src/api/unknown.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { zite } from 'zitejs/db';
      export default createEndpoint({ execute: ({ input }) => zite[input.table as 'unused'].delete({}) });
    `,
  });
  const model = await analyzeRepository(root);
  assert.deepEqual(model.relationships.map((r) => [r.tableId, r.operations]), [
    ["table:customers", ["update"]], ["table:orderItems", ["delete"]],
  ]);
  assert.equal(model.relationships[0].evidence[0], "apps/staff/src/api/remove.ts:7");
  assert.equal(model.relationships[1].evidence[0], "apps/staff/src/api/remove.ts:9");
  assert.equal(model.diagnostics.length, 1);
  assert.equal(model.diagnostics[0].code, "dynamic-table");
  assert.ok(model.diagnostics[0].evidence[0].startsWith('apps/staff/src/api/unknown.ts:'));
});

test("follows only selected methods in imported phase arrays, including spreads and mutable indexes", async (t) => {
  const root = await fixture(t, {
    "packages/shared/phases.ts": `
      import { zite } from 'zitejs/db';
      const customerPhase = { run: () => zite.customers.bulkCreate({}), unused: () => zite.unused.delete({}) };
      const orderPhase = { async run() { await zite.orderItems.create({}); } };
      const unusedPhase = { run: () => zite.unused.delete({}) };
      export const BASE = [customerPhase];
      export const PHASES = [...BASE, orderPhase];
    `,
    "apps/staff/src/api/seed.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { PHASES } from '@project/shared/phases';
      export default createEndpoint({ execute: async () => {
        for (let index = 0; index < PHASES.length; index++) {
          const phase = PHASES[index];
          await phase.run();
        }
      }});
    `,
    "apps/staff/src/api/seedEach.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { PHASES } from '@project/shared/phases';
      export default createEndpoint({ execute: async () => {
        for (const phase of PHASES) await phase.run();
      }});
    `,
    "apps/staff/src/api/seedFirst.ts": `
      import { createEndpoint } from 'zitejs/backend';
      import { PHASES } from '@project/shared/phases';
      export default createEndpoint({ execute: () => PHASES[0].run() });
    `,
  });
  const model = await analyzeRepository(root);
  for (const endpoint of model.endpoints) {
    const access = model.relationships.filter((r) => r.endpointId === endpoint.id);
    const expected = endpoint.name === "seedFirst" ? ["table:customers"] : ["table:customers", "table:orderItems"];
    assert.deepEqual(access.map((r) => r.tableId), expected);
    assert.ok(access.every((r) => r.operations.join() === 'create'));
    assert.ok(access.every((r) => r.evidence[0].startsWith('packages/shared/phases.ts:')));
  }
});

// Local checkouts are intentionally not checked into Git. Exercise them when present.
for (const [name, tables, endpoints, providers, apps = 2] of [
  ["crm", 33, 128, ["anthropic", "zite_email"]],
  ["grant-management", 21, 73, ["anthropic", "zite_email"]],
  ["property-management", 30, 191, ["anthropic", "stripe", "zite_email"]],
  ["baden-dampft", 6, 18, ["notion"], 3],
]) {
  test(`analyzes the ${name} example`, async (t) => {
    const directory = path.resolve("userdata", name);
    const revisions = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const revision = revisions.find((entry) => entry.isDirectory());
    if (!revision) return t.skip("Local example checkout is absent");
    const model = await analyzeRepository(path.join(directory, revision.name));
    assert.equal(model.apps.length, apps);
    assert.equal(model.tables.length, tables);
    assert.equal(model.endpoints.length, endpoints);
    assert.deepEqual(model.integrations.map((i) => i.provider).sort(), providers);
    assert.ok(model.relationships.length > endpoints);
    assert.ok(!model.diagnostics.some((d) => d.code === "unsupported-endpoint"));
    assert.ok(!model.diagnostics.some((d) => d.code === "unsupported-sql"));
    if (name === "baden-dampft") {
      assert.deepEqual(model.diagnostics, []);
      for (const table of ["FestivalDaysShifts", "ShiftsVolunteers"]) {
        assert.ok(model.relationships.some((r) => r.kind === "table-access" && r.endpointId.endsWith('/getMyShifts') &&
          r.tableId === `table:link:${table}` && r.operations.includes('join')));
      }
      assert.ok(model.relationships.some((r) => r.endpointId === 'endpoint:apps/tasks-list/src/api/listTasks' &&
        r.integrationId === 'integration:notion'));
      assert.deepEqual(model.relationships.filter((r) => r.kind === "table-reference").map((r) => [r.sourceTableId, r.targetTableId]), [
        ["table:festivalDays", "table:okMembers"], ["table:festivalDays", "table:shifts"],
        ["table:okMembers", "table:festivalDays"], ["table:shifts", "table:festivalDays"],
        ["table:shifts", "table:volunteers"], ["table:volunteers", "table:shifts"],
      ]);
    }
    assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
    assert.ok([...model.apps, ...model.tables].every((entity) => !("evidence" in entity)));
    assert.ok(model.relationships.every((relationship) => !("id" in relationship)));
    const bootstrap = model.endpoints.filter((e) => e.name === "bootstrap");
    assert.ok(!model.relationships.some((r) => r.kind === "integration-use" && bootstrap.some((e) => e.id === r.endpointId)));

    if (name === "crm") {
      const access = (endpoint, table) => model.relationships.find((r) =>
        r.endpointId === `endpoint:apps/crm/src/api/${endpoint}` && r.tableId === `table:${table}`);
      for (const table of ["companies", "contacts", "deals", "leads"]) {
        assert.deepEqual(access("search", table)?.operations, table === "companies" ? ["join", "read"] : ["read"], `search accesses ${table}`);
        const seeded = table === "deals" ? ["create", "read"] : table === "leads" ? ["create", "read", "update"] : ["create", "join", "read", "update"];
        assert.deepEqual(access("seedWorkspace", table)?.operations, seeded, `seedWorkspace accesses ${table}`);
      }
      for (const table of ["companies", "contacts", "deals", "leads", "tasks", "activities", "quotes", "pipelines", "stages"]) {
        const exported = ["pipelines", "stages"].includes(table) ? ["join"] : ["companies", "contacts", "deals"].includes(table) ? ["join", "read"] : ["read"];
        assert.deepEqual(access("exportRecords", table)?.operations, exported, `exportRecords accesses ${table}`);
      }
      for (const table of ["dealContacts", "lineItems", "stageChanges", "activities", "tasks", "quotes"]) {
        const relationship = access("deleteDeals", table);
        const updated = ["activities", "tasks", "quotes"].includes(table);
        assert.deepEqual(relationship?.operations, updated ? ["read", "update"] : ["delete", "read"], `deleteDeals mutates ${table}`);
        const line = updated ? 49 : 51;
        assert.ok(relationship.evidence.includes(`apps/crm/src/api/deleteDeals.ts:${line}`));
      }
      assert.ok(!model.relationships.some((r) => r.endpointId.endsWith('/seedWorkspace') && r.kind === 'integration-use'));
    }
    if (name === "grant-management") {
      for (const table of ['submissions', 'applicants', 'reviews', 'submissionLabels', 'messages', 'tasks']) {
        for (const endpoint of ['exportSubmissions', 'listSubmissions']) assert.ok(model.relationships.some((r) =>
          r.endpointId.endsWith('/' + endpoint) && r.tableId === 'table:' + table && r.operations.includes(table === 'applicants' ? 'join' : 'read')), `${endpoint} accesses ${table}`);
      }
    }
    if (name === "property-management") {
      for (const table of ['leaseTenants', 'tenants']) assert.ok(model.relationships.some((r) =>
        r.endpointId.endsWith('/reportAging') && r.tableId === 'table:' + table && r.operations.includes(table === 'tenants' ? 'join' : 'read')), `reportAging accesses ${table}`);
      for (const table of ['activity', 'notifications']) assert.ok(model.relationships.some((r) =>
        r.endpointId.endsWith('/clearDemoData') && r.tableId === 'table:' + table && r.operations.includes('read')), `bounded expansion retains ${table}`);
    }

    const json = serializeSystemModel(model) + "\n";
    await writeFile(path.join(directory, `${revision.name}.json`), json);
  });
}
