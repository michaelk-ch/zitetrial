import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deserializeSystemModel } from "../system-snapshot/system-model.ts";
import { interpretSystem } from "./index.ts";
import { endpointBatches, endpointInput, prepareInterpretation } from "./prepare.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "dry-run": { type: "boolean" }, "cache-dir": { type: "string" }, model: { type: "string" }, help: { type: "boolean" },
  } });
  const [input, output, ...extra] = positionals;
  if (values.help || !input || extra.length) {
    console.error("Usage: npm run interpret -- <model.json> [output.json] [--dry-run] [--model <model>] [--cache-dir <directory>]");
    if (!values.help) process.exitCode = 1;
  } else {
    const model = deserializeSystemModel(await readFile(input, "utf8"));
    let result: unknown;
    if (values["dry-run"]) {
      const prepared = prepareInterpretation(model);
      const batches = endpointBatches(prepared).map((batch) => endpointInput(prepared, batch));
      result = { endpoints: prepared.endpoints.length, usages: prepared.usages.length,
        batchCharacters: batches.map((batch) => JSON.stringify(batch).length), batches };
    } else {
      result = await interpretSystem(model, { model: values.model, cacheDirectory: values["cache-dir"],
        onProgress: (event) => console.error(`${event.stage} ${event.completed}/${event.total}${event.cached ? " (cached)" : ""}`) });
    }
    const json = JSON.stringify(result, null, 2) + "\n";
    if (output) await writeFile(output, json);
    else process.stdout.write(json);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
