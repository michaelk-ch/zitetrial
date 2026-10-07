"use client";

import { useMemo, useState } from "react";
import type { Integration, SystemModel, Table } from "@/system-model/schema";
import {
  accessLabel, buildAccessMatrix, filterMatrix, usedColumns,
  type ColumnFilter, type Operation, type Usage,
} from "@/system-model/inference/access-matrix";
import Panel from "../panel";

type Column = { kind: "table"; entity: Table } | { kind: "integration"; entity: Integration };
type Condition = Operation | "any";

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const isColumn = (filter: ColumnFilter, column: Column) => filter.kind === column.kind && filter.id === column.entity.id;

const conditions: [Condition, string][] = [
  ["any", "accesses"], ["read", "reads"], ["join", "joins"],
  ["create", "creates in"], ["update", "updates"], ["delete", "deletes from"], ["unknown", "unclassified"],
];
const verbs: Record<Operation, string> = {
  read: "reads", join: "joins", create: "creates in", update: "updates", delete: "deletes from", unknown: "accesses (unclassified)",
};
const tones = {
  create: "bg-[#e9f2fc] text-[#32618b]",
  update: "bg-[#fbf0e5] text-[#8a4a12]",
  delete: "bg-[#fbecec] text-[#963f3f]",
  read: "bg-[#eaf4ee] text-[#2f6449]",
  join: "bg-[#edf4f4] text-[#426c70]",
  unknown: "bg-[#f1f1f1] text-muted",
  call: "bg-[#eeeffa] text-[#464b94]",
};

const control = "h-8 rounded-md border border-line-strong bg-white px-2 text-xs";
const dataCell = "w-12 min-w-12 border-r border-b border-line p-0 text-center font-mono text-[11px]";

function cell(usage: Usage, column: Column, rowName: string) {
  if (column.kind === "integration") {
    return usage.integrations.has(column.entity.id) ? { label: "●", tone: tones.call, title: `${rowName} calls ${column.entity.name}` } : null;
  }
  const operations = usage.access.get(column.entity.id);
  if (!operations?.size) return null;
  const tone = tones[(["delete", "update", "create", "read", "join", "unknown"] as const).find((op) => operations.has(op))!];
  return { label: accessLabel(operations), tone, title: `${rowName} ${[...operations].map((op) => verbs[op]).join(", ")} ${column.entity.name}` };
}

function Cells({ usage, columns, rowName, strong }: { usage: Usage; columns: Column[]; rowName: string; strong?: boolean }) {
  const cells = columns.map((column, index) => {
    const content = cell(usage, column, rowName);
    const divider = column.kind === "integration" && columns[index - 1]?.kind !== "integration" ? "border-l border-l-line-strong" : "";
    return (
      <td key={`${column.kind}:${column.entity.id}`} title={content?.title} className={`${dataCell} ${divider} ${strong ? "h-10 font-semibold" : "h-8"} ${content?.tone ?? ""}`}>
        {content?.label}
      </td>
    );
  });
  return <>{cells}<td aria-hidden="true" className="border-b border-line" /></>;
}

