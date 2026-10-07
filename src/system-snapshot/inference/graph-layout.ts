import type { App, Endpoint, Integration, Table } from "../system-model.ts";
import type { MatrixGroup, MatrixRow, Operation, Usage } from "./access-matrix.ts";
import type { Preprocessed } from "./preprocess.ts";

/**
 * Deterministic two-column layout for the graph view: a left column with a "Database" frame of tables
 * above an "Integrations" frame, and the apps (with endpoints) on the right. Every connection runs
 * from an app or endpoint to a table or integration on the left, so edges never cross a column and
 * the layout only has to choose the vertical order and position within each column.
 */

export type GraphFocus = { kind: "app" | "table" | "integration"; id: string } | null;
/** Joins count as reads; create/update/delete as writes. Any write makes the edge a write. */
export type EdgeKind = "read" | "write" | "unknown" | "call";

type Rect = { x: number; y: number; w: number; h: number };
/** Totals across all preprocessed endpoints, independent of the focus. */
export type SideUsage = { apps: number; endpoints: number; readers: number; writers: number };
export type GraphTable = Rect & { key: string; entity: Table; usage: SideUsage };
export type GraphIntegration = Rect & { key: string; entity: Integration; usage: SideUsage };
/** `operations` holds the operations on the focused table, when a table is focused. */
export type GraphRow = { key: string; endpoint: Endpoint; y: number; h: number; connected: boolean; operations?: Operation[] };
export type GraphApp = Rect & {
  key: string; app: App; expanded: boolean; rows: GraphRow[]; totalEndpoints: number;
  stats: { reads: number; writes: number; calls: number };
};
export type GraphEdge = {
  /** `weight` counts the endpoints behind an app-level edge (1 for endpoint edges). */
  key: string; kind: EdgeKind; operations: Operation[]; weight: number;
  /** App or endpoint key in the middle column, its app key, and the table or integration key. */
  sourceKey: string; appKey: string; targetKey: string;
  x1: number; y1: number; x2: number; y2: number;
};
/** Frame around the tables or the integrations in the left column. */
export type GraphFrame = Rect & { kind: "tables" | "integrations"; count: number };
export type GraphLayout = {
  width: number; height: number; frames: GraphFrame[];
  apps: GraphApp[]; tables: GraphTable[]; integrations: GraphIntegration[]; edges: GraphEdge[];
};

export const graphSizes = {
  pad: 48, minWidth: 1080, columnGap: 260,
  /** Padding inside a frame, its label area, and the space between the two frames. */
  frame: { pad: 14, header: 38, gap: 28 },
  table: { w: 220, h: 34, gap: 8 },
  integration: { w: 220, h: 54, gap: 14 },
  app: { w: 300, h: 68, gap: 24, header: 70, row: 24, footer: 10 },
};

const reads = new Set<Operation>(["read", "join"]);
const writes = new Set<Operation>(["create", "update", "delete"]);

export function edgeKind(operations: Iterable<Operation>): Exclude<EdgeKind, "call"> {
  let read = false;
  for (const operation of operations) {
    if (writes.has(operation)) return "write";
    read ||= reads.has(operation);
  }
  return read ? "read" : "unknown";
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Tops for boxes in a fixed order that minimize the squared distance to their desired tops while
 * keeping `gap` between neighbours and starting at or below `min` (isotonic regression by
 * pool-adjacent-violators; clipping the fit to the bound keeps it optimal).
 */
export function packColumn(desired: number[], heights: number[], gap: number, min = -Infinity): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const height of heights) {
    offsets.push(offset);
    offset += height + gap;
  }
  const blocks: { sum: number; count: number }[] = [];
  desired.forEach((top, index) => {
    blocks.push({ sum: top - offsets[index], count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1], previous = blocks[blocks.length - 2];
      if (previous.sum / previous.count <= last.sum / last.count) break;
      previous.sum += last.sum;
      previous.count += last.count;
      blocks.pop();
    }
  });
  return blocks.flatMap(({ sum, count }) => Array<number>(count).fill(Math.max(min, sum / count))).map((value, index) => value + offsets[index]);
}

/** Positions spread around the middle of [low, high], at most `step` apart. */
function spread(count: number, low: number, high: number, step: number): number[] {
  const width = Math.min(high - low, (count - 1) * step);
  const start = (low + high - width) / 2;
  return Array.from({ length: count }, (_, index) => count === 1 ? start : start + (index * width) / (count - 1));
}

