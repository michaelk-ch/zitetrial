import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.equal(access[0].evidence[0].path, "packages/shared/data.ts");
  const update = model.relationships.find((r) => r.endpointId.includes("update") && r.kind === "table-access");
  assert.deepEqual(update.operations, ["read", "write"]);
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
    ["table:customers", ["read"]], ["table:orderItems", ["read"]],
  ]);
  assert.deepEqual(model.diagnostics.map((d) => d.code).sort(), [
    "dynamic-sql", "dynamic-table", "unknown-db-method", "unresolved-table",
  ]);
  assert.ok(model.relationships.every((r) => r.evidence.every((e) => e.line > 0)));
  assert.deepEqual(sqlTables('SELECT * FROM "Customers" WHERE EXISTS (SELECT 1 FROM "OrderItems")').names.sort(), ["Customers", "OrderItems"]);
  assert.deepEqual(sqlTables('SELECT * FROM "Customers" WHERE id::text = ANY($1::text[])'), {
    names: ["Customers"], partial: false, failed: false,
  });
  assert.deepEqual(sqlTables('WITH "Customers" AS (SELECT * FROM "Customers") SELECT * FROM "Customers"').names, ["Customers"]);
  const broken = sqlTables(`SELECT 'FROM "Unused"' FROM "Customers" WHERE ??? /* JOIN "Unused" */`);
  assert.equal(broken.failed, true);
  assert.deepEqual(broken.names, ["Customers"]);
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
  assert.equal(model.relationships[0].evidence[0].path, "packages/shared/ai.ts");
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
    ["table:customers", ["read"]], ["table:orderItems", ["read"]],
  ]);
  assert.deepEqual(access("fixedExport"), [["table:customers", ["read"]]]);
  assert.ok(model.diagnostics.some((d) => d.code === "dynamic-sql" && d.evidence[0].path.endsWith('/export.ts')));
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
    ["table:customers", ["write"]], ["table:orderItems", ["write"]],
  ]);
  assert.equal(model.relationships[0].evidence[0].line, 7);
  assert.equal(model.relationships[1].evidence[0].line, 9);
  assert.equal(model.diagnostics.length, 1);
  assert.equal(model.diagnostics[0].code, "dynamic-table");
  assert.ok(model.diagnostics[0].evidence[0].path.endsWith('/unknown.ts'));
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
    assert.ok(access.every((r) => r.operations.join() === 'write'));
    assert.ok(access.every((r) => r.evidence[0].path === 'packages/shared/phases.ts'));
  }
});

// Local checkouts are intentionally not checked into Git. Exercise them when present.
for (const [name, tables, endpoints, providers] of [
  ["crm", 33, 128, ["anthropic", "zite_email"]],
  ["grant-management", 21, 73, ["anthropic", "zite_email"]],
  ["property-management", 30, 191, ["anthropic", "stripe", "zite_email"]],
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
    assert.equal(model.apps.length, 2);
    assert.equal(model.tables.length, tables);
    assert.equal(model.endpoints.length, endpoints);
    assert.deepEqual(model.integrations.map((i) => i.provider).sort(), providers);
    assert.ok(model.relationships.length > endpoints);
    assert.ok(!model.diagnostics.some((d) => d.code === "unsupported-endpoint"));
    assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
    for (const relationship of model.relationships) {
      for (const evidence of relationship.evidence) {
        const source = await readFile(path.join(directory, revision.name, evidence.path), "utf8");
        assert.ok(evidence.line <= source.split("\n").length);
      }
    }
    const bootstrap = model.endpoints.filter((e) => e.name === "bootstrap");
    assert.ok(!model.relationships.some((r) => r.kind === "integration-use" && bootstrap.some((e) => e.id === r.endpointId)));

    if (name === "crm") {
      const access = (endpoint, table) => model.relationships.find((r) =>
        r.endpointId === `endpoint:apps/crm/src/api/${endpoint}` && r.tableId === `table:${table}`);
      for (const table of ["companies", "contacts", "deals", "leads"]) {
        assert.deepEqual(access("search", table)?.operations, ["read"], `search reads ${table}`);
        assert.deepEqual(access("seedWorkspace", table)?.operations, ["read", "write"], `seedWorkspace writes ${table}`);
      }
      for (const table of ["companies", "contacts", "deals", "leads", "tasks", "activities", "quotes", "pipelines", "stages"]) {
        assert.deepEqual(access("exportRecords", table)?.operations, ["read"], `exportRecords reads ${table}`);
      }
      for (const table of ["dealContacts", "lineItems", "stageChanges", "activities", "tasks", "quotes"]) {
        const relationship = access("deleteDeals", table);
        assert.deepEqual(relationship?.operations, ["read", "write"], `deleteDeals mutates ${table}`);
        const line = ["activities", "tasks", "quotes"].includes(table) ? 49 : 51;
        assert.ok(relationship.evidence.some((e) => e.path.endsWith('/deleteDeals.ts') && e.line === line));
      }
      assert.ok(!model.relationships.some((r) => r.endpointId.endsWith('/seedWorkspace') && r.kind === 'integration-use'));
    }

    const json = serializeSystemModel(model) + "\n";
    await writeFile(path.join(directory, `${revision.name}.json`), json);
  });
}
