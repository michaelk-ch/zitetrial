"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import type { SystemModel } from "@/system-model/schema";
import CrudView from "./crud-view";

const views = [
  { id: "overview", label: "Overview" },
  { id: "raw", label: "Raw" },
  { id: "crud", label: "CRUD" },
] as const;
type ViewId = (typeof views)[number]["id"];

function RawView({ model }: { model: SystemModel }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#e8e8e8] bg-[#fcfcfc]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8e8e8] px-5 py-3">
        <h3 className="text-sm font-medium">System model</h3>
        <span className="text-xs text-[#777]">{model.repository.name} · Schema v{model.schemaVersion}</span>
      </div>
      <pre className="max-h-[70vh] overflow-auto p-5 font-mono text-xs leading-6 text-[#444] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#8d766d]" tabIndex={0} aria-label="System model JSON">
        <code>{JSON.stringify(model, null, 2)}</code>
      </pre>
    </div>
  );
}

export default function WorkspaceViews({ model, children }: { model: SystemModel; children: ReactNode }) {
  const [active, setActive] = useState<ViewId>("overview");
  const prefix = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="System views" className="inline-flex gap-1 rounded-lg border border-[#e8e8e8] bg-[#fafafa] p-1">
          {views.map((view, index) => (
            <button
              key={view.id}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              role="tab"
              id={`${prefix}-${view.id}-tab`}
              aria-controls={`${prefix}-${view.id}-panel`}
              aria-selected={active === view.id}
              tabIndex={active === view.id ? 0 : -1}
              onClick={() => setActive(view.id)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === "ArrowRight") next = (index + 1) % views.length;
                else if (event.key === "ArrowLeft") next = (index - 1 + views.length) % views.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = views.length - 1;
                else return;
                event.preventDefault();
                setActive(views[next].id);
                buttons.current[next]?.focus();
              }}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8d766d] ${active === view.id ? "bg-white text-[#202020] shadow-sm ring-1 ring-[#dedede]" : "text-[#777] hover:text-[#202020]"}`}
            >{view.label}</button>
          ))}
        </div>
        <span className="rounded-md border border-[#e8e8e8] bg-[#fafafa] px-2 py-1 text-[11px] text-[#777]" title={model.repository.commit}>
          {model.repository.commit ? `Checkout ${model.repository.commit.slice(0, 7)}` : "Local checkout"}
        </span>
      </div>
      {views.map((view) => (
        <div key={view.id} role="tabpanel" id={`${prefix}-${view.id}-panel`} aria-labelledby={`${prefix}-${view.id}-tab`} hidden={active !== view.id} tabIndex={0} className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8d766d]">
          {active === view.id && (view.id === "raw" ? <RawView model={model} /> : view.id === "crud" ? <CrudView model={model} /> : children)}
        </div>
      ))}
    </>
  );
}
