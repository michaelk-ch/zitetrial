import type { SystemSnapshot } from "../index.ts";
import type { Integration, Table } from "../system-model.ts";
import { buildAccessMatrix, filterMatrix, usedColumns, type ColumnFilter, type MatrixGroup } from "./access-matrix.ts";

/**
 * Shared by the table and graph views: `showJoins` keeps join operations, `prioritize` keeps only
 * each endpoint's highest-priority operations, `interpret` uses the AI interpretation to hide utility
 * endpoints and keep each endpoint's most relevant usages, and `hideUnused` drops tables and
 * integrations that no shown endpoint uses.
 */
export type AccessOptions = { showJoins: boolean; prioritize: boolean; interpret: boolean; hideUnused: boolean };

export type AccessMode = "all" | "filtered" | "heuristic" | "interpreted";
export const accessModes: Record<AccessMode, AccessOptions & { label: string; description: string }> = {
  all: {
    label: "All", description: "Every endpoint and access, including joins and unused tables and integrations.",
    showJoins: true, prioritize: false, interpret: false, hideUnused: false,
  },
  filtered: {
    label: "Filtered", description: "Hides joins and tables or integrations that no endpoint uses.",
    showJoins: false, prioritize: false, interpret: false, hideUnused: true,
  },
  heuristic: {
    label: "Heuristic", description: "Filtered, keeping each endpoint's create/delete accesses first, then updates, then reads.",
    showJoins: false, prioritize: true, interpret: false, hideUnused: true,
  },
  interpreted: {
    label: "Interpreted", description: "Filtered, using the AI interpretation: hides utility endpoints and keeps each endpoint's primary accesses (uncertain, then supporting, then secondary when none are primary).",
    showJoins: false, prioritize: false, interpret: true, hideUnused: true,
  },
};
export const defaultAccessMode: AccessMode = "filtered";

/** Apps with their shown endpoints, and the tables and integrations to show, sorted by name. */
export type Preprocessed = { groups: MatrixGroup[]; tables: Table[]; integrations: Integration[] };

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Applies the access options and an optional endpoint filter to the snapshot. Tables and
 * integrations named by a column filter stay shown even when unused.
 */
export function preprocess(
  { analysis: model, interpretation }: SystemSnapshot,
  options: AccessOptions,
  filter: { query?: string; filters?: ColumnFilter[] } = {},
): Preprocessed {
  const groups = filterMatrix(buildAccessMatrix(model, { ...options, interpretation: options.interpret ? interpretation : undefined }), filter);
  const used = usedColumns(groups);
  const shown = (kind: ColumnFilter["kind"], id: string) => !options.hideUnused
    || (kind === "table" ? used.tables : used.integrations).has(id)
    || Boolean(filter.filters?.some((column) => column.kind === kind && column.id === id));
  return {
    groups,
    tables: model.tables.filter((table) => shown("table", table.id)).sort(byName),
    integrations: model.integrations.filter((integration) => shown("integration", integration.id)).sort(byName),
  };
}
