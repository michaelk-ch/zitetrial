"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SystemModel } from "@/system-model/schema";
import { interpretationSchema, roles } from "@/interpreter/schema";
import type { Interpretation } from "@/interpreter/schema";
import Panel from "../panel";

async function fetchInterpretation(model: SystemModel, generate: boolean) {
  const response = await fetch("/api/interpretation", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, generate }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Interpretation failed.");
  return { result: body.result ? interpretationSchema.parse(body.result) : null, configured: Boolean(body.configured) };
}

function download(result: Interpretation) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "interpretation.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const prominenceOrder = { core: 0, supporting: 1, utility: 2, uncertain: 3 };

export default function InterpretationView({ model }: { model: SystemModel }) {
  const client = useQueryClient();
  const queryKey = ["interpretation", model];
  const query = useQuery({ queryKey, queryFn: () => fetchInterpretation(model, false), staleTime: Infinity, retry: false });
  const generation = useMutation({
    mutationFn: () => fetchInterpretation(model, true), retry: false,
    onSuccess: (result) => client.setQueryData(queryKey, result),
  });
  const result = query.data?.result;
  const error = generation.error ?? query.error;
  const endpoints = new Map(model.endpoints.map((e) => [e.id, e]));
  const targets = new Map([...model.tables, ...model.integrations].map((target) => [target.id, target.name]));
  const nodes = new Map(model.callGraph.nodes.map((node) => [node.id, node]));
  const usages = new Map(result?.usages.map((usage) => [usage.id, usage]));
  const button = "cursor-pointer rounded-md border border-line-strong bg-white px-3 py-1.5 text-xs font-medium hover:bg-subtle disabled:cursor-default disabled:opacity-50";

  return (
    <div className="space-y-4">
      <Panel title="Interpretation" meta={result ? `Generated ${new Date(result.createdAt).toLocaleDateString()}` : undefined}>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <p className="flex-1 text-sm text-muted">AI summaries, capabilities, and access roles. Expand an endpoint to inspect its interpretation.</p>
          {result ? <button className={button} onClick={() => download(result)}>Download JSON</button> : (
            <button className={button} disabled={query.isPending || generation.isPending || !query.data?.configured} onClick={() => generation.mutate()}>
              {generation.isPending ? "Interpreting…" : "Generate interpretation"}
            </button>
          )}
        </div>
        {query.isPending && <p role="status" className="px-5 pb-4 text-sm text-muted">Looking for a saved interpretation…</p>}
        {generation.isPending && <p role="status" className="px-5 pb-4 text-sm text-muted">Interpreting endpoints, then grouping capabilities. Completed batches are saved as they finish.</p>}
        {!result && query.data && !query.data.configured && <p className="px-5 pb-4 text-sm text-muted">Set OPENAI_API_KEY in .env.local, then reload to get started.</p>}
        {error && <p role="alert" className="px-5 pb-4 text-sm text-red-700">{error.message}</p>}
      </Panel>
      {result?.apps.map((app) => {
        const appModel = model.apps.find((a) => a.id === app.appId)!;
        const appEndpoints = result.endpoints.filter((e) => endpoints.get(e.endpointId)?.appId === app.appId);
        const groups = [...result.capabilities.filter((c) => appEndpoints.some((e) => e.capabilityId === c.id)),
          ...(appEndpoints.some((e) => e.capabilityId === null) ? [{ id: null, label: "Unassigned", purpose: "These endpoints have no clear capability assignment." }] : [])];
        return (
          <Panel key={app.appId} title={appModel.name} meta={`${appModel.visibility} · ${appEndpoints.length} endpoints`}>
            <p className="px-5 py-4 text-sm">{app.purpose}</p>
            {groups.map((group) => (
              <section key={group.id ?? "unassigned"} className="border-t border-line px-5 py-4">
                <h3 className="text-sm font-medium">{group.label}</h3>
                <p className="mb-3 mt-1 text-xs text-muted">{group.purpose}</p>
                {appEndpoints.filter((e) => e.capabilityId === group.id).sort((a, b) => prominenceOrder[a.prominence] - prominenceOrder[b.prominence]).map((endpoint) => (
                  <details key={endpoint.endpointId} className="rounded-md border border-line mb-2 last:mb-0">
                    <summary className="cursor-pointer px-3 py-2 text-sm">
                      <span className="font-medium">{endpoints.get(endpoint.endpointId)!.name}</span>
                      <span className="ml-2 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{endpoint.prominence}</span>
                      <span className="mt-1 block text-xs text-muted">{endpoint.purpose}</span>
                    </summary>
                    <div className="space-y-3 border-t border-line px-3 py-3 text-xs">
                      {roles.filter((role) => endpoint.accesses[role].length > 0).map((role) => (
                        <div key={role}>
                          <h4 className="mb-1 font-medium capitalize">{role}</h4>
                          <ul className="space-y-1">
                            {endpoint.accesses[role].map((id) => {
                              const usage = usages.get(id)!;
                              const via = usage.paths[0]?.map((nodeId) => nodes.get(nodeId)?.name ?? nodeId).join(" → ");
                              return <li key={id} className="flex flex-wrap gap-x-2">
                                <span>{targets.get(usage.target.id)}{usage.operation ? ` · ${usage.operation}` : " · integration"}</span>
                                <span className="break-all text-faint">{via ?? "Provenance unavailable"}</span>
                              </li>;
                            })}
                          </ul>
                        </div>
                      ))}
                      {endpoint.notes.map((note, i) => <p key={i} className="text-muted">{note.text}</p>)}
                      {!roles.some((role) => endpoint.accesses[role].length) && <p className="text-muted">No analyzed table or integration accesses.</p>}
                    </div>
                  </details>
                ))}
              </section>
            ))}
          </Panel>
        );
      })}
    </div>
  );
}
