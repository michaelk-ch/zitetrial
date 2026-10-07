"use server";

import { refresh } from "next/cache";
import { ImportError, importWorkspace } from "@/workspaces/import";

export type ImportResult = { workspace: string } | { error: string };

/** Stores a pasted repository files response under userdata/ for local analysis. */
export async function importWorkspaceAction(formData: FormData): Promise<ImportResult> {
  try {
    const { workspace } = await importWorkspace({
      json: String(formData.get("json") ?? ""),
      replace: formData.get("replace") === "on",
    });
    refresh();
    return { workspace };
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    throw error;
  }
}
