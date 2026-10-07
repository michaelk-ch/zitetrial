import type { z } from "zod";

export function uniqueReferences(ctx: z.RefinementCtx, path: (string | number)[], refs: string[]) {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    if (seen.has(ref)) ctx.addIssue({ code: "custom", path: [...path, index], message: `Duplicate reference: ${ref}` });
    seen.add(ref);
  });
}

export function exactReferences(ctx: z.RefinementCtx, path: (string | number)[], actual: string[], expected: string[]) {
  uniqueReferences(ctx, path, actual);
  const supplied = new Set(expected);
  const received = new Set(actual);
  const missing = expected.filter((ref) => !received.has(ref));
  const unknown = actual.filter((ref) => !supplied.has(ref));
  if (missing.length || unknown.length) ctx.addIssue({ code: "custom", path,
    message: `References must cover the supplied set exactly (missing: ${missing.join(", ")}; unknown: ${unknown.join(", ")})` });
}
