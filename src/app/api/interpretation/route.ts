import { z } from "zod";
import { systemModelSchema } from "@/system-model/schema";
import { interpretSystem, readInterpretation } from "@/interpreter";

const requestSchema = z.strictObject({ model: systemModelSchema, generate: z.boolean() });

/** Accept the exact snapshot already displayed by the viewer. Reads never make paid calls. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected a system model and a generate flag." }, { status: 400 });
  const configured = Boolean(process.env.OPENAI_API_KEY);
  const { model, generate } = parsed.data;
  try {
    const stored = await readInterpretation(model);
    if (stored || !generate) return Response.json({ result: stored, configured });
    if (!configured) return Response.json({ error: "Set OPENAI_API_KEY in .env.local to generate an interpretation." }, { status: 503 });
    return Response.json({ result: await interpretSystem(model), configured });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Interpretation failed." }, { status: 500 });
  }
}
