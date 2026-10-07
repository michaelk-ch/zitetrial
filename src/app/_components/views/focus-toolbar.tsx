"use client";

import type { ReactNode } from "react";
import type { SystemModel } from "@/system-snapshot/system-model";
import type { GraphFocus } from "@/system-snapshot/inference/graph-layout";

const focusKey = (focus: GraphFocus) => focus ? `${focus.kind}:${focus.id}` : "";
const sorted = (entities: { id: string; name: string }[]) => [...entities].sort((a, b) => a.name.localeCompare(b.name));

/** Shared by the graph and overview: focus breadcrumb, hint, extra controls, focus picker, and PNG export. */
export default function FocusToolbar({ model, focus, focusName, onFocus, hint, exporting, onExport, children }: {
  model: SystemModel; focus: GraphFocus; focusName?: string; onFocus: (focus: GraphFocus) => void;
  hint: string; exporting: boolean; onExport: () => void; children?: ReactNode;
}) {
  const options: ["app" | "table" | "integration", string, { id: string; name: string }[]][] = [
    ["app", "Applications", sorted(model.apps)],
    ["table", "Tables", sorted(model.tables)],
    ["integration", "Integrations", sorted(model.integrations)],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 text-xs">
      <nav aria-label="Focus" className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {focus ? (
          <>
            <button type="button" onClick={() => onFocus(null)} className="cursor-pointer rounded px-1 text-muted hover:text-ink hover:underline">All apps</button>
            <span aria-hidden="true" className="text-faint">/</span>
            <span className="truncate font-medium" aria-current="page">{focusName}</span>
            <button type="button" onClick={() => onFocus(null)} aria-label="Clear focus" title="Clear focus (Esc)" className="grid size-6 cursor-pointer place-items-center rounded text-faint hover:bg-subtle hover:text-ink">×</button>
          </>
        ) : <span className="font-medium">All apps</span>}
      </nav>
      <span className="text-faint max-[900px]:hidden">{hint}</span>
      {children}
      <select
        value={focusKey(focus)}
        onChange={(event) => {
          const [kind, ...id] = event.target.value.split(":");
          onFocus(kind ? { kind: kind as "app" | "table" | "integration", id: id.join(":") } : null);
        }}
        aria-label="Focus on"
        className="ml-auto h-8 cursor-pointer rounded-md border border-line-strong bg-white px-2 text-xs text-muted"
      >
        <option value="">Focus on…</option>
        {options.map(([kind, label, entities]) => entities.length > 0 && (
          <optgroup key={kind} label={label}>
            {entities.map((entity) => <option key={entity.id} value={`${kind}:${entity.id}`}>{entity.name}</option>)}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-white px-3 font-medium hover:bg-subtle disabled:cursor-wait disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {exporting ? "Exporting…" : "Export PNG"}
      </button>
    </div>
  );
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph";

/** Triggers a browser download of `blob`. */
export function download(blob: Blob, fileName: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
