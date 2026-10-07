"use client";

import { use } from "react";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { systemModelSchema, type SystemModel } from "@/system-model/schema";
import SystemViews, { SystemViewsSkeleton } from "../_components/views/system-views";

/** Resolves to null for unknown workspaces. */
async function fetchSystemModel(workspaceId: string): Promise<SystemModel | null> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/model`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Analyzing ${workspaceId} failed (HTTP ${response.status})`);
  }
  return systemModelSchema.parse(await response.json());
}

export default function WorkspacePage({ params }: PageProps<"/[workspace]">) {
  const { workspace } = use(params);
  const { data: model } = useQuery({
    queryKey: ["system-model", workspace],
    queryFn: () => fetchSystemModel(workspace),
    // Analysis is expensive and deterministic per checkout: keep results for the session
    // (reload to re-analyze) and surface failures to error.tsx instead of retrying.
    staleTime: Infinity,
    retry: false,
    throwOnError: true,
  });
  if (model === null) notFound();
  return model ? <SystemViews model={model} /> : <SystemViewsSkeleton />;
}
