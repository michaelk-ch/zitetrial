import type { Integration, SystemModel, Table } from "../schema.ts";
import { buildAccessMatrix, filterMatrix, usedColumns, type ColumnFilter, type MatrixGroup } from "./access-matrix.ts";

/**
 * Shared by the table and graph views: `showJoins` keeps join operations, `prioritize` keeps only
 * each endpoint's highest-priority operations, and `hideUnused` drops tables and integrations that
 * no shown endpoint uses.
 */
export type AccessOptions = { showJoins: boolean; prioritize: boolean; hideUnused: boolean };
export const defaultAccessOptions: AccessOptions = { showJoins: false, prioritize: false, hideUnused: true };

/** Apps with their shown endpoints, and the tables and integrations to show, sorted by name. */
export type Preprocessed = { groups: MatrixGroup[]; tables: Table[]; integrations: Integration[] };

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Applies the access options and an optional endpoint filter to the model. Tables and integrations
 * named by a column filter stay shown even when unused.
 */
export function preprocess(model: SystemModel, options: AccessOptions, filter: { query?: string; filters?: ColumnFilter[] } = {}): Preprocessed {
  const groups = filterMatrix(buildAccessMatrix(model, options), filter);
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
