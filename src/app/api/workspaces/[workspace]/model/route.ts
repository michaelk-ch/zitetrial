import { Worker } from "node:worker_threads";
import type { SystemModel } from "@/system-model/schema";
import { checkoutPath, findWorkspace } from "@/workspaces/discover";

/**
 * Analysis is synchronous, CPU-bound work. On the server's main thread it would block every
 * other request until it finishes, so each analysis runs in its own worker thread.
 */
function analyzeInWorker(directory: string): Promise<SystemModel> {
  return new Promise((resolve, reject) => {
    // workerData must be an object: Turbopack merges its own globals into it.
    const worker = new Worker(new URL("./analysis-worker.ts", import.meta.url), { workerData: { directory } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Analysis worker exited with code ${code}`)));
  });
}

/** Analyzes a workspace checkout and returns its system model as JSON. */
export async function GET(_request: Request, { params }: RouteContext<"/api/workspaces/[workspace]/model">) {
  const { workspace: id } = await params;
  const workspace = await findWorkspace(id);
  if (!workspace) return Response.json({ error: `Unknown workspace: ${id}` }, { status: 404 });
  // Revisions are sorted by discovery; use the first until revision selection exists.
  const checkout = checkoutPath(workspace.id, workspace.revisions[0]);
  try {
    return Response.json(await analyzeInWorker(checkout));
  } catch (error) {
    return Response.json({ error: `Analysis failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  }
}
