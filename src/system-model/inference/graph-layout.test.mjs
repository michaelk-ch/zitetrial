import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../schema.ts";
import { edgeKind, graphSizes, layoutGraph, packColumn } from "./graph-layout.ts";

const model = systemModelSchema.parse({
  schemaVersion: 1, repository: { name: "Graph example" },
  callGraph: { entries: [], nodes: [] },
  apps: [
    { id: "admin", name: "Admin", visibility: "internal" },
    { id: "portal", name: "Portal", visibility: "public" },
  ],
  tables: [{ id: "payments", name: "Payments" }, { id: "users", name: "Users" }, { id: "logs", name: "Logs" }],
  integrations: [{ id: "email", name: "Email", category: "email" }],
  endpoints: [
    { id: "listPayments", appId: "admin", name: "listPayments" },
    { id: "refund", appId: "admin", name: "refund" },
    { id: "health", appId: "admin", name: "health" },
    { id: "signup", appId: "portal", name: "signup" },
    { id: "pay", appId: "portal", name: "pay" },
  ],
  relationships: [
    { kind: "table-access", endpointId: "listPayments", tableId: "payments", operations: ["read", "join"] },
    { kind: "table-access", endpointId: "refund", tableId: "payments", operations: ["read", "update"] },
    { kind: "table-access", endpointId: "refund", tableId: "users", operations: ["join"] },
    { kind: "table-access", endpointId: "signup", tableId: "users", operations: ["create"] },
    { kind: "table-access", endpointId: "pay", tableId: "payments", operations: ["create"] },
    { kind: "integration-use", endpointId: "signup", integrationId: "email" },
    { kind: "integration-use", endpointId: "refund", integrationId: "email" },
    { kind: "table-reference", sourceTableId: "payments", targetTableId: "users" },
  ],
});
const edgeSummary = (layout) => layout.edges.map((edge) => `${edge.sourceKey}->${edge.targetKey}:${edge.kind}:${edge.weight}`).sort();
const boxes = (layout) => [...layout.apps, ...layout.tables, ...layout.integrations];

test("joins count as reads; mutations as writes", () => {
  assert.equal(edgeKind(["join"]), "read");
  assert.equal(edgeKind(["read", "update"]), "both");
  assert.equal(edgeKind(["delete"]), "write");
  assert.equal(edgeKind(["unknown"]), "unknown");
});

test("packColumn keeps order and gaps and stays close to the desired tops", () => {
  assert.deepEqual(packColumn([0, 100], [10, 10], 5), [0, 100]);
  assert.deepEqual(packColumn([50, 50, 50], [10, 10, 10], 5), [35, 50, 65]);
  assert.deepEqual(packColumn([100, 0], [10, 10], 0), [45, 55]);
});

test("the default view shows every entity and one aggregated edge per app and target", () => {
  const layout = layoutGraph(model);
  assert.deepEqual(layout.apps.map((app) => [app.app.id, app.expanded, app.rows.length]), [["admin", false, 0], ["portal", false, 0]]);
  assert.deepEqual(layout.columns.map((column) => column.kind), ["tables", "apps", "integrations"]);
  assert.deepEqual(edgeSummary(layout), [
    "app:admin->integration:email:call:1",
    "app:admin->table:payments:both:2",
    "app:admin->table:users:read:1",
    "app:portal->integration:email:call:1",
    "app:portal->table:payments:write:1",
    "app:portal->table:users:write:1",
  ]);
  assert.deepEqual(layout.apps[0].stats, { reads: 2, writes: 1, calls: 1 });
  // The unused table is listed after the connected ones.
  assert.equal(layout.tables.at(-1).entity.id, "logs");
  assert.deepEqual(layout.tables.find((table) => table.entity.id === "payments").usage, { apps: 2, endpoints: 3, readers: 2, writers: 2 });
});

test("focusing an app expands its endpoints and keeps only the tables and integrations it uses", () => {
  const layout = layoutGraph(model, { kind: "app", id: "admin" });
  assert.equal(layout.apps.length, 1);
  const [admin] = layout.apps;
  assert.equal(admin.expanded, true);
  assert.deepEqual(admin.rows.map((row) => [row.endpoint.id, row.connected]).sort(), [["health", false], ["listPayments", true], ["refund", true]]);
  // Endpoints without connections go last.
  assert.equal(admin.rows.at(-1).endpoint.id, "health");
  assert.deepEqual(layout.tables.map((table) => table.entity.id).sort(), ["payments", "users"]);
  assert.deepEqual(edgeSummary(layout), [
    "endpoint:listPayments->table:payments:read:1",
    "endpoint:refund->integration:email:call:1",
    "endpoint:refund->table:payments:both:1",
    "endpoint:refund->table:users:read:1",
  ]);
});

test("focusing a table shows only the apps and endpoints that access it, with their operations", () => {
  const layout = layoutGraph(model, { kind: "table", id: "payments" });
  assert.deepEqual(layout.columns.map((column) => column.kind), ["tables", "apps"]);
  assert.deepEqual(layout.tables.map((table) => table.entity.id), ["payments"]);
  assert.deepEqual(layout.apps.map((app) => [app.app.id, app.rows.map((row) => [row.endpoint.id, row.operations])]), [
    ["admin", [["listPayments", ["read", "join"]], ["refund", ["read", "update"]]]],
    ["portal", [["pay", ["create"]]]],
  ]);
  assert.equal(layout.integrations.length, 0);
  assert.equal(layout.edges.length, 3);
});

test("focusing an integration shows only the endpoints that call it", () => {
  const layout = layoutGraph(model, { kind: "integration", id: "email" });
  assert.deepEqual(layout.columns.map((column) => column.kind), ["apps", "integrations"]);
  assert.deepEqual(layout.apps.map((app) => [app.app.id, app.rows.map((row) => row.endpoint.id)]), [["admin", ["refund"]], ["portal", ["signup"]]]);
  assert.deepEqual(edgeSummary(layout), ["endpoint:refund->integration:email:call:1", "endpoint:signup->integration:email:call:1"]);
});

test("an unknown focus falls back to the default view", () => {
  assert.deepEqual(layoutGraph(model, { kind: "table", id: "missing" }), layoutGraph(model));
});

for (const focus of [null, { kind: "app", id: "admin" }, { kind: "table", id: "users" }, { kind: "integration", id: "email" }]) {
  test(`boxes never overlap and edges attach to box sides (${focus?.kind ?? "default"})`, () => {
    const top = 100;
    const layout = layoutGraph(model, focus, { top });
    assert.equal(Math.min(...boxes(layout).map((box) => box.y)), top);
    for (const column of [layout.apps, layout.tables, layout.integrations]) {
      const sorted = [...column].sort((a, b) => a.y - b.y);
      for (let index = 1; index < sorted.length; index++) assert.ok(sorted[index].y >= sorted[index - 1].y + sorted[index - 1].h);
    }
    const byKey = new Map(boxes(layout).map((box) => [box.key, box]));
    for (const edge of layout.edges) {
      const app = byKey.get(edge.appKey);
      const target = byKey.get(edge.targetKey);
      assert.equal(edge.x1, target.x < app.x ? app.x : app.x + app.w);
      assert.equal(edge.x2, target.x < app.x ? target.x + target.w : target.x);
      assert.ok(edge.y1 >= app.y && edge.y1 <= app.y + app.h);
      assert.ok(edge.y2 >= target.y && edge.y2 <= target.y + target.h);
    }
    assert.ok(layout.width >= graphSizes.minWidth);
  });
}
