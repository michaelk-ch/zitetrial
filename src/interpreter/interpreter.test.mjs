import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { systemModelSchema } from "../system-snapshot/system-model.ts";
import { interpretSystem, readInterpretation } from "./index.ts";
import { endpointOutput, overviewOutput } from "./format.ts";
import { openAIGenerator } from "./openai.ts";
import { endpointBatches, endpointInput, prepareInterpretation } from "./prepare.ts";
import { endpointResponseSchemaFor, overviewResponseSchemaFor } from "./responses.ts";

function fixture(count = 1) {
  const access = (tableId, operation) => ({ kind: "table-access", tableId, operation, evidence: ['data.ts:1'] });
  const call = (nodeId) => ({ nodeId, kind: "call", evidence: ['api.ts:1'] });
  const node = (id, name, accesses, calls = [], args = {}) => ({ id, name, accesses, calls, arguments: args, evidence: ['data.ts:1'] });
  const endpoints = Array.from({ length: count }, (_, i) => ({ id: `endpoint:${String(i).padStart(2, '0')}`, appId: 'staff', name: `createCompany${i}`, description: 'Create a company' }));
  return systemModelSchema.parse({
    schemaVersion: 1, repository: { name: 'CRM' }, apps: [{ id: 'staff', name: 'Staff', visibility: 'internal' }],
    tables: [{ id: 'companies', name: 'Companies' }, { id: 'events', name: 'Events' }], integrations: [], endpoints,
    relationships: endpoints.flatMap((e) => [
      { kind: 'table-access', endpointId: e.id, tableId: 'companies', operations: ['create', 'read'] },
      { kind: 'table-access', endpointId: e.id, tableId: 'events', operations: ['create'] },
    ]),
    callGraph: {
      entries: endpoints.map((e) => ({ endpointId: e.id, nodeId: e.id })),
      nodes: [
        ...endpoints.map((e) => node(e.id, 'execute', [access('companies', 'read')], [call('create'), call('automation')])),
        node('create', 'getOrCreateCompany', [access('companies', 'create')]),
        node('automation', 'runTrigger', [access('companies', 'read')], [call('audit'), call('automation')], { trigger: 'company.created', large: 'x'.repeat(200) }),
        node('audit', 'logEvent', [access('events', 'create')]),
      ],
    },
  });
}

function endpointReply(input) {
  return { endpoints: input.endpoints.map((e) => ({ endpoint: e.ref, purpose: 'Create a company.',
    accesses: { primary: e.usages.filter((u) => u.operation === 'create' && u.target === 't1').map((u) => u.ref),
      supporting: e.usages.filter((u) => u.paths[0]?.via.length === 1).map((u) => u.ref),
      secondary: e.usages.filter((u) => !(u.operation === 'create' && u.target === 't1') && u.paths[0]?.via.length !== 1).map((u) => u.ref), uncertain: [] }, notes: [] })) };
}
function overviewReply(input) {
  return { apps: input.apps.map((a) => ({ app: a.ref, purpose: 'Manage customer relationships.' })),
    capabilities: input.endpoints.length ? [{ id: 'companies', label: 'Manage companies', purpose: 'Create and maintain company records.' }] : [],
    endpoints: input.endpoints.map((e) => ({ endpoint: e.ref, capability: 'companies', prominence: 'core' })) };
}
function wireReply(reply) {
  return reply.apps ? {
    apps: Object.fromEntries(reply.apps.map(({ app, ...detail }) => [app, detail])),
    capabilities: reply.capabilities,
    endpoints: Object.fromEntries(reply.endpoints.map(({ endpoint, ...detail }) => [endpoint, detail])),
  } : { endpoints: Object.fromEntries(reply.endpoints.map(({ endpoint, accesses, ...detail }) => [endpoint, {
    ...detail, accesses: Object.fromEntries(Object.entries(accesses).flatMap(([role, refs]) => refs.map((ref) => [ref, role]))),
  }])) };
}
function generator(calls) {
  return async (request) => {
    calls.push(request);
    const input = request.input.data ?? request.input;
    return { value: wireReply(request.format.name === 'endpoint_interpretations' ? endpointReply(input) : overviewReply(input)), tokens: { input: 100, output: 20 } };
  };
}
async function cache(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zite-interpretation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('preserves different entry branches to the same table and bounds recursive provenance', () => {
  const model = fixture();
  const prepared = prepareInterpretation(model);
  const reads = prepared.usages.filter((u) => u.target.id === 'companies' && u.operation === 'read');
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map((u) => u.branchCallIndex), [null, 1]);
  assert.deepEqual(reads[1].paths, [['endpoint:00', 'automation']]);
  const input = endpointInput(prepared, prepared.endpoints);
  const trigger = input.functions.find((f) => f.name === 'runTrigger');
  assert.deepEqual(trigger.arguments, { trigger: 'company.created' });
  assert.equal(trigger.omittedArguments, 1);
  assert.ok(!JSON.stringify(input).includes('data.ts:1'));
  assert.deepEqual(prepareInterpretation(model).usages, prepared.usages);
  assert.equal(endpointBatches(prepareInterpretation(fixture(10))).length, 2);
  assert.equal(endpointBatches(prepared, 8, 1).length, 1, 'oversized endpoints retain every usage');

  model.callGraph = { entries: [], nodes: [] };
  const untraced = prepareInterpretation(model).usages;
  assert.equal(untraced.length, 3);
  assert.ok(untraced.every((u) => u.entryNodeId === null && u.paths.length === 0));
});

