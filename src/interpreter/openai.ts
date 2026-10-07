import OpenAI from "openai";

export type AIRequest = {
  model: string; instructions: string; input: unknown;
  format: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> };
};
export type AIResponse = { value: unknown; tokens: { input: number; output: number } };
export type Generate = (request: AIRequest) => Promise<AIResponse>;
export const requestParameters = { reasoning: { effort: "low" }, max_output_tokens: 16_000, store: false } as const;

/** Created lazily on a cache miss; the key never enters a prompt, artifact, or cache key. */
export function openAIGenerator(apiKey?: string): Generate {
  let client: OpenAI | undefined;
  return async (request) => {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Set OPENAI_API_KEY in .env.local or the environment to generate an interpretation.");
    client ??= new OpenAI({ apiKey: key, timeout: 120_000, maxRetries: 2 });
    let response;
    try {
      response = await client.responses.create({
        model: request.model, instructions: request.instructions,
        input: JSON.stringify(request.input), text: { format: request.format },
        ...requestParameters,
      });
    } catch (error) {
      // Provider messages can contain key fragments or request data. Don't return them to the browser/logs.
      if (error instanceof OpenAI.APIError) {
        if (error.type === "insufficient_quota" || error.code === "insufficient_quota" || error.code === "credit_balance_exhausted") {
          throw new Error("OpenAI API quota is exhausted. Check the API project's billing and credits, then retry; completed batches remain cached.");
        }
        if (error.status === 429) throw new Error("OpenAI rate limit reached (HTTP 429). Wait and retry; completed batches remain cached.");
        throw new Error(`OpenAI request failed (HTTP ${error.status ?? "unknown"}). Check the API key and model access.`);
      }
      throw new Error("Could not reach OpenAI. Check the connection and retry; completed batches are cached.");
    }
    if (response.status !== "completed") throw new Error(`OpenAI response was ${response.status}; no result was cached for this request.`);
    if (response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))) {
      throw new Error("OpenAI declined this interpretation request; no result was cached.");
    }
    let value: unknown;
    try { value = JSON.parse(response.output_text); }
    catch { throw new Error("OpenAI returned no valid JSON interpretation; no result was cached."); }
    return { value, tokens: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 } };
  };
}