export default function CrudView({ model }: { model: SystemModel }) {
  const [showJoins, setShowJoins] = useState(false);
  const [prioritize, setPrioritize] = useState(false);
  const groups = useMemo(() => buildAccessMatrix(model, { showJoins, prioritize }), [model, showJoins, prioritize]);
  const columns = useMemo<Column[]>(() => [
    ...[...model.tables].sort(byName).map((entity) => ({ kind: "table" as const, entity })),
    ...[...model.integrations].sort(byName).map((entity) => ({ kind: "integration" as const, entity })),
  ], [model]);

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [hideUnused, setHideUnused] = useState(true);

  const visibleGroups = useMemo(() => filterMatrix(groups, { query, filters }), [groups, query, filters]);
  const used = useMemo(() => usedColumns(visibleGroups), [visibleGroups]);
  const visibleColumns = hideUnused
    ? columns.filter((column) => filters.some((filter) => isColumn(filter, column)) || (column.kind === "table" ? used.tables : used.integrations).has(column.entity.id))
    : columns;
  const tableCount = visibleColumns.filter((column) => column.kind === "table").length;
  const integrationCount = visibleColumns.length - tableCount;
  const totalEndpoints = model.endpoints.length;
  const shownEndpoints = visibleGroups.reduce((sum, group) => sum + group.endpoints.length, 0);
  const filtering = query.trim() !== "" || filters.length > 0;

  if (groups.length === 0 || model.tables.length === 0) {
    return <Panel className="p-8 text-sm text-muted">No {groups.length === 0 ? "apps" : "tables"} found in this workspace.</Panel>;
  }

  const toggleColumnFilter = (column: Column) => setFilters((current) => current.some((filter) => isColumn(filter, column))
    ? current.filter((filter) => !isColumn(filter, column))
    : [...current, column.kind === "table" ? { kind: "table", id: column.entity.id, condition: "any" } : { kind: "integration", id: column.entity.id }]);
  const setCondition = (id: string, condition: Condition) =>
    setFilters((current) => current.map((filter) => filter.kind === "table" && filter.id === id ? { ...filter, condition } : filter));
  const toggleApp = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const nameOf = (filter: ColumnFilter) => columns.find((column) => isColumn(filter, column))?.entity.name ?? filter.id;
  const addable = columns.filter((column) => !filters.some((filter) => isColumn(filter, column)));

  return (
    <Panel
      title="Table & integration access"
      meta={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {([
            ["R", "read", tones.read], ["J", "join", tones.join], ["C", "create", tones.create],
            ["U", "update", tones.update], ["D", "delete", tones.delete],
            ["?", "unclassified", tones.unknown], ["●", "called", tones.call],
          ] as const).filter(([label]) => showJoins || label !== "J").map(([label, text, tone]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className={`inline-grid size-5 place-items-center rounded font-mono text-[11px] font-semibold ${tone}`}>{label}</span>{text}
            </span>
          ))}
        </span>
      }
    >
      <div data-wide className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search apps or endpoints…"
          aria-label="Search apps or endpoints"
          className={`${control} w-60 placeholder:text-faint`}
        />
        <select
          value=""
          onChange={(event) => event.target.value && toggleColumnFilter(addable[Number(event.target.value)])}
          aria-label="Add a column filter"
          className={`${control} cursor-pointer text-muted`}
        >
          <option value="">+ Filter by column</option>
          {(["table", "integration"] as const).map((kind) => (
            <optgroup key={kind} label={kind === "table" ? "Tables" : "Integrations"}>
              {addable.map((column, index) => column.kind === kind && <option key={column.entity.id} value={index}>{column.entity.name}</option>)}
            </optgroup>
          ))}
        </select>
        <label className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none">
          <input type="checkbox" checked={hideUnused} onChange={(event) => setHideUnused(event.target.checked)} className="accent-[#385e4b]" />
          Hide unused columns{hideUnused && columns.length > visibleColumns.length && <span className="text-faint">({columns.length - visibleColumns.length} hidden)</span>}
        </label>
        <label className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none">
          <input type="checkbox" checked={showJoins} onChange={(event) => setShowJoins(event.target.checked)} className="accent-[#385e4b]" />
          Show joins
        </label>
        <label title="For each endpoint, keep create/delete accesses first, then updates, then reads, then joins." className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none">
          <input type="checkbox" checked={prioritize} onChange={(event) => setPrioritize(event.target.checked)} className="accent-[#385e4b]" />
          Prioritize
        </label>
        <span aria-live="polite" className="ml-auto text-xs text-muted">{filtering ? `${shownEndpoints} of ${totalEndpoints}` : totalEndpoints} endpoints</span>
      </div>

      {filtering && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-5 py-2 text-xs">
          <span className="text-muted">Endpoints that</span>
          {filters.map((filter) => (
            <span key={`${filter.kind}:${filter.id}`} className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-white pl-1.5">
              {filter.kind === "table" ? (
                <select
                  value={filter.condition}
                  onChange={(event) => setCondition(filter.id, event.target.value as Condition)}
                  aria-label={`Condition for ${nameOf(filter)}`}
                  className="cursor-pointer rounded bg-transparent text-muted hover:text-ink"
                >
                  {conditions.map(([value, label]) => <option key={value} value={value} disabled={value === "join" && !showJoins}>{label}</option>)}
                </select>
              ) : <span className="text-muted">call</span>}
              <span className="font-medium">{nameOf(filter)}</span>
              <button type="button" onClick={() => setFilters((current) => current.filter((other) => other !== filter))} aria-label={`Remove ${nameOf(filter)} filter`} className="grid h-full w-6 cursor-pointer place-items-center rounded-r-md text-faint hover:bg-subtle hover:text-ink">×</button>
            </span>
          ))}
          {query.trim() && <span className="inline-flex h-7 items-center rounded-md border border-line-strong bg-white px-2">match “<span className="font-medium">{query.trim()}</span>”</span>}
          <button type="button" onClick={() => { setFilters([]); setQuery(""); }} className="ml-1 cursor-pointer text-muted underline-offset-2 hover:text-ink hover:underline">Clear all</button>
        </div>
      )}

      <div tabIndex={0} role="region" aria-label="Access matrix" className="max-h-[calc(100vh-280px)] min-h-[320px] overflow-auto bg-white [scrollbar-gutter:stable] focus-visible:-outline-offset-2">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Apps and their endpoints by database table and integration. App rows aggregate access from all their endpoints.</caption>
          <thead>
            <tr className="bg-subtle">
              <th scope="col" rowSpan={2} className="sticky top-0 left-0 z-30 w-[280px] min-w-[280px] border-r border-b border-line bg-inherit px-4 py-3 text-left align-bottom font-medium">App / Endpoint</th>
              {tableCount > 0 && <th scope="colgroup" colSpan={tableCount} className="sticky top-0 z-20 h-7 border-r border-b border-line bg-inherit px-3 text-left text-[11px] font-medium tracking-wide text-muted uppercase"><span className="block w-0 min-w-full truncate">Tables</span></th>}
              {integrationCount > 0 && <th scope="colgroup" colSpan={integrationCount} className="sticky top-0 z-[21] h-7 border-r border-b border-l border-line border-l-line-strong bg-[#f6f6fb] px-3 text-left text-[11px] font-medium tracking-wide text-muted uppercase"><span className="block w-0 whitespace-nowrap">Integrations</span></th>}
              {/* Width-less filler column absorbs extra width so data columns stay compact on wide screens. */}
              <td rowSpan={2} aria-hidden="true" className="sticky top-0 z-20 border-b border-line bg-inherit" />
            </tr>
            <tr className="bg-subtle">
              {visibleColumns.map((column, index) => {
                const active = filters.some((filter) => isColumn(filter, column));
                const divider = column.kind === "integration" && visibleColumns[index - 1]?.kind !== "integration" ? "border-l border-l-line-strong" : "";
                return (
                  <th key={`${column.kind}:${column.entity.id}`} scope="col" className={`sticky top-7 z-20 h-[136px] w-12 min-w-12 border-r border-b border-line p-0 align-bottom font-medium ${divider} ${active ? "bg-[#e7efe9]" : column.kind === "integration" ? "bg-[#f6f6fb]" : "bg-inherit"}`}>
                    <button
                      type="button"
                      onClick={() => toggleColumnFilter(column)}
                      aria-pressed={active}
                      title={`${column.entity.description ?? column.entity.name}\n${active ? "Click to remove filter" : `Click to show only endpoints that ${column.kind === "table" ? "access" : "call"} it`}`}
                      className={`flex h-full w-full cursor-pointer items-end justify-center pb-3 hover:bg-black/[0.035] ${active ? "text-[#2f6449] shadow-[inset_0_-2px_0_#385e4b]" : ""}`}
                    >
                      <span className="max-h-[116px] truncate [writing-mode:vertical-rl] rotate-180">{column.entity.name}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          {visibleGroups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={visibleColumns.length + 2} className="px-4 py-10 text-center text-sm text-muted">
                  No endpoints match these filters.{" "}
                  <button type="button" onClick={() => { setFilters([]); setQuery(""); }} className="cursor-pointer text-ink underline underline-offset-2">Clear all</button>
                </td>
              </tr>
            </tbody>
          )}
          {visibleGroups.map((group) => {
            const { app, endpoints } = group;
            const expanded = !collapsed.has(app.id);
            const total = groups.find((other) => other.app.id === app.id)?.endpoints.length ?? 0;
            return (
              <tbody key={app.id}>
                <tr className="bg-[#f2f3f2]">
                  <th scope="row" className="sticky left-0 z-10 border-r border-b border-line bg-inherit p-0 text-left font-semibold">
                    <button type="button" onClick={() => toggleApp(app.id)} aria-expanded={expanded} title={app.description ?? app.name} className="flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-left hover:bg-black/[0.03]">
                      <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-3.5 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <span className="truncate">{app.name}</span>
                      <span className="font-normal text-faint">{filtering ? `${endpoints.length}/${total}` : total}</span>
                      {app.visibility !== "unknown" && <span className="ml-auto rounded border border-line-strong bg-white px-1.5 py-0.5 text-[10px] font-normal text-muted">{app.visibility}</span>}
                    </button>
                  </th>
                  <Cells usage={group} columns={visibleColumns} rowName={app.name} strong />
                </tr>
                {expanded && endpoints.map((row) => (
                  <tr key={row.endpoint.id} className="bg-white hover:bg-subtle">
                    <th scope="row" title={row.endpoint.description ?? row.endpoint.name} className="sticky left-0 z-10 max-w-[320px] border-r border-b border-line bg-inherit py-1.5 pr-4 pl-[34px] text-left font-normal [overflow-wrap:anywhere]">
                      {row.endpoint.name}
                    </th>
                    <Cells usage={row} columns={visibleColumns} rowName={row.endpoint.name} />
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </Panel>
  );
}
