import { z } from "zod";
import { systemModelSchema } from "../system-snapshot/system-model.ts";
import type { SystemModel } from "../system-snapshot/system-model.ts";
import { cached, defaultCacheDirectory, fingerprint, readCached } from "../system-snapshot/cache.ts";
import { endpointOutput, overviewOutput } from "./format.ts";
import { openAIGenerator, requestParameters } from "./openai.ts";
import type { AIRequest, Generate } from "./openai.ts";
import { prepareInterpretation, endpointBatches, endpointInput, overviewInput } from "./prepare.ts";
import { DEFAULT_MODEL, ENDPOINT_PROMPT, INTERPRETATION_VERSION, OVERVIEW_PROMPT } from "./prompts.ts";
import { interpretationSchemaFor } from "../system-snapshot/interpretation.ts";
import type { Interpretation } from "../system-snapshot/interpretation.ts";
import { endpointResponseSchemaFor, overviewResponseSchemaFor } from "./responses.ts";
import type { EndpointResponse } from "./responses.ts";

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
  const schema = interpretationSchemaFor(model)
    .refine((result) => result.inputHash === inputHash && result.model === selectedModel && result.version === INTERPRETATION_VERSION,
      "Interpretation does not match the analyzed snapshot or configuration")
    .refine((result) => fingerprint(result.usages) === fingerprint(prepared.usages), "Usage references do not match the analyzed snapshot");
  return { inputHash, selectedModel, prepared, batches, overview, schema, key: fingerprint({ inputHash, config }),
    directory: options.cacheDirectory ?? defaultCacheDirectory };
}

/** Read-only lookup. Never constructs an API client or makes an OpenAI request. */
export async function readInterpretation(model: SystemModel, options: InterpretOptions = {}) {
  const valid = systemModelSchema.parse(model);
  const config = settings(valid, options);
  return readCached(config.directory, config.key, config.schema.parse);
}

/** Two AI passes over analyzed facts, with persistent caches for each batch and final artifact. */
export async function interpretSystem(model: SystemModel, options: InterpretOptions = {}): Promise<Interpretation> {
  model = systemModelSchema.parse(model);
  const config = settings(model, options);
  const { directory, key, inputHash, selectedModel, prepared, batches, overview: overviewContract } = config;
  const result = await cached(directory, key, config.schema.parse, async () => {
    const generate = options.generate ?? openAIGenerator(options.apiKey);
    const tokens = { input: 0, output: 0 };
    const request = async <T>(stage: "endpoints" | "overview", input: unknown,
      output: { format: AIRequest["format"]; parse: (value: unknown) => T },
      schema: z.ZodType<T>, completed: number, total: number) => {
      const payload: AIRequest = { model: selectedModel, input,
        instructions: stage === "endpoints" ? ENDPOINT_PROMPT : OVERVIEW_PROMPT,
        format: output.format };
      const entrySchema = z.object({ value: schema, tokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }) });
      const entry = await cached(directory, fingerprint({ version: INTERPRETATION_VERSION, requestParameters, payload }), entrySchema.parse, async () => {
        // One bounded retry for semantically invalid JSON (e.g. an omitted reference).
        const response = await generate(payload);
        try { return entrySchema.parse({ ...response, value: output.parse(response.value) }); }
        catch (error) {
          const repaired = await generate({ ...payload, input: { data: input,
            previous: response.value, correction: error instanceof Error ? error.message : "Invalid interpretation." } });
          return entrySchema.parse({ value: output.parse(repaired.value), tokens: {
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
        endpointResponseSchemaFor(batch.endpoints), i + 1, batches.length);
      endpoints.push(...response.endpoints);
    }
    const overview = await request("overview", overviewInput(prepared, endpoints), overviewContract,
      overviewResponseSchemaFor(prepared), 1, 1);
    return config.schema.parse({
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