test('validates coverage, roles, and references across both AI passes', () => {
  const prepared = prepareInterpretation(fixture(2));
  const input = endpointInput(prepared, prepared.endpoints);
  for (const mutate of [
    (r) => r.endpoints.pop(),
    (r) => r.endpoints.push(r.endpoints[0]),
    (r) => r.endpoints[0].accesses.primary.push(r.endpoints[0].accesses.primary[0]),
    (r) => r.endpoints[0].accesses.primary.push('missing'),
    (r) => r.endpoints[0].accesses.primary.push(r.endpoints[1].accesses.primary[0]),
    (r) => r.endpoints[0].notes.push({ usages: ['missing'], text: 'Ambiguous.' }),
  ]) {
    const reply = endpointReply(input);
    mutate(reply);
    assert.throws(() => endpointResponseSchemaFor(prepared.endpoints).parse(reply));
  }
  for (const mutate of [
    (r) => r.apps.pop(),
    (r) => r.endpoints[0].capability = 'missing',
    (r) => r.capabilities.push(r.capabilities[0]),
    (r) => r.endpoints[0].prominence = 'important',
  ]) {
    const reply = overviewReply(input);
    mutate(reply);
    assert.throws(() => overviewResponseSchemaFor(prepared).parse(reply));
  }
});

test('API schemas require exact aliases and one role for every usage, including endpoints without accesses', () => {
  const model = fixture(3);
  model.relationships = model.relationships.filter((r) => r.endpointId !== 'endpoint:02');
  model.callGraph.entries = model.callGraph.entries.filter((e) => e.endpointId !== 'endpoint:02');
  const prepared = prepareInterpretation(model);
  const input = endpointInput(prepared, prepared.endpoints);
  const endpoints = endpointOutput(prepared.endpoints);
  const reply = endpointReply(input);
  const wire = wireReply(reply);
  assert.deepEqual(endpoints.parse(wire), reply);
  assert.deepEqual(wire.endpoints.e3.accesses, {});
  const schema = endpoints.format.schema;
  assert.deepEqual(schema.properties.endpoints.required, ['e1', 'e2', 'e3']);
  assert.deepEqual(schema.properties.endpoints.properties.e1.properties.accesses.required, input.endpoints[0].usages.map((u) => u.ref));
  for (const mutate of [
    (r) => delete r.endpoints.e1,
    (r) => r.endpoints.createCompany0 = r.endpoints.e1,
    (r) => delete r.endpoints.e1.accesses.u1,
    (r) => r.endpoints.e1.accesses.t1 = 'primary',
    (r) => r.endpoints.e1.accesses.u1 = 'essential',
    (r) => r.endpoints.e1.accesses.u5 = 'primary',
    (r) => r.endpoints.e1.notes.push({ usages: ['u5'], text: 'Wrong endpoint.' }),
    (r) => r.endpoints.e3.accesses.u1 = 'primary',
  ]) {
    const invalid = structuredClone(wire);
    mutate(invalid);
    assert.throws(() => endpoints.parse(invalid));
  }
  const overview = overviewOutput(prepared);
  const summary = overviewReply(input);
  assert.deepEqual(overview.parse(wireReply(summary)), summary);
  const wrongApp = wireReply(summary);
  wrongApp.apps.Staff = wrongApp.apps.a1;
  delete wrongApp.apps.a1;
  assert.throws(() => overview.parse(wrongApp));
  const wrongEndpoint = wireReply(summary);
  delete wrongEndpoint.endpoints.e3;
  assert.throws(() => overview.parse(wrongEndpoint));
});

test('coverage errors identify the endpoint and exact missing and incorrect usage references', () => {
  const prepared = prepareInterpretation(fixture());
  const reply = endpointReply(endpointInput(prepared, prepared.endpoints));
  reply.endpoints[0].accesses.primary = ['t1'];
  assert.throws(() => endpointResponseSchemaFor(prepared.endpoints).parse(reply), /missing: u2; unknown: t1/);
});

test('caches complete interpretations without a key and invalidates only changed batches', async (t) => {
  const directory = await cache(t);
  const model = fixture(10);
  const calls = [];
  const options = { cacheDirectory: directory, generate: generator(calls) };
  assert.equal(await readInterpretation(model, options), null);
  const result = await interpretSystem(model, options);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.tokens, { input: 300, output: 60 });
  assert.equal(result.endpoints[0].endpointId, 'endpoint:00');
  assert.deepEqual(await interpretSystem(model, { cacheDirectory: directory, apiKey: '' }), result);
  assert.deepEqual(await readInterpretation(model, options), result);
  assert.equal(calls.length, 3);

  model.endpoints[9].description = 'Create a company, allowing duplicate names.';
  assert.equal(await readInterpretation(model, options), null);
  const changed = await interpretSystem(model, options);
  // Endpoint purposes from this test double are identical, so synthesis itself is reusable.
  assert.equal(calls.length, 4);
  assert.notEqual(changed.inputHash, result.inputHash);
  await interpretSystem(model, { ...options, model: 'another-model' });
  assert.equal(calls.length, 7);
});

