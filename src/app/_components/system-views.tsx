import type { SystemModel } from "@/system-model/schema";
import CrudView from "./crud-view";
import EmptyState from "./empty-state";
import RawView from "./raw-view";
import Tabs from "./tabs";

export default function SystemViews({ model }: { model: SystemModel }) {
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
            <EmptyState title="Your system, at a glance" badge="Visualization coming soon">
              Apps, tables, and integrations will come together here. Choose a workspace in the sidebar to explore a different system.
            </EmptyState>
          ),
        },
        { id: "raw", label: "Raw", content: <RawView model={model} /> },
        { id: "crud", label: "CRUD", content: <CrudView model={model} /> },
      ]}
    />
  );
}

/** Mirrors the SystemViews layout while the workspace is analyzed. */
export function SystemViewsSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Analyzing workspace…</span>
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex h-9 gap-2 rounded-lg border border-line bg-subtle p-1">
            {["w-20", "w-12", "w-14"].map((width) => <div key={width} className={`rounded-md bg-fill ${width}`} />)}
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
