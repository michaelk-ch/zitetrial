import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildSystemSnapshot } from "./build.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "cache-dir": { type: "string" }, model: { type: "string" }, help: { type: "boolean" },
  } });
  const [directory, output, ...extra] = positionals;
  if (values.help || !directory || extra.length) {
    console.error("Usage: npm run snapshot -- <repository-directory> [output.json] [--model <model>] [--cache-dir <directory>]");
    if (!values.help) process.exitCode = 1;
  } else {
    const snapshot = await buildSystemSnapshot(directory, { model: values.model, cacheDirectory: values["cache-dir"],
      onProgress: (event) => console.error(`${event.stage} ${event.completed}/${event.total}${event.cached ? " (cached)" : ""}`) });
    const json = JSON.stringify(snapshot, null, 2) + "\n";
    if (output) await writeFile(output, json);
    else process.stdout.write(json);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