test('resumes after a failed batch and deduplicates concurrent runs', async (t) => {
  const directory = await cache(t);
  const model = fixture(10);
  const calls = [];
  const good = generator(calls);
  let requests = 0;
  await assert.rejects(interpretSystem(model, { cacheDirectory: directory, generate: async (request) => {
    if (++requests === 2) throw new Error('Temporary failure');
    return good(request);
  } }), /Temporary failure/);
  assert.equal(calls.length, 1);
  assert.equal(await readInterpretation(model, { cacheDirectory: directory }), null);
  const [a, b] = await Promise.all([
    interpretSystem(model, { cacheDirectory: directory, generate: good }),
    interpretSystem(model, { cacheDirectory: directory, generate: good }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3, 'first batch is reused and concurrent runs share remaining requests');
  assert.ok((await readdir(directory)).every((name) => name.endsWith('.json')));
});

test('rejects invalid AI results after one retry and does not cache them', async (t) => {
  const directory = await cache(t);
  let calls = 0;
  await assert.rejects(interpretSystem(fixture(), { cacheDirectory: directory, generate: async () => {
    calls++;
    return { value: { endpoints: [] }, tokens: { input: 10, output: 2 } };
  } }), /expected object/);
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(directory), []);
});

test('repairs invalid results with the previous response and the specific validation error', async (t) => {
  const directory = await cache(t);
  const calls = [];
  const good = generator(calls);
  const result = await interpretSystem(fixture(), { cacheDirectory: directory, generate: async (request) => {
    const response = await good(request);
    if (calls.length === 1) delete response.value.endpoints.e1.accesses.u2;
    if (calls.length === 2) {
      assert.ok(request.input.correction.includes('u2'));
      assert.equal(request.input.previous.endpoints.e1.accesses.u2, undefined);
      assert.equal(request.input.data.endpoints[0].ref, 'e1');
    }
    return response;
  } });
  assert.equal(calls.length, 3);
  assert.deepEqual(result.tokens, { input: 300, output: 60 });
  assert.deepEqual(result.endpoints[0].accesses.primary, ['u2']);
  assert.deepEqual(await readInterpretation(fixture(), { cacheDirectory: directory }), result);
});

test('repairs corrupt final caches from validated cached batches', async (t) => {
  const directory = await cache(t);
  const model = fixture();
  const calls = [];
  const options = { cacheDirectory: directory, generate: generator(calls) };
  const result = await interpretSystem(model, options);
  const files = await readdir(directory);
  const final = (await Promise.all(files.map(async (file) => ({ file, value: JSON.parse(await readFile(path.join(directory, file), 'utf8')) })))).find(({ value }) => value.schemaVersion === 1);
  final.value.endpoints[0].accesses.primary.push('invented');
  await writeFile(path.join(directory, final.file), JSON.stringify(final.value));
  assert.equal(await readInterpretation(model, options), null);
  const restored = await interpretSystem(model, options);
  assert.deepEqual(restored.endpoints, result.endpoints);
  assert.equal(calls.length, 2);
});

test('calls Responses with strict JSON, disables storage, and rejects incomplete/refused output', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const prepared = prepareInterpretation(fixture());
  const requests = [];
  await interpretSystem(fixture(), { cacheDirectory: await cache(t), generate: generator(requests) });
  let mode = 'complete';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.ok(!JSON.stringify(body).includes('test-api-key'));
    if (mode === 'quota') return Response.json({ error: { message: 'Untrusted provider message with test-api-key', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }, { status: 429, headers: { 'x-should-retry': 'false' } });
    return Response.json({ id: 'response', object: 'response', status: mode === 'incomplete' ? 'incomplete' : 'completed',
      output: [{ type: 'message', role: 'assistant', content: [mode === 'refusal' ? { type: 'refusal', refusal: 'No' }
        : { type: 'output_text', text: JSON.stringify(endpointReply(endpointInput(prepared, prepared.endpoints))), annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 20 } });
  };
  const generate = openAIGenerator('test-api-key');
  const result = await generate(requests[0]);
  assert.deepEqual(result.tokens, { input: 10, output: 20 });
  endpointResponseSchemaFor(prepared.endpoints).parse(result.value);
  mode = 'incomplete';
  await assert.rejects(generate(requests[0]), /incomplete/);
  mode = 'refusal';
  await assert.rejects(generate(requests[0]), /declined/);
  mode = 'quota';
  await assert.rejects(generate(requests[0]), (error) => /quota is exhausted/.test(error.message) && !error.message.includes('test-api-key'));
  await assert.rejects(openAIGenerator('')(requests[0]), /OPENAI_API_KEY/);
});
