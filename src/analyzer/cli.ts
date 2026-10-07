import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { analyzeRepository } from "./index.ts";
import { serializeSystemModel } from "../system-snapshot/system-model.ts";

const args = process.argv.slice(2);
const benchmark = args[0] === "--benchmark";
const [directory, output, ...extra] = benchmark ? args.slice(1) : args;
if (!directory || directory === "--help" || extra.length || (benchmark && output)) {
  console.error(
    "Usage: npm run analyze -- <repository-directory> [output.json]\n" +
    "       npm run analyze -- --benchmark <repository-directory>",
  );
  process.exitCode = directory === "--help" ? 0 : 1;
} else {
  try {
    const start = performance.now();
    const model = await analyzeRepository(directory);
    const elapsed = performance.now() - start;
    if (benchmark) {
      console.log(`analyzeRepository(${JSON.stringify(directory)}): ${elapsed.toFixed(2)} ms (1 run)`);
    } else {
      const json = serializeSystemModel(model) + "\n";
      if (output) await writeFile(output, json);
      else process.stdout.write(json);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
