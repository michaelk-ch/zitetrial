import { z } from "zod";
import { systemModelSchema } from "../system-model/schema.ts";
import type { SystemModel } from "../system-model/schema.ts";
import { cached, defaultCacheDirectory, fingerprint, readCached } from "./cache.ts";
import { endpointOutput, overviewOutput } from "./format.ts";
import { openAIGenerator, requestParameters } from "./openai.ts";
import type { AIRequest, Generate } from "./openai.ts";
import { prepareInterpretation, endpointBatches, endpointInput, overviewInput } from "./prepare.ts";
import { DEFAULT_MODEL, ENDPOINT_PROMPT, INTERPRETATION_VERSION, OVERVIEW_PROMPT } from "./prompts.ts";
import { interpretationSchema } from "./schema.ts";
import type { EndpointResponse, Interpretation } from "./schema.ts";
import { validateEndpoints, validateOverview } from "./validate.ts";

export type Progress = { stage: "endpoints" | "overview" | "complete"; completed: number; total: number; cached: boolean };
export type InterpretOptions = {
  model?: string; cacheDirectory?: string; apiKey?: string;
  onProgress?: (progress: Progress) => void;
  /** Injectable transport for offline tests. */
  generate?: Generate;
};

function settings(model: SystemModel, options: InterpretOptions) {
  const selectedModel = options.model ?? process.env.OPENAI_INTERPRETATION_MODEL ?? DEFAULT_MODEL;
  const inputHash = fingerprint(model);
  const prepared = prepareInterpretation(model);
  const batches = endpointBatches(prepared).map((endpoints) => ({ endpoints, output: endpointOutput(endpoints) }));
  const overview = overviewOutput(prepared);
  const config = { version: INTERPRETATION_VERSION, model: selectedModel, prompts: [ENDPOINT_PROMPT, OVERVIEW_PROMPT],
    formats: [...batches.map((batch) => batch.output.format), overview.format], requestParameters };
  return { inputHash, selectedModel, prepared, batches, overview, key: fingerprint({ inputHash, config }),
    directory: options.cacheDirectory ?? defaultCacheDirectory };
}

function validateArtifact(value: unknown, config: ReturnType<typeof settings>): Interpretation {
  const result = interpretationSchema.parse(value);
  if (result.inputHash !== config.inputHash || result.model !== config.selectedModel || result.version !== INTERPRETATION_VERSION) {
    throw new Error("Interpretation does not match the analyzed snapshot or configuration.");
  }
  const { prepared } = config;
  if (fingerprint(result.usages) !== fingerprint(prepared.usages)) throw new Error("Interpretation usage references do not match the snapshot.");
  const endpointRef = (id: string) => prepared.endpoints.find((e) => e.id === id)?.ref ?? "<unknown>";
  validateEndpoints({ endpoints: result.endpoints.map((e) => ({ endpoint: endpointRef(e.endpointId), purpose: e.purpose, accesses: e.accesses, notes: e.notes })) }, prepared.endpoints);
  validateOverview({
    apps: result.apps.map((a) => ({ app: prepared.apps.find((app) => app.id === a.appId)?.ref ?? "<unknown>", purpose: a.purpose })),
    capabilities: result.capabilities,
    endpoints: result.endpoints.map((e) => ({ endpoint: endpointRef(e.endpointId), capability: e.capabilityId, prominence: e.prominence })),
  }, prepared);
  return result;
}

/** Read-only lookup. Never constructs an API client or makes an OpenAI request. */
export async function readInterpretation(model: SystemModel, options: InterpretOptions = {}) {
  const valid = systemModelSchema.parse(model);
  const config = settings(valid, options);
  return readCached(config.directory, config.key, (value) => validateArtifact(value, config));
}

/** Two AI passes over analyzed facts, with persistent caches for each batch and final artifact. */
export async function interpretSystem(model: SystemModel, options: InterpretOptions = {}): Promise<Interpretation> {
  model = systemModelSchema.parse(model);
  const config = settings(model, options);
  const { directory, key, inputHash, selectedModel, prepared, batches, overview: overviewContract } = config;
  const result = await cached(directory, key, (value) => validateArtifact(value, config), async () => {
    const generate = options.generate ?? openAIGenerator(options.apiKey);
    const tokens = { input: 0, output: 0 };
    const request = async <T>(stage: "endpoints" | "overview", input: unknown,
      output: { format: AIRequest["format"]; parse: (value: unknown) => T },
      validate: (value: unknown) => T, completed: number, total: number) => {
      const payload: AIRequest = { model: selectedModel, input,
        instructions: stage === "endpoints" ? ENDPOINT_PROMPT : OVERVIEW_PROMPT,
        format: output.format };
      const validateEntry = (value: unknown) => {
        const entry = z.object({ value: z.unknown(), tokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }) }).parse(value);
        return { ...entry, value: validate(entry.value) };
      };
      const entry = await cached(directory, fingerprint({ version: INTERPRETATION_VERSION, requestParameters, payload }), validateEntry, async () => {
        // One bounded retry for semantically invalid JSON (e.g. an omitted reference).
        const response = await generate(payload);
        try { return validateEntry({ ...response, value: output.parse(response.value) }); }
        catch (error) {
          const repaired = await generate({ ...payload, input: { data: input,
            previous: response.value, correction: error instanceof Error ? error.message : "Invalid interpretation." } });
          return validateEntry({ value: output.parse(repaired.value), tokens: {
            input: response.tokens.input + repaired.tokens.input, output: response.tokens.output + repaired.tokens.output } });
        }
      });
      tokens.input += entry.value.tokens.input;
      tokens.output += entry.value.tokens.output;
      options.onProgress?.({ stage, completed, total, cached: entry.hit });
      return entry.value.value;
    };
    const endpoints: EndpointResponse["endpoints"] = [];
    for (const [i, batch] of batches.entries()) {
      const response = await request("endpoints", endpointInput(prepared, batch.endpoints), batch.output,
        (value) => validateEndpoints(value, batch.endpoints), i + 1, batches.length);
      endpoints.push(...response.endpoints);
    }
    const overview = await request("overview", overviewInput(prepared, endpoints), overviewContract,
      (value) => validateOverview(value, prepared), 1, 1);
    return interpretationSchema.parse({
      schemaVersion: 1, inputHash, model: selectedModel, version: INTERPRETATION_VERSION, createdAt: new Date().toISOString(),
      apps: overview.apps.map((app) => ({ appId: prepared.apps.find((a) => a.ref === app.app)!.id, purpose: app.purpose })),
      capabilities: overview.capabilities,
      endpoints: prepared.endpoints.map((endpoint) => {
        const detail = endpoints.find((e) => e.endpoint === endpoint.ref)!;
        const summary = overview.endpoints.find((e) => e.endpoint === endpoint.ref)!;
        return { endpointId: endpoint.id, purpose: detail.purpose, capabilityId: summary.capability,
          prominence: summary.prominence, accesses: detail.accesses, notes: detail.notes };
      }),
      usages: prepared.usages, tokens,
    });
  });
  options.onProgress?.({ stage: "complete", completed: 1, total: 1, cached: result.hit });
  return result.value;
}
