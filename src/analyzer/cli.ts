import { writeFile } from "node:fs/promises";
import { analyzeRepository } from "./index.ts";
import { serializeSystemModel } from "../system-model/schema.ts";

const [directory, output, ...extra] = process.argv.slice(2);
if (!directory || directory === "--help" || extra.length) {
  console.error("Usage: npm run analyze -- <repository-directory> [output.json]");
  process.exitCode = directory === "--help" ? 0 : 1;
} else {
  try {
    const json = serializeSystemModel(await analyzeRepository(directory)) + "\n";
    if (output) await writeFile(output, json);
    else process.stdout.write(json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
