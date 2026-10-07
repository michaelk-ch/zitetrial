import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSystemSnapshot } from "./build.ts";
import { systemSnapshotSchema } from "./index.ts";
import { interpretationSchema } from "./interpretation.ts";
import { systemModelSchema } from "./system-model.ts";

function snapshot() {
  const analysis = systemModelSchema.parse({
    schemaVersion: 1, repository: { name: "Example" },
    apps: [{ id: "staff", name: "Staff", visibility: "internal" }],
    tables: [{ id: "companies", name: "Companies" }], integrations: [],
    endpoints: [{ id: "create", name: "createCompany", appId: "staff" }],
    relationships: [{ kind: "table-access", endpointId: "create", tableId: "companies", operations: ["create"] }],
    callGraph: { entries: [{ endpointId: "create", nodeId: "entry" }], nodes: [{
      id: "entry", name: "execute", arguments: {}, calls: [],
      accesses: [{ kind: "table-access", tableId: "companies", operation: "create" }],
    }] },
  });
  const interpretation = {
    schemaVersion: 1, inputHash: "hash", model: "test", version: 2, createdAt: "2026-10-07T00:00:00Z",
    apps: [{ appId: "staff", purpose: "Manage companies." }],
    capabilities: [{ id: "companies", label: "Manage companies", purpose: "Create and manage companies." }],
    endpoints: [{ endpointId: "create", purpose: "Create a company.", capabilityId: "companies", prominence: "core",
      accesses: { primary: ["u1"], supporting: [], secondary: [], uncertain: [] }, notes: [] }],
    usages: [{ id: "u1", endpointId: "create", target: { kind: "table", id: "companies" }, operation: "create",
      entryNodeId: "entry", branchCallIndex: null, sources: [{ nodeId: "entry", accessIndex: 0 }], paths: [["entry"]] }],
    tokens: { input: 100, output: 20 },
  };
  return { analysis, interpretation };
}

test("interpretation refinements reject incomplete, duplicate, and dangling classifications", () => {
  const valid = snapshot().interpretation;
  assert.deepEqual(interpretationSchema.parse(valid), valid);
  for (const mutate of [
    (r) => r.endpoints[0].accesses.primary.pop(),
    (r) => r.endpoints[0].accesses.secondary.push("u1"),
    (r) => r.endpoints[0].notes.push({ usages: ["missing"], text: "Unknown usage." }),
    (r) => r.endpoints[0].capabilityId = "missing",
    (r) => r.usages[0].endpointId = "missing",
    (r) => r.usages.push(r.usages[0]),
    (r) => r.apps.push(r.apps[0]),
    (r) => r.endpoints.push(r.endpoints[0]),
    (r) => r.capabilities.push(r.capabilities[0]),
    (r) => r.capabilities.push({ id: "unused", label: "Unused", purpose: "Unused capability." }),
    (r) => r.apps[0].purpose = " ",
    (r) => r.tokens.input = -1,
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const result = interpretationSchema.safeParse(invalid);
    assert.equal(result.success, false);
    assert.ok(result.error.issues.every((issue) => issue.path.length > 0));
  }
});

test("snapshot refinements bind both stages to the same entities and call provenance", () => {
  assert.deepEqual(systemSnapshotSchema.parse(snapshot()), snapshot());
  for (const mutate of [
    (s) => delete s.interpretation,
    (s) => s.interpretation.apps[0].appId = "wrong-app",
    (s) => s.analysis.endpoints.push({ id: "extra", name: "Extra", appId: "staff", evidence: [] }),
    (s) => s.interpretation.usages[0].target.id = "missing",
    (s) => s.interpretation.usages[0].operation = "read",
    (s) => s.interpretation.usages[0].sources[0].accessIndex = 1,
    (s) => s.interpretation.usages[0].entryNodeId = "missing",
    (s) => s.interpretation.usages[0].branchCallIndex = 5,
    (s) => s.interpretation.usages[0].paths = [["entry", "missing"]],
    (s) => s.interpretation.usages[0].entryNodeId = null,
  ]) {
    const invalid = snapshot();
    mutate(invalid);
    assert.equal(systemSnapshotSchema.safeParse(invalid).success, false);
  }
});

async function pipeline(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zite-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.ts"), "First version");
  const calls = { analysis: 0, ai: 0 };
  const options = { cacheDirectory: path.join(root, ".cache"),
    analyze: async (directory) => {
      calls.analysis++;
      const model = snapshot().analysis;
      model.repository.name = await readFile(path.join(directory, "source.ts"), "utf8");
      return model;
    },
    generate: async (request) => {
      calls.ai++;
      const input = request.input;
      const value = request.format.name === "endpoint_interpretations"
        ? { endpoints: Object.fromEntries(input.endpoints.map((e) => [e.ref, {
          purpose: "Create a company.", accesses: Object.fromEntries(e.usages.map((u) => [u.ref, "primary"])), notes: [],
        }])) }
        : { apps: Object.fromEntries(input.apps.map((a) => [a.ref, { purpose: "Manage companies." }])),
          capabilities: [{ id: "companies", label: "Companies", purpose: "Manage companies." }],
          endpoints: Object.fromEntries(input.endpoints.map((e) => [e.ref, { capability: "companies", prominence: "core" }])) };
      return { value, tokens: { input: 100, output: 20 } };
    },
  };
  return { root, calls, options };
}

test("pipeline caches both stages, shares concurrent work, and invalidates replaced source contents", async (t) => {
  const { root, calls, options } = await pipeline(t);
  const [first, concurrent] = await Promise.all([buildSystemSnapshot(root, options), buildSystemSnapshot(root, options)]);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(calls, { analysis: 1, ai: 2 });
  const unexpected = async () => { throw new Error("Unexpected cache miss"); };
  const cachedOptions = { ...options, apiKey: "", analyze: unexpected, generate: unexpected };
  assert.deepEqual(await buildSystemSnapshot(root, cachedOptions), first);
  // Installed dependencies and generated files are not analyzer inputs.
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "ignored.ts"), "ignored");
  assert.deepEqual(await buildSystemSnapshot(root, cachedOptions), first);
  await writeFile(path.join(root, "source.ts"), "Second version");
  const changed = await buildSystemSnapshot(root, options);
  assert.equal(changed.analysis.repository.name, "Second version");
  assert.notEqual(changed.interpretation.inputHash, first.interpretation.inputHash);
  assert.deepEqual(calls, { analysis: 2, ai: 4 });
});

test("failed interpretation returns no partial snapshot and a retry reuses successful analysis", async (t) => {
  const { root, calls, options } = await pipeline(t);
  await assert.rejects(buildSystemSnapshot(root, { ...options, generate: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
  assert.equal(calls.analysis, 1);
  const result = await buildSystemSnapshot(root, options);
  assert.equal(result.interpretation.endpoints.length, 1);
  assert.deepEqual(calls, { analysis: 1, ai: 2 });
});
