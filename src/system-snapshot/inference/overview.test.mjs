import assert from "node:assert/strict";
import test from "node:test";
import { systemModelSchema } from "../system-model.ts";
import { buildOverview, overviewLimits } from "./overview.ts";
import { accessModes, preprocess } from "./preprocess.ts";

const analysis = systemModelSchema.parse({
  schemaVersion: 1, repository: { name: "Overview example" },
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
    { id: "audit", appId: "admin", name: "audit" },
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
  ],
});
const endpoint = (endpointId, capabilityId, prominence) => ({
  endpointId, purpose: `Purpose of ${endpointId}.`, capabilityId, prominence,
  accesses: { primary: [], supporting: [], secondary: [], uncertain: [] }, notes: [],
});
// Only the fields the overview reads; usages are irrelevant here.
const interpretation = {
  apps: [{ appId: "admin", purpose: "Back office." }, { appId: "portal", purpose: "Customer portal." }],
  capabilities: [
    { id: "billing", label: "Billing", purpose: "Take and refund payments." },
    { id: "ops", label: "Operations", purpose: "Keep the system healthy." },
  ],
  endpoints: [
    endpoint("listPayments", "billing", "supporting"), endpoint("refund", "billing", "core"), endpoint("pay", "billing", "core"),
    endpoint("health", "ops", "utility"), endpoint("audit", "ops", "core"), endpoint("signup", null, "core"),
  ],
  usages: [],
};
const snapshot = { analysis, interpretation };
const data = (focused = false) => preprocess(snapshot, { ...accessModes.filtered, hideUnused: !focused });
const chips = (card) => card.chips.map((chip) => [chip.label, ...chip.badges.map((badge) => badge.label)].join(" "));
const cardsOf = (overview, id) => overview.sections.find((section) => section.id === id)?.cards ?? [];

test("the default view has database, integrations, applications, and capabilities sections", () => {
  const overview = buildOverview(snapshot, data());
  assert.deepEqual(overview.sections.map((section) => section.id), ["database", "integrations", "applications", "capabilities"]);
  const [database] = cardsOf(overview, "database");
  // Filtered mode hides the unused Logs table.
  assert.deepEqual(chips(database), ["Payments", "Users"]);
  assert.equal(database.limit, overviewLimits.tables);
  assert.deepEqual(chips(cardsOf(overview, "integrations")[0]), ["Admin", "Portal"]);

  const [admin, portal] = cardsOf(overview, "applications");
  assert.deepEqual(admin.badges, [{ label: "Internal", tone: "internal" }]);
  assert.equal(admin.description, "Back office.");
  assert.equal(admin.limit, overviewLimits.appEndpoints);
  // Endpoints are ordered by prominence (core first), then name.
  assert.deepEqual(chips(admin), ["audit", "refund", "listPayments", "health"]);
  assert.equal(admin.chips.find((chip) => chip.label === "health").muted, true);
  assert.deepEqual(portal.badges, [{ label: "Public", tone: "public" }]);

  const capabilities = cardsOf(overview, "capabilities");
  assert.deepEqual(capabilities.map((card) => [card.title, card.description]), [["Billing", "Take and refund payments."], ["Operations", "Keep the system healthy."]]);
  assert.deepEqual(capabilities[0].chips.map((chip) => `${chip.prefix}/${chip.label}`), ["Portal/pay", "Admin/refund", "Admin/listPayments"]);
  assert.equal(capabilities[0].limit, overviewLimits.capabilityEndpoints);
});

test("focusing a table lists the endpoints that use it with CRUD badges and drops capabilities", () => {
  const overview = buildOverview(snapshot, data(true), { kind: "table", id: "payments" });
  assert.deepEqual(overview.sections.map((section) => section.id), ["database", "applications"]);
  assert.deepEqual(cardsOf(overview, "database").map((card) => [card.title, card.focused]), [["Payments", true]]);
  const apps = cardsOf(overview, "applications");
  assert.deepEqual(apps.map((card) => [card.title, card.subtitle, card.limit]), [["Admin", "2 of 4 endpoints", undefined], ["Portal", "1 of 2 endpoints", undefined]]);
  assert.deepEqual(apps.map(chips), [["refund RU", "listPayments R"], ["pay C"]]);
  assert.deepEqual(apps[0].chips[0].badges[0], { label: "RU", tone: "write", title: "refund reads, updates Payments" });
  assert.equal(overview.header.subtitle, "Used by 2 apps · read by 2 endpoints · written by 2 endpoints");
});

test("focusing an integration lists the endpoints that call it", () => {
  const overview = buildOverview(snapshot, data(true), { kind: "integration", id: "email" });
  assert.deepEqual(overview.sections.map((section) => section.id), ["integrations", "applications"]);
  assert.equal(cardsOf(overview, "integrations")[0].focused, true);
  assert.deepEqual(cardsOf(overview, "applications").map(chips), [["refund"], ["signup"]]);
});

test("focusing an app filters the database and integrations and lists all its endpoints", () => {
  const overview = buildOverview(snapshot, data(true), { kind: "app", id: "admin" });
  assert.deepEqual(overview.sections.map((section) => section.id), ["database", "integrations", "applications"]);
  // Filtered mode drops the join on Users, so Admin only uses Payments.
  assert.deepEqual(chips(cardsOf(overview, "database")[0]), ["Payments RU"]);
  assert.deepEqual(cardsOf(overview, "integrations").map((card) => card.subtitle), ["Email · called by 1 endpoint"]);
  const [admin] = cardsOf(overview, "applications");
  assert.equal(admin.focused, true);
  assert.equal(admin.limit, undefined);
  assert.deepEqual(chips(admin), ["audit", "refund", "listPayments", "health"]);
  assert.ok(admin.chips.every((chip) => chip.focus === undefined));
});

test("hover tracing links endpoints to their app and targets, and apps to their targets", () => {
  const { related } = buildOverview(snapshot, data());
  assert.deepEqual([...related.get("endpoint:refund")].sort(), ["app:admin", "endpoint:refund", "integration:email", "table:payments"]);
  assert.deepEqual([...related.get("table:users")].sort(), ["app:portal", "endpoint:signup", "table:users"]);
  assert.equal(related.has("table:logs"), false);
});
