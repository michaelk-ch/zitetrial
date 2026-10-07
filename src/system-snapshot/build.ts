import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { cached, defaultCacheDirectory, fingerprint } from "./cache.ts";
import { systemSnapshotSchema } from "./index.ts";
import { systemModelSchema } from "./system-model.ts";
import type { SystemModel } from "./system-model.ts";
import { interpretSystem } from "../interpreter/index.ts";
import type { InterpretOptions } from "../interpreter/index.ts";

// Bump when analyzer behavior changes; source edits invalidate themselves.
const ANALYSIS_VERSION = 1;
export type SnapshotOptions = InterpretOptions & {
  /** The API supplies a worker-backed analyzer; the CLI uses the ordinary function. */
  analyze?: (directory: string) => Promise<SystemModel>;
};

/** Hash source/config contents so replacing a checkout at the same path invalidates analysis. */
async function sourceFiles(directory: string, prefix = ""): Promise<[string, string][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry): Promise<[string, string][]> => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const name = `${prefix}${entry.name}`;
    const file = path.join(/* turbopackIgnore: true */ directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file, `${name}/`);
    if (!entry.isFile() || !/\.(tsx?|json)$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [[name, fingerprint(await readFile(file, "utf8"))]];
  }));
  return files.flat();
}

/** Ordinary TypeScript orchestration shared by the API and CLI. Returns both stages or fails. */
export async function buildSystemSnapshot(directory: string, options: SnapshotOptions = {}) {
  const root = path.resolve(directory);
  const key = fingerprint({ stage: "analysis", version: ANALYSIS_VERSION, root, files: await sourceFiles(root) });
  const analysis = await cached(options.cacheDirectory ?? defaultCacheDirectory, key, systemModelSchema.parse, async () => {
    const analyze = options.analyze ?? (await import("../analyzer/index.ts")).analyzeRepository;
    return analyze(root);
  });
  const interpretation = await interpretSystem(analysis.value, options);
  return systemSnapshotSchema.parse({ analysis: analysis.value, interpretation });
}
