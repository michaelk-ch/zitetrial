"use client";

import { useEffect, useState } from "react";
import { systemModelSchema, type SystemModel } from "@/system-model/schema";
import SystemViews, { SystemViewsSkeleton } from "./system-views";

// Shares in-flight requests, e.g. across Strict Mode's double-mounted effects. Results are not cached.
const pending = new Map<string, Promise<SystemModel>>();

function fetchSystemModel(workspaceId: string): Promise<SystemModel> {
  let request = pending.get(workspaceId);
  if (!request) {
    request = (async () => {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/model`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Analyzing ${workspaceId} failed (HTTP ${response.status})`);
      }
      return systemModelSchema.parse(await response.json());
    })().finally(() => pending.delete(workspaceId));
    pending.set(workspaceId, request);
  }
  return request;
}

/** Loads a workspace's system model from the analysis API in the browser. */
export default function WorkspaceViews({ workspaceId }: { workspaceId: string }) {
  const [result, setResult] = useState<{ model: SystemModel } | { error: unknown }>();

  useEffect(() => {
    let active = true;
    fetchSystemModel(workspaceId).then(
      (model) => active && setResult({ model }),
      (error) => active && setResult({ error }),
    );
    return () => { active = false; };
  }, [workspaceId]);

  if (!result) return <SystemViewsSkeleton />;
  if ("error" in result) throw result.error;
  return <SystemViews model={result.model} />;
}
