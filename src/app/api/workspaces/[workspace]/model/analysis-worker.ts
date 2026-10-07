// Worker thread entry: analyzes the checkout passed as workerData and posts the model back.
import { parentPort, workerData } from "node:worker_threads";
import { analyzeRepository } from "@/analyzer";

analyzeRepository((workerData as { directory: string }).directory).then((model) => parentPort!.postMessage(model));
