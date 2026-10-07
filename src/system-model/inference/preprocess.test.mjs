import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../schema.ts";
import { preprocess } from "./preprocess.ts";

const model = systemModelSchema.parse({
  schemaVersion: 1, repository: { name: "Preprocess example" },
  callGraph: { entries: [], nodes: [] },
  apps: [{ id: "admin", name: "Admin", visibility: "internal" }, { id: "portal", name: "Portal", visibility: "public" }],
  tables: [{ id: "users", name: "Users" }, { id: "payments", name: "Payments" }, { id: "logs", name: "Logs" }],
  integrations: [{ id: "stripe", name: "Stripe" }, { id: "email", name: "Email" }],
  endpoints: [
    { id: "refund", appId: "admin", name: "refund" },
    { id: "signup", appId: "portal", name: "signup" },
  ],
  relationships: [
    { kind: "table-access", endpointId: "refund", tableId: "payments", operations: ["read", "update"] },
    { kind: "table-access", endpointId: "refund", tableId: "users", operations: ["join"] },
    { kind: "table-access", endpointId: "signup", tableId: "users", operations: ["create"] },
    { kind: "integration-use", endpointId: "signup", integrationId: "email" },
  ],
});
const all = { showJoins: true, prioritize: false, hideUnused: false };
const ids = ({ tables, integrations }) => [tables.map((table) => table.id), integrations.map((integration) => integration.id)];
const access = ({ groups }) => groups.flatMap((group) => group.endpoints.map((row) => [row.endpoint.id, [...row.access].map(([id, ops]) => `${id}:${[...ops]}`)]));

test("without options every operation, table and integration is kept, sorted by name", () => {
  const result = preprocess(model, all);
  assert.deepEqual(ids(result), [["logs", "payments", "users"], ["email", "stripe"]]);
  assert.deepEqual(access(result), [["refund", ["payments:read,update", "users:join"]], ["signup", ["users:create"]]]);
});

test("showJoins, prioritize and hideUnused are applied per endpoint before tables are hidden", () => {
  assert.deepEqual(access(preprocess(model, { ...all, showJoins: false })), [["refund", ["payments:read,update"]], ["signup", ["users:create"]]]);
  assert.deepEqual(access(preprocess(model, { ...all, prioritize: true })), [["refund", ["payments:update"]], ["signup", ["users:create"]]]);
  assert.deepEqual(ids(preprocess(model, { ...all, hideUnused: true })), [["payments", "users"], ["email"]]);
});

test("the filter narrows endpoints and the unused columns follow, except filtered columns", () => {
  const hide = { ...all, hideUnused: true };
  const byQuery = preprocess(model, hide, { query: "signup" });
  assert.deepEqual(access(byQuery), [["signup", ["users:create"]]]);
  assert.deepEqual(ids(byQuery), [["users"], ["email"]]);
  const byColumn = preprocess(model, hide, { filters: [{ kind: "integration", id: "stripe" }] });
  assert.deepEqual(byColumn.groups, []);
  assert.deepEqual(ids(byColumn), [[], ["stripe"]]);
});
