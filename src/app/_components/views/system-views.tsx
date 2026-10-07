import type { SystemSnapshot } from "@/system-snapshot";
import CrudView from "./crud-view";
import EmptyState from "../empty-state";
import GraphView from "./graph-view";
import InterpretationView from "./interpretation-view";
import RawView from "./raw-view";
import Tabs from "../tabs";

export default function SystemViews({ snapshot }: { snapshot: SystemSnapshot }) {
  const { analysis: model } = snapshot;
  const { commit } = model.repository;
  return (
    <Tabs
      label="System views"
      toolbar={
        <span title={commit} className="rounded-md border border-line bg-subtle px-2 py-1 text-[11px] text-muted">
          {commit ? `Checkout ${commit.slice(0, 7)}` : "Local checkout"}
        </span>
      }
      tabs={[
        {
          id: "overview",
          label: "Overview",
          content: (
            <EmptyState
              title="Your system, at a glance"
              footer={<span className="inline-block rounded-md border border-line bg-[#f5f5f5] px-[9px] py-[5px] text-[11px] text-muted">Visualization coming soon</span>}
            >
              Apps, tables, and integrations will come together here. Choose a workspace in the sidebar to explore a different system.
            </EmptyState>
          ),
        },
        { id: "graph", label: "Graph", content: <GraphView snapshot={snapshot} /> },
        { id: "interpretation", label: "Interpretation", content: <InterpretationView snapshot={snapshot} /> },
        { id: "crud", label: "Table", content: <CrudView snapshot={snapshot} /> },
        { id: "raw", label: "Raw", content: <RawView snapshot={snapshot} /> },
      ]}
    />
  );
}

/** Mirrors the SystemViews layout while the snapshot is built. */
export function SystemViewsSkeleton() {
  return (
    <div role="status">
      <p className="mb-4 text-sm text-muted">Loading system snapshot… New workspaces are analyzed and interpreted before opening.</p>
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex h-9 gap-2 rounded-lg border border-line bg-subtle p-1">
            {["w-20", "w-14", "w-24", "w-12", "w-14"].map((width, index) => <div key={index} className={`rounded-md bg-fill ${width}`} />)}
          </div>
          <div className="h-6 w-28 rounded-md bg-fill" />
        </div>
        <div className="min-h-[420px] rounded-xl border border-line bg-surface p-6 max-[540px]:min-h-[340px]">
          <div className="mb-8 h-4 w-32 rounded bg-fill" />
          <div className="space-y-4">
            {["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/5", "w-2/5"].map((width, index) => (
              <div key={index} className={`h-3 rounded bg-fill ${width}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
