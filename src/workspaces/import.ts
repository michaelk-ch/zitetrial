import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { checkoutPath, userdataRoot } from "./discover.ts";

/** A directory name that discovery lists: no separators, no leading dot. */
const segmentSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "Use letters, digits, '.', '_' or '-' (max 100 characters)");

/** Response body of the Zite repository files endpoint. */
const exportSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1, "files is empty"),
  headSha: segmentSchema,
});

export class ImportError extends Error {}

/** Repository-relative path inside the checkout, or an error for anything that could escape it. */
function safeRelativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  if (!filePath || filePath.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new ImportError(`Unsafe file path: ${JSON.stringify(filePath)}`);
  }
  return normalized;
}

const ziteConfigSchema = z.object({ project: z.object({ name: z.string().trim().min(1) }) });

/** Workspace name from the root zite.config.json project name, e.g. "Baden Dampft" → "baden-dampft". */
function workspaceName(files: { path: string; content: string }[]): string {
  const config = files.find((file) => file.path === "zite.config.json");
  if (!config) throw new ImportError("zite.config.json is missing from files");
  let name: string;
  try {
    name = ziteConfigSchema.parse(JSON.parse(config.content)).project.name;
  } catch {
    throw new ImportError("zite.config.json must be JSON with a non-empty project.name");
  }
  const id = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, 100).replace(/^-+|-+$/g, "");
  if (!id) throw new ImportError(`Project name ${JSON.stringify(name)} has no letters or digits to name the workspace`);
  return id;
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

/**
 * Writes a pasted files-endpoint response to userdata/<workspace>/<headSha>, naming the workspace
 * after the project in zite.config.json.
 * Files are staged in a hidden directory (ignored by discovery) and moved into place at the end,
 * so a failed import never leaves a partial checkout behind.
 */
export async function importWorkspace(
  { json, replace }: { json: string; replace: boolean },
  root = userdataRoot,
): Promise<{ workspace: string; revision: string; fileCount: number }> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new ImportError(`Invalid JSON: ${(error as Error).message}`);
  }
  const parsed = exportSchema.safeParse(data);
  if (!parsed.success) throw new ImportError(`Unexpected format: ${z.prettifyError(parsed.error)}`);

  const { files, headSha } = parsed.data;
  const checkoutFiles = files.map((file) => ({ path: safeRelativePath(file.path), content: file.content }));
  const id = workspaceName(checkoutFiles);
  const workspaceDir = path.join(/* turbopackIgnore: true */ root, id);
  if (!replace && await exists(workspaceDir)) {
    throw new ImportError(`Workspace "${id}" already exists. Tick replace to overwrite it.`);
  }

  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(/* turbopackIgnore: true */ root, ".import-"));
  try {
    for (const file of checkoutFiles) {
      const target = path.join(/* turbopackIgnore: true */ staging, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    // Replacing drops every revision: the viewer analyzes the first one, which must be this import.
    await rm(workspaceDir, { recursive: true, force: true });
    await mkdir(workspaceDir, { recursive: true });
    await rename(staging, checkoutPath(id, headSha, root));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ImportError) throw error;
    throw new ImportError(`Writing files failed: ${(error as Error).message}`);
  }
  return { workspace: id, revision: headSha, fileCount: checkoutFiles.length };
}