type Spine = { group: MatrixGroup; rows: MatrixRow[]; expanded: boolean };
type Link = { kind: EdgeKind; operations: Operation[]; weight: number; spine: number; row: number | null; side: "table" | "integration"; target: number };

function sideUsage(groups: MatrixGroup[], matches: (row: MatrixRow) => Operation[] | null): SideUsage {
  const usage = { apps: 0, endpoints: 0, readers: 0, writers: 0 };
  for (const group of groups) {
    let used = false;
    for (const row of group.endpoints) {
      const operations = matches(row);
      if (!operations) continue;
      used = true;
      usage.endpoints++;
      if (operations.some((operation) => reads.has(operation))) usage.readers++;
      if (operations.some((operation) => writes.has(operation))) usage.writers++;
    }
    if (used) usage.apps++;
  }
  return usage;
}

export function layoutGraph({ groups, tables: allTables, integrations: allIntegrations }: Preprocessed, focus: GraphFocus = null, { top = 0 } = {}): GraphLayout {
  const { pad, minWidth, columnGap, frame: F, table: T, integration: I, app: A } = graphSizes;

  let spine: Spine[];
  let tables: Table[];
  let integrations: Integration[];
  const focusedGroup = focus?.kind === "app" ? groups.find((group) => group.app.id === focus.id) : undefined;
  if (focusedGroup) {
    spine = [{ group: focusedGroup, rows: focusedGroup.endpoints, expanded: true }];
    tables = allTables.filter((table) => focusedGroup.access.has(table.id));
    integrations = allIntegrations.filter((integration) => focusedGroup.integrations.has(integration.id));
  } else if (focus?.kind === "table" && allTables.some((table) => table.id === focus.id)) {
    spine = groups.map((group) => ({ group, rows: group.endpoints.filter((row) => row.access.has(focus.id)), expanded: true }))
      .filter((item) => item.rows.length > 0);
    tables = allTables.filter((table) => table.id === focus.id);
    integrations = [];
  } else if (focus?.kind === "integration" && allIntegrations.some((integration) => integration.id === focus.id)) {
    spine = groups.map((group) => ({ group, rows: group.endpoints.filter((row) => row.integrations.has(focus.id)), expanded: true }))
      .filter((item) => item.rows.length > 0);
    tables = [];
    integrations = allIntegrations.filter((integration) => integration.id === focus.id);
  } else {
    spine = groups.map((group) => ({ group, rows: [], expanded: false }));
    tables = allTables;
    integrations = allIntegrations;
  }

  // Connections from each app (collapsed) or endpoint row (expanded) to visible tables and integrations.
  const tableIndex = new Map(tables.map((table, index) => [table.id, index]));
  const integrationIndex = new Map(integrations.map((integration, index) => [integration.id, index]));
  const links: Link[] = [];
  const addLinks = (usage: Usage, rows: MatrixRow[], spineIndex: number, row: number | null) => {
    for (const [tableId, operations] of usage.access) {
      const target = tableIndex.get(tableId);
      if (target === undefined) continue;
      const sorted = [...operations];
      const weight = rows.filter((other) => other.access.has(tableId)).length;
      links.push({ kind: edgeKind(sorted), operations: sorted, weight, spine: spineIndex, row, side: "table", target });
    }
    for (const integrationId of usage.integrations) {
      const target = integrationIndex.get(integrationId);
      const weight = rows.filter((other) => other.integrations.has(integrationId)).length;
      if (target !== undefined) links.push({ kind: "call", operations: [], weight, spine: spineIndex, row, side: "integration", target });
    }
  };
  spine.forEach((item, index) => {
    if (item.expanded) item.rows.forEach((row, rowIndex) => addLinks(row, [row], index, rowIndex));
    else addLinks(item.group, item.group.endpoints, index, null);
  });

  // Vertical placement: alternate between placing the tables and integrations at the mean height of
  // their connections and the apps at the mean height of theirs. Apps keep their alphabetical order;
  // tables and integrations are ordered by that mean within their frame, which keeps edges short and
  // mostly uncrossed. The integrations frame always sits below the database frame.
  const spineHeights = spine.map((item) => item.expanded ? A.header + Math.max(item.rows.length, 1) * A.row + A.footer : A.h);
  // slots[spine][row] is the row's position inside its expanded app box.
  const slots = spine.map((item) => item.rows.map((_, index) => index));
  const rowOffset = (link: Link) => link.row === null ? spineHeights[link.spine] / 2 : A.header + slots[link.spine][link.row] * A.row + A.row / 2;
  let spineTops = packColumn(spine.map(() => 0), spineHeights, A.gap);
  const sides = {
    table: { count: tables.length, h: T.h, gap: T.gap, tops: [] as number[] },
    integration: { count: integrations.length, h: I.h, gap: I.gap, tops: [] as number[] },
  };
  const placeSides = () => {
    let min = -Infinity;
    for (const [side, column] of Object.entries(sides) as [Link["side"], typeof sides.table][]) {
      if (!column.count) continue;
      const anchors = Array.from({ length: column.count }, () => [] as number[]);
      for (const link of links) if (link.side === side) anchors[link.target].push(spineTops[link.spine] + rowOffset(link));
      const names = side === "table" ? tables : integrations;
      const desired = anchors.map((ys) => ys.length ? mean(ys) - column.h / 2 : Infinity);
      const used = desired.map((_, index) => index).filter((index) => desired[index] !== Infinity)
        .sort((a, b) => desired[a] - desired[b] || byName(names[a], names[b]));
      const unused = desired.map((_, index) => index).filter((index) => desired[index] === Infinity);
      const packed = packColumn(used.map((index) => desired[index]), used.map(() => column.h), column.gap, min);
      column.tops = [];
      used.forEach((index, position) => { column.tops[index] = packed[position]; });
      // Unused entries go last, after a wider gap, so the connected ones stay together.
      let next = used.length ? packed[packed.length - 1] + column.h + column.gap * 4 : Math.max(min, spineTops[0] ?? 0);
      for (const index of unused) {
        column.tops[index] = next;
        next += column.h + column.gap;
      }
      // The next frame starts below this one: its bottom padding, the gap, and the next label area.
      min = Math.max(...column.tops) + column.h + F.pad + F.gap + F.header;
    }
  };
  const placeSpine = () => {
    const desired = spine.map((_, index) => {
      const ys = links.filter((link) => link.spine === index)
        .map((link) => sides[link.side].tops[link.target] + sides[link.side].h / 2 - rowOffset(link));
      return ys.length ? mean(ys) : spineTops[index];
    });
    spineTops = packColumn(desired, spineHeights, A.gap);
  };
  // Endpoint rows are ordered by the mean height of what they connect to, which groups endpoints
  // that use the same tables. Ties keep the alphabetical order; rows without connections go last.
  const placeRows = () => spine.forEach((item, index) => {
    if (!item.expanded) return;
    const ys = item.rows.map(() => [] as number[]);
    for (const link of links) if (link.spine === index && link.row !== null) ys[link.row].push(sides[link.side].tops[link.target]);
    const order = ys.map((values, row) => ({ row, mean: values.length ? mean(values) : Infinity }))
      .sort((a, b) => a.mean - b.mean || a.row - b.row);
    order.forEach(({ row }, position) => { slots[index][row] = position; });
  });
  placeSides();
  for (let round = 0; round < 4; round++) {
    placeRows();
    placeSpine();
    placeSides();
  }

  // Columns, centred horizontally when the canvas is wider than the content.
  const frameWidth = Math.max(T.w, I.w) + F.pad * 2;
  const leftWidth = tables.length || integrations.length ? frameWidth + columnGap : 0;
  const contentWidth = leftWidth + A.w;
  const width = Math.max(minWidth, contentWidth + pad * 2);
  const frameX = (width - contentWidth) / 2;
  const appX = frameX + leftWidth;

  // Shift everything so the topmost box or frame sits at `top`.
  const allTops = [...spineTops, ...[sides.table.tops, sides.integration.tops].filter((tops) => tops.length).map((tops) => Math.min(...tops) - F.header)];
  const shift = top - (allTops.length ? Math.min(...allTops) : 0);

  const apps: GraphApp[] = spine.map((item, index) => {
    const y = Math.round(spineTops[index] + shift);
    const tableOperations = [...item.group.access.values()];
    return {
      key: `app:${item.group.app.id}`, app: item.group.app, expanded: item.expanded,
      x: appX, y, w: A.w, h: spineHeights[index],
      totalEndpoints: item.group.endpoints.length,
      stats: {
        reads: tableOperations.filter((operations) => [...operations].some((operation) => reads.has(operation))).length,
        writes: tableOperations.filter((operations) => [...operations].some((operation) => writes.has(operation))).length,
        calls: item.group.integrations.size,
      },
      rows: item.rows.map((row, rowIndex) => ({
        key: `endpoint:${row.endpoint.id}`, endpoint: row.endpoint, y: y + A.header + slots[index][rowIndex] * A.row, h: A.row,
        connected: links.some((link) => link.spine === index && link.row === rowIndex),
        operations: focus?.kind === "table" ? [...row.access.get(focus.id) ?? []] : undefined,
      })),
    };
  });
  // Links refer to rows by their original index; the public rows are sorted top to bottom.
  const rowNodes = apps.map((app) => app.rows);
  for (const app of apps) app.rows = [...app.rows].sort((a, b) => a.y - b.y);
  const graphTables: GraphTable[] = tables.map((entity, index) => ({
    key: `table:${entity.id}`, entity, x: frameX + F.pad, y: Math.round(sides.table.tops[index] + shift), w: T.w, h: T.h,
    usage: sideUsage(groups, (row) => { const operations = row.access.get(entity.id); return operations ? [...operations] : null; }),
  }));
  const graphIntegrations: GraphIntegration[] = integrations.map((entity, index) => ({
    key: `integration:${entity.id}`, entity, x: frameX + F.pad, y: Math.round(sides.integration.tops[index] + shift), w: I.w, h: I.h,
    usage: sideUsage(groups, (row) => row.integrations.has(entity.id) ? [] : null),
  }));

  // Ports: spread the edges leaving one box side (or endpoint row) and arriving at one box, ordered
  // by the height of their other end so neighbouring edges do not cross at the boxes.
  const targets = (link: Link) => link.side === "table" ? graphTables[link.target] : graphIntegrations[link.target];
  const sourceY = new Map<Link, number>();
  const bySource = new Map<string, Link[]>();
  for (const link of links) {
    const id = `${link.spine}:${link.row}:${link.side}`;
    bySource.set(id, [...bySource.get(id) ?? [], link]);
  }
  for (const group of bySource.values()) {
    const { spine: index, row } = group[0];
    const app = apps[index];
    group.sort((a, b) => targets(a).y - targets(b).y || a.target - b.target);
    const ys = row === null
      ? spread(group.length, app.y + 22, app.y + app.h - 22, 4)
      : spread(group.length, rowNodes[index][row].y + 7, rowNodes[index][row].y + A.row - 7, 2);
    group.forEach((link, position) => sourceY.set(link, ys[position]));
  }
  const edges: GraphEdge[] = [];
  for (const side of ["table", "integration"] as const) {
    const byTarget = new Map<number, Link[]>();
    for (const link of links) if (link.side === side) byTarget.set(link.target, [...byTarget.get(link.target) ?? [], link]);
    for (const [target, group] of byTarget) {
      const node = side === "table" ? graphTables[target] : graphIntegrations[target];
      group.sort((a, b) => sourceY.get(a)! - sourceY.get(b)!);
      const ys = spread(group.length, node.y + 8, node.y + node.h - 8, 3);
      group.forEach((link, position) => {
        const app = apps[link.spine];
        const sourceKey = link.row === null ? app.key : rowNodes[link.spine][link.row].key;
        edges.push({
          key: `${sourceKey}->${node.key}`, kind: link.kind, operations: link.operations, weight: link.weight,
          sourceKey, appKey: app.key, targetKey: node.key,
          x1: app.x, y1: sourceY.get(link)!, x2: node.x + node.w, y2: ys[position],
        });
      });
    }
  }
  edges.sort((a, b) => a.key.localeCompare(b.key));

  const frames: GraphFrame[] = [];
  for (const [kind, nodes] of [["tables", graphTables], ["integrations", graphIntegrations]] as const) {
    if (!nodes.length) continue;
    const y = Math.min(...nodes.map((node) => node.y)) - F.header;
    const bottom = Math.max(...nodes.map((node) => node.y + node.h)) + F.pad;
    frames.push({ kind, x: frameX, y, w: frameWidth, h: bottom - y, count: nodes.length });
  }

  const bottoms = [...apps, ...frames].map((box) => box.y + box.h);
  const byTop = (a: { y: number }, b: { y: number }) => a.y - b.y;
  return {
    width, height: (bottoms.length ? Math.max(...bottoms) : top) + pad, frames,
    apps, tables: graphTables.sort(byTop), integrations: graphIntegrations.sort(byTop), edges,
  };
}
