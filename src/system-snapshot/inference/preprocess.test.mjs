import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../system-model.ts";
import { accessModes, preprocess } from "./preprocess.ts";

const model = systemModelSchema.parse({
  schemaVersion: 1, repository: { name: "Preprocess example" },
  callGraph: { entries: [], nodes: [] },
  apps: [{ id: "admin", name: "Admin", visibility: "internal" }, { id: "portal", name: "Portal", visibility: "public" }],
  tables: [{ id: "users", name: "Users" }, { id: "payments", name: "Payments" }, { id: "logs", name: "Logs" }],
  integrations: [{ id: "stripe", name: "Stripe" }, { id: "email", name: "Email" }],
  endpoints: [
    { id: "refund", appId: "admin", name: "refund" },
    { id: "seed", appId: "admin", name: "seed" },
    { id: "signup", appId: "portal", name: "signup" },
  ],
  relationships: [
    { kind: "table-access", endpointId: "refund", tableId: "payments", operations: ["read", "update"] },
    { kind: "table-access", endpointId: "refund", tableId: "users", operations: ["join"] },
    { kind: "table-access", endpointId: "signup", tableId: "users", operations: ["create"] },
    { kind: "integration-use", endpointId: "signup", integrationId: "email" },
    { kind: "table-access", endpointId: "seed", tableId: "logs", operations: ["create"] },
  ],
});
// Only the fields the views use; usages are keyed by endpoint, target and operation.
const usage = (id, endpointId, kind, targetId, operation = null) => ({ id, endpointId, target: { kind, id: targetId }, operation });
const accesses = (roles) => ({ primary: [], supporting: [], secondary: [], uncertain: [], ...roles });
const interpretation = {
  endpoints: [
    { endpointId: "refund", prominence: "core", accesses: accesses({ primary: ["u1"], supporting: ["u2", "u3"] }) },
    { endpointId: "seed", prominence: "utility", accesses: accesses({ primary: ["u4"] }) },
    { endpointId: "signup", prominence: "uncertain", accesses: accesses({ uncertain: ["u5"], secondary: ["u6"] }) },
  ],
  usages: [
    usage("u1", "refund", "table", "payments", "update"), usage("u2", "refund", "table", "payments", "read"),
    usage("u3", "refund", "table", "users", "join"), usage("u4", "seed", "table", "logs", "create"),
    usage("u5", "signup", "table", "users", "create"), usage("u6", "signup", "integration", "email"),
  ],
};
const snapshot = { analysis: model, interpretation };
const all = accessModes.all;
const ids = ({ tables, integrations }) => [tables.map((table) => table.id), integrations.map((integration) => integration.id)];
const access = ({ groups }) => groups.flatMap((group) => group.endpoints.map((row) => [row.endpoint.id, [...row.access].map(([id, ops]) => `${id}:${[...ops]}`)]));

test("without options every operation, table and integration is kept, sorted by name", () => {
  const result = preprocess(snapshot, all);
  assert.deepEqual(ids(result), [["logs", "payments", "users"], ["email", "stripe"]]);
  assert.deepEqual(access(result), [["refund", ["payments:read,update", "users:join"]], ["seed", ["logs:create"]], ["signup", ["users:create"]]]);
});

test("showJoins, prioritize and hideUnused are applied per endpoint before tables are hidden", () => {
  assert.deepEqual(access(preprocess(snapshot, { ...all, showJoins: false })), [["refund", ["payments:read,update"]], ["seed", ["logs:create"]], ["signup", ["users:create"]]]);
  assert.deepEqual(access(preprocess(snapshot, { ...all, prioritize: true })), [["refund", ["payments:update"]], ["seed", ["logs:create"]], ["signup", ["users:create"]]]);
  assert.deepEqual(ids(preprocess(snapshot, { ...all, hideUnused: true })), [["logs", "payments", "users"], ["email"]]);
  assert.deepEqual(ids(preprocess(snapshot, accessModes.filtered)), [["logs", "payments", "users"], ["email"]]);
});

test("interpreted mode hides utility endpoints and keeps each endpoint's highest-role usages", () => {
  const result = preprocess(snapshot, accessModes.interpreted);
  // Utility seed is gone with its only table; signup has no primary usage, so its uncertain one wins over the secondary call.
  assert.deepEqual(access(result), [["refund", ["payments:update"]], ["signup", ["users:create"]]]);
  assert.deepEqual(ids(result), [["payments", "users"], []]);
  // A primary join stays hidden without joins, so the next role's usages are kept instead.
  const joins = { ...interpretation, endpoints: [{ ...interpretation.endpoints[0], accesses: accesses({ primary: ["u3"], secondary: ["u1", "u2"] }) }, ...interpretation.endpoints.slice(1)] };
  assert.deepEqual(access(preprocess({ analysis: model, interpretation: joins }, accessModes.interpreted)), [["refund", ["payments:read,update"]], ["signup", ["users:create"]]]);
  assert.deepEqual(access(preprocess({ analysis: model, interpretation: joins }, { ...accessModes.interpreted, showJoins: true })), [["refund", ["users:join"]], ["signup", ["users:create"]]]);
});

test("the filter narrows endpoints and the unused columns follow, except filtered columns", () => {
  const hide = { ...all, hideUnused: true };
  const byQuery = preprocess(snapshot, hide, { query: "signup" });
  assert.deepEqual(access(byQuery), [["signup", ["users:create"]]]);
  assert.deepEqual(ids(byQuery), [["users"], ["email"]]);
  const byColumn = preprocess(snapshot, hide, { filters: [{ kind: "integration", id: "stripe" }] });
  assert.deepEqual(byColumn.groups, []);
  assert.deepEqual(ids(byColumn), [[], ["stripe"]]);
});
