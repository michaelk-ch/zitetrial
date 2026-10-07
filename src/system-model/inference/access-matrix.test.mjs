import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../schema.ts";
import { accessLabel, buildAccessMatrix, filterMatrix, usedColumns } from "./access-matrix.ts";

const model = systemModelSchema.parse({
  schemaVersion: 1, repository: { name: "Matrix example" },
  callGraph: { entries: [], nodes: [] },
  apps: [
    { id: "a", name: "App A", visibility: "internal" },
    { id: "b", name: "App B", visibility: "public" },
    { id: "empty", name: "Empty app", visibility: "unknown" },
  ],
  tables: [{ id: "customer", name: "Customer" }, { id: "deal", name: "Deal" }],
  endpoints: [
    { id: "read", appId: "a", name: "Read" },
    { id: "write", appId: "a", name: "Write" },
    { id: "unknown", appId: "a", name: "Unknown" },
    { id: "other", appId: "b", name: "Other" },
    { id: "unused", appId: "b", name: "Unused" },
  ],
  integrations: [{ id: "email", name: "Email" }, { id: "stripe", name: "Stripe" }],
  relationships: [
    { kind: "table-access", endpointId: "read", tableId: "customer", operations: ["read"] },
    { kind: "table-access", endpointId: "write", tableId: "customer", operations: ["read", "join", "create", "update", "delete"] },
    { kind: "table-access", endpointId: "unknown", tableId: "customer", operations: ["unknown"] },
    { kind: "table-access", endpointId: "other", tableId: "deal", operations: ["create"] },
    { kind: "integration-use", endpointId: "unused", integrationId: "email" },
    { kind: "integration-use", endpointId: "write", integrationId: "email" },
    { kind: "table-reference", sourceTableId: "customer", targetTableId: "deal" },
  ],
});
const ids = (groups) => groups.map((group) => [group.app.id, group.endpoints.map((row) => row.endpoint.id)]);

test("app access unions endpoint operations without leaking across endpoints or apps", () => {
  const [a, b, empty] = buildAccessMatrix(model);
  assert.equal(accessLabel(a.access.get("customer")), "RJCUD?");
  assert.equal(accessLabel(a.endpoints.find(row => row.endpoint.id === "read").access.get("customer")), "R");
  assert.equal(accessLabel(a.access.get("deal")), "");
  assert.equal(accessLabel(b.access.get("customer")), "");
  assert.equal(accessLabel(b.access.get("deal")), "C");
  assert.equal(b.endpoints.find(row => row.endpoint.id === "unused").access.size, 0);
  assert.equal(empty.endpoints.length, 0);
  assert.equal(empty.access.size, 0);
  assert.equal(model.relationships[0].operations.length, 1);
});

test("integration calls are tracked per endpoint and unioned per app", () => {
  const [a, b, empty] = buildAccessMatrix(model);
  assert.deepEqual([...a.integrations], ["email"]);
  assert.deepEqual([...a.endpoints.find(row => row.endpoint.id === "read").integrations], []);
  assert.deepEqual([...b.endpoints.find(row => row.endpoint.id === "unused").integrations], ["email"]);
  assert.equal(empty.integrations.size, 0);
});

test("filters distinguish joins and each mutation from direct reads", () => {
  const groups = buildAccessMatrix(model);
  for (const condition of ["join", "create", "update", "delete"]) {
    assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "table", id: "customer", condition }] })), [["a", ["write"]]]);
  }
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "table", id: "deal", condition: "update" }] })), []);
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "table", id: "customer", condition: "read" }] })), [["a", ["read", "write"]]]);
  assert.equal(accessLabel(new Set(["delete", "join", "update", "create", "read"])), "RJCUD");
  assert.equal(accessLabel(new Set(["join"])), "J");
});

test("column filters keep only matching endpoints and drop apps without matches", () => {
  const groups = buildAccessMatrix(model);
  assert.deepEqual(ids(filterMatrix(groups, {})), ids(groups));
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "table", id: "customer", condition: "update" }] })), [["a", ["write"]]]);
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "table", id: "customer", condition: "any" }] })), [["a", ["read", "unknown", "write"]]]);
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "integration", id: "email" }] })), [["a", ["write"]], ["b", ["unused"]]]);
  // Filters combine with AND; a filter on an unused integration matches nothing.
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "integration", id: "email" }, { kind: "table", id: "customer", condition: "read" }] })), [["a", ["write"]]]);
  assert.deepEqual(ids(filterMatrix(groups, { filters: [{ kind: "integration", id: "stripe" }] })), []);
  // Aggregates still describe the whole app.
  assert.equal(accessLabel(filterMatrix(groups, { filters: [{ kind: "integration", id: "email" }] })[0].access.get("customer")), "RJCUD?");
});

test("the text query matches endpoint names, or app names to keep all their endpoints", () => {
  const groups = buildAccessMatrix(model);
  assert.deepEqual(ids(filterMatrix(groups, { query: " wri " })), [["a", ["write"]]]);
  assert.deepEqual(ids(filterMatrix(groups, { query: "app b" })), [["b", ["other", "unused"]]]);
  assert.deepEqual(ids(filterMatrix(groups, { query: "empty" })), [["empty", []]]);
  assert.deepEqual(ids(filterMatrix(groups, { query: "empty", filters: [{ kind: "table", id: "deal", condition: "any" }] })), []);
});

test("used columns only count visible endpoints", () => {
  const groups = buildAccessMatrix(model);
  const all = usedColumns(groups);
  assert.deepEqual([[...all.tables].sort(), [...all.integrations]], [["customer", "deal"], ["email"]]);
  const filtered = usedColumns(filterMatrix(groups, { query: "read" }));
  assert.deepEqual([[...filtered.tables], [...filtered.integrations]], [["customer"], []]);
});
