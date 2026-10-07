import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../schema.ts";
import { accessLabel, buildAccessMatrix } from "./access-matrix.ts";

test("app access unions endpoint operations without leaking across endpoints or apps", () => {
  const model = systemModelSchema.parse({
    schemaVersion: 1, repository: { name: "Matrix example" },
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
    integrations: [{ id: "email", name: "Email" }],
    relationships: [
      { kind: "table-access", endpointId: "read", tableId: "customer", operations: ["read"] },
      { kind: "table-access", endpointId: "write", tableId: "customer", operations: ["read", "write"] },
      { kind: "table-access", endpointId: "unknown", tableId: "customer", operations: ["unknown"] },
      { kind: "table-access", endpointId: "other", tableId: "deal", operations: ["write"] },
      { kind: "integration-use", endpointId: "unused", integrationId: "email" },
    ],
  });
  const [a, b, empty] = buildAccessMatrix(model);
  assert.equal(accessLabel(a.access.get("customer")), "R, W, ?");
  assert.equal(accessLabel(a.endpoints.find(row => row.endpoint.id === "read").access.get("customer")), "R");
  assert.equal(accessLabel(a.access.get("deal")), "");
  assert.equal(accessLabel(b.access.get("customer")), "");
  assert.equal(accessLabel(b.access.get("deal")), "W");
  assert.equal(b.endpoints.find(row => row.endpoint.id === "unused").access.size, 0);
  assert.equal(empty.endpoints.length, 0);
  assert.equal(empty.access.size, 0);
  assert.equal(model.relationships[0].operations.length, 1);
});
