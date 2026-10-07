import { readdir } from "node:fs/promises";
import path from "node:path";

export type Workspace = { id: string; revisions: string[] };

async function directories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Discover local checkouts in userdata/<workspace>/<revision>. */
export async function discoverWorkspaces(
  root = path.join(process.cwd(), "userdata"),
): Promise<Workspace[]> {
  const names = await directories(root);
  const workspaces = await Promise.all(
    names.map(async (id) => ({
      id,
      // Checkouts are server data, supplied at runtime rather than bundled.
      revisions: await directories(path.join(/* turbopackIgnore: true */ root, id)),
    })),
  );
  return workspaces.filter((workspace) => workspace.revisions.length > 0);
}
