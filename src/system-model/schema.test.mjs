import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeSystemModel,
  serializeSystemModel,
  systemModelSchema,
} from "./schema.ts";

// Synthetic contract example, independent of any particular repository.
function example() {
  return {
    schemaVersion: 1,
    repository: { name: "example", commit: "abc123" },
    apps: [{ id: "staff", name: "Staff", visibility: "internal" }],
    tables: [
      { id: "payments", name: "Payments" },
      { id: "customers", name: "Customers" },
    ],
    integrations: [{ id: "email", name: "Email", category: "email" }],
    endpoints: [{ id: "send-receipt", name: "Send receipt", appId: "staff" }],
    relationships: [
      {
        kind: "table-access",
        endpointId: "send-receipt", tableId: "payments",
        operations: ["read", "join", "create", "update", "delete"],
        evidence: ["apps/staff/src/api/send-receipt.ts:12"],
      },
      {
        kind: "integration-use",
        endpointId: "send-receipt", integrationId: "email",
      },
      {
        kind: "table-reference",
        sourceTableId: "payments", targetTableId: "customers",
        evidence: ["zite.schema.json"],
      },
    ],
  };
}

test("normalizes and round-trips a model with every relationship kind", () => {
  const model = systemModelSchema.parse(example());
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
});

test("accepts partial findings, unknown classifications, and diagnostics", () => {
  const input = example();
  input.apps[0].visibility = "unknown";
  input.relationships[0].operations = ["unknown"];
  input.diagnostics = [{ severity: "warning", code: "dynamic-sql", message: "Unable to resolve a query" }];
  assert.equal(systemModelSchema.parse(input).diagnostics.length, 1);
  assert.equal(systemModelSchema.safeParse({
    schemaVersion: 1, repository: { name: "empty" },
    apps: [], tables: [], integrations: [], endpoints: [], relationships: [],
  }).success, true);
});

test("rejects dangling ownership, endpoints, and usage targets", () => {
  const mutations = [
    (m) => { m.endpoints[0].appId = "missing"; },
    (m) => { m.relationships[0].endpointId = "missing"; },
    (m) => { m.relationships[0].tableId = "missing"; },
    (m) => { m.relationships[1].integrationId = "missing"; },
    (m) => { m.relationships[1].endpointId = "missing"; },
    (m) => { m.relationships[2].sourceTableId = "missing"; },
    (m) => { m.relationships[2].targetTableId = "missing"; },
  ];
  for (const mutate of mutations) {
    const input = example();
    mutate(input);
    assert.equal(systemModelSchema.safeParse(input).success, false);
  }
});

test("rejects duplicate entity IDs", () => {
  for (const key of ["apps", "tables", "integrations", "endpoints"]) {
    const input = example();
    input[key].push(input[key][0]);
    assert.equal(systemModelSchema.safeParse(input).success, false);
  }
});

test("rejects fields, app-level access, and configured integration relationships", () => {
  const mutations = [
    (m) => { m.apps[0].evidence = []; },
    (m) => { m.tables[0].evidence = []; },
    (m) => { m.relationships[0].id = "payment-access"; },
    (m) => { m.relationships[1].id = "email-call"; },
    (m) => { m.tables[0].fields = [{ name: "id" }]; },
    (m) => {
      delete m.relationships[0].endpointId;
      m.relationships[0].source = { kind: "app", id: "staff" };
    },
    (m) => {
      delete m.relationships[1].endpointId;
      m.relationships[1].source = { kind: "app", id: "staff" };
      m.relationships[1].usage = "configured";
    },
    (m) => { m.relationships[1].usage = "configured"; },
    (m) => { m.relationships[0].endpointId = "staff"; },
    (m) => { m.relationships[2].field = "customerId"; },
    (m) => { m.relationships[2].endpointId = "send-receipt"; },
  ];
  for (const mutate of mutations) {
    const input = example();
    mutate(input);
    assert.equal(systemModelSchema.safeParse(input).success, false);
  }
});

test("accepts schema-only and self references without endpoints or field details", () => {
  const input = example();
  input.endpoints = [];
  input.relationships = [{ kind: "table-reference", sourceTableId: "payments", targetTableId: "payments" }];
  const model = systemModelSchema.parse(input);
  assert.deepEqual(model.relationships[0].evidence, []);
  assert.deepEqual(deserializeSystemModel(serializeSystemModel(model)), model);
});

test("rejects malformed, contradictory, and unsupported serialized data", () => {
  for (const operations of [[], ["write"], ["drop"], ["read", "read"], ["read", "unknown"]]) {
    const input = example();
    input.relationships[0].operations = operations;
    assert.equal(systemModelSchema.safeParse(input).success, false);
  }
  assert.throws(() => deserializeSystemModel("not JSON"));
  assert.throws(() => deserializeSystemModel(JSON.stringify({ ...example(), schemaVersion: 2 })));
  assert.equal(systemModelSchema.safeParse({ ...example(), unexpected: true }).success, false);
  assert.throws(() => serializeSystemModel({ ...example(), schemaVersion: 2 }));
});

test("treats evidence as opaque debugging strings", () => {
  const input = example();
  input.relationships[0].evidence = ["packages/shared/server/settings.ts:234", "A debugging note"];
  assert.deepEqual(systemModelSchema.parse(input).relationships[0].evidence, input.relationships[0].evidence);
  for (const value of [{ path: "apps/file.ts", line: 1 }, 123, null]) {
    const input = example();
    input.relationships[0].evidence = [value];
    assert.equal(systemModelSchema.safeParse(input).success, false);
  }
});
