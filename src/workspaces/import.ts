import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
function workspaceName(config: string | undefined): string {
  if (config === undefined) throw new ImportError("zite.config.json is missing from files");
  let name: string;
  try {
    name = ziteConfigSchema.parse(JSON.parse(config)).project.name;
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

export type ImportedWorkspace = { workspace: string; revision: string };

/**
 * Lets `fill` write a checkout into a hidden staging directory (ignored by discovery) and return its
 * revision, then moves it to userdata/<workspace>/<revision>, naming the workspace after the project
 * in its zite.config.json. A failed import never leaves a partial checkout behind.
 */
async function install(root: string, replace: boolean, fill: (staging: string) => Promise<string>): Promise<ImportedWorkspace> {
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(/* turbopackIgnore: true */ root, ".import-"));
  try {
    const revision = await fill(staging);
    const config = await readFile(path.join(/* turbopackIgnore: true */ staging, "zite.config.json"), "utf8").catch(() => undefined);
    const id = workspaceName(config);
    const workspaceDir = path.join(/* turbopackIgnore: true */ root, id);
    if (!replace && await exists(workspaceDir)) {
      throw new ImportError(`Workspace "${id}" already exists. Tick replace to overwrite it.`);
    }
    // Replacing drops every revision: the viewer analyzes the first one, which must be this import.
    await rm(workspaceDir, { recursive: true, force: true });
    await mkdir(workspaceDir, { recursive: true });
    await rename(staging, checkoutPath(id, revision, root));
    return { workspace: id, revision };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ImportError) throw error;
    throw new ImportError(`Writing files failed: ${(error as Error).message}`);
  }
}

/** Writes a pasted files-endpoint response to userdata/<workspace>/<headSha>. */
export async function importWorkspace(
  { json, replace }: { json: string; replace: boolean },
  root = userdataRoot,
): Promise<ImportedWorkspace & { fileCount: number }> {
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
  const result = await install(root, replace, async (staging) => {
    for (const file of checkoutFiles) {
      const target = path.join(/* turbopackIgnore: true */ staging, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    return headSha;
  });
  return { ...result, fileCount: checkoutFiles.length };
}

/** Clone URL for a repository, e.g. https://github.com/zite/grant-management. */
function repositoryUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ImportError(`Invalid repository URL: ${JSON.stringify(trimmed)}`);
  }
  if (parsed.protocol !== "https:") throw new ImportError("Repository URL must start with https://");
  return trimmed;
}

/** Runs git with no interactive credential prompts, rejecting with its last stderr line. */
async function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      const detail = stderr.trim().split("\n").at(-1) || (error.killed ? "timed out" : error.message);
      const hint = detail.includes("terminal prompts disabled") ? " (the repository does not exist or is private)" : "";
      reject(new ImportError(`git failed: ${detail}${hint}`));
    });
  });
}

/** Shallow-clones the default branch of a Git repository to userdata/<workspace>/<HEAD sha>. */
export async function importGitRepository(
  { url, replace }: { url: string; replace: boolean },
  root = userdataRoot,
): Promise<ImportedWorkspace> {
  const remote = repositoryUrl(url);
  return install(root, replace, async (staging) => {
    // Symlinks are checked out as plain files so the checkout cannot point outside itself, like pasted imports.
    await git(["-c", "core.symlinks=false", "clone", "--depth=1", "--quiet", "--no-tags", "--", remote, staging]);
    const revision = await git(["rev-parse", "HEAD"], staging);
    // The checkout holds the files only, like a pasted import.
    await rm(path.join(/* turbopackIgnore: true */ staging, ".git"), { recursive: true, force: true });
    return revision;
  });
}
