"use client";

import { use } from "react";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { systemSnapshotSchema, type SystemSnapshot } from "@/system-snapshot";
import SystemViews, { SystemViewsSkeleton } from "../_components/views/system-views";

/** Resolves to null for unknown workspaces. */
async function fetchSystemSnapshot(workspaceId: string): Promise<SystemSnapshot | null> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`, { method: "POST" });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Loading ${workspaceId} failed (HTTP ${response.status})`);
  }
  return systemSnapshotSchema.parse(await response.json());
}

export default function WorkspacePage({ params }: PageProps<"/[workspace]">) {
  const { workspace } = use(params);
  const { data: snapshot } = useQuery({
    queryKey: ["system-snapshot", workspace],
    queryFn: () => fetchSystemSnapshot(workspace),
    // Keep the snapshot for the session; explicit retries reuse completed server-side work.
    staleTime: Infinity,
    retry: false,
    throwOnError: true,
  });
  if (snapshot === null) notFound();
  return snapshot ? <SystemViews snapshot={snapshot} /> : <SystemViewsSkeleton />;
}
