"use server";

import { refresh } from "next/cache";
import { ImportError, importGitRepository, importWorkspace } from "@/workspaces/import";

export type ImportResult = { workspace: string } | { error: string };

/** Stores a cloned Git repository or a pasted repository files response under userdata/ for local analysis. */
export async function importWorkspaceAction(formData: FormData): Promise<ImportResult> {
  const replace = formData.get("replace") === "on";
  try {
    const { workspace } = formData.get("mode") === "git"
      ? await importGitRepository({ url: String(formData.get("url") ?? ""), replace })
      : await importWorkspace({ json: String(formData.get("json") ?? ""), replace });
    refresh();
    return { workspace };
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    throw error;
  }
}
