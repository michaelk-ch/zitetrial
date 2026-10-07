import { z } from "zod";
import { systemModelSchema } from "./system-model.ts";
import { interpretationSchema, interpretationSchemaFor } from "./interpretation.ts";

/** The complete client contract for one analyzed and interpreted repository state. */
export const systemSnapshotSchema = z.strictObject({
  analysis: systemModelSchema,
  interpretation: interpretationSchema,
}).superRefine(({ analysis, interpretation }, ctx) => {
  const result = interpretationSchemaFor(analysis).safeParse(interpretation);
  if (!result.success) for (const issue of result.error.issues) {
    ctx.addIssue({ ...issue, path: ["interpretation", ...issue.path] });
  }
});

export type SystemSnapshot = z.infer<typeof systemSnapshotSchema>;
