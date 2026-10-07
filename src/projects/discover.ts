import { readdir } from "node:fs/promises";
import path from "node:path";

export type Project = { id: string; revisions: string[] };

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

/** Discover local checkouts in userdata/<project>/<revision>. */
export async function discoverProjects(
  root = path.join(process.cwd(), "userdata"),
): Promise<Project[]> {
  const names = await directories(root);
  const projects = await Promise.all(
    names.map(async (id) => ({
      id,
      // Checkouts are server data, supplied at runtime rather than bundled.
      revisions: await directories(path.join(/* turbopackIgnore: true */ root, id)),
    })),
  );
  return projects.filter((project) => project.revisions.length > 0);
}
