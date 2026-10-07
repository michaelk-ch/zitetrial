import type { SystemSnapshot } from "../index.ts";
import { accessLabel, type MatrixGroup, type MatrixRow, type Operation } from "./access-matrix.ts";
import { edgeKind, type GraphFocus } from "./graph-layout.ts";
import type { Preprocessed } from "./preprocess.ts";

/**
 * Card-based overview: sections (stacked) hold cards (a grid) that hold chips, which hold badges.
 * The default view summarizes the system and its AI-interpreted capabilities; a focused table,
 * integration, or app switches to a data-first view of just the entities connected to it.
 */

export type BadgeTone = "read" | "write" | "unknown" | "public" | "internal";
export type Badge = { label: string; tone: BadgeTone; title?: string };
/** `key` names the entity (e.g. `endpoint:id`) for hover tracing; `focus` is the click target. */
export type Chip = { key: string; label: string; prefix?: string; title?: string; badges: Badge[]; focus?: GraphFocus; muted?: boolean };
export type CardKind = "database" | "table" | "integration" | "app" | "capability";
export type Card = {
  key: string; kind: CardKind; title: string; subtitle?: string; description?: string; category?: string;
  badges: Badge[]; chips: Chip[];
  /** Chips shown before the rest collapse into "+X"; undefined shows all. */
  limit?: number;
  focus?: GraphFocus; focused?: boolean; wide?: boolean; muted?: boolean;
};
export type SectionId = "database" | "integrations" | "applications" | "capabilities";
export type Section = { id: SectionId; title: string; meta: string; cards: Card[] };
export type Overview = {
  header: { kicker: string; title: string; subtitle: string };
  sections: Section[];
  /** Entity keys and their direct neighbours (endpoint ↔ app ↔ table/integration), for hover tracing. */
  related: Map<string, Set<string>>;
};

export const overviewLimits = { tables: 40, integrationApps: 3, appEndpoints: 3, capabilityEndpoints: 5 };

const prominenceOrder = { core: 0, supporting: 1, utility: 2, uncertain: 3 };
const writes = new Set<Operation>(["create", "update", "delete"]);
const reads = new Set<Operation>(["read", "join"]);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const capabilityCount = (count: number) => count === 1 ? "1 capability" : `${count} capabilities`;
const titleCase = (text: string) => text.length <= 2 ? text.toUpperCase() : text[0].toUpperCase() + text.slice(1);
const sameFocus = (a: GraphFocus, b: GraphFocus) => a?.kind === b?.kind && a?.id === b?.id;

export const overviewKey = (kind: "app" | "table" | "integration" | "endpoint" | "capability", id: string) => `${kind}:${id}`;

const verbs: Record<Operation, string> = { read: "reads", join: "joins", create: "creates", update: "updates", delete: "deletes", unknown: "accesses (unclassified)" };

/** CRUD badge such as "RU", titled e.g. "refund reads, updates Payments". */
function accessBadge(operations: Set<Operation> | undefined, subject: string, table: string): Badge[] {
  if (!operations?.size) return [];
  return [{ label: accessLabel(operations), tone: edgeKind(operations), title: `${subject} ${[...operations].map((operation) => verbs[operation]).join(", ")} ${table}` }];
}

export function buildOverview({ analysis: model, interpretation }: SystemSnapshot, data: Preprocessed, focus: GraphFocus = null): Overview {
  const { groups } = data;
  const interpreted = new Map(interpretation.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]));
  const purposes = new Map(interpretation.apps.map((app) => [app.appId, app.purpose]));
  const appNames = new Map(model.apps.map((app) => [app.id, app.name]));
  const byProminence = (a: MatrixRow, b: MatrixRow) =>
    prominenceOrder[interpreted.get(a.endpoint.id)?.prominence ?? "uncertain"] - prominenceOrder[interpreted.get(b.endpoint.id)?.prominence ?? "uncertain"]
    || a.endpoint.name.localeCompare(b.endpoint.name) || a.endpoint.id.localeCompare(b.endpoint.id);
  const connected = (row: MatrixRow) => row.access.size > 0 || row.integrations.size > 0;

  const related = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    for (const [from, to] of [[a, b], [b, a]]) related.set(from, (related.get(from) ?? new Set([from])).add(to));
  };
  for (const group of groups) {
    const appKey = overviewKey("app", group.app.id);
    for (const row of group.endpoints) {
      const endpointKey = overviewKey("endpoint", row.endpoint.id);
      link(endpointKey, appKey);
      const targets = [...[...row.access.keys()].map((id) => overviewKey("table", id)), ...[...row.integrations].map((id) => overviewKey("integration", id))];
      for (const target of targets) {
        link(endpointKey, target);
        link(appKey, target);
      }
    }
  }

  const endpointChip = (row: MatrixRow, { prefix, badges = [], clickable = true }: { prefix?: boolean; badges?: Badge[]; clickable?: boolean } = {}): Chip => {
    const purpose = interpreted.get(row.endpoint.id)?.purpose ?? row.endpoint.description;
    const appName = appNames.get(row.endpoint.appId)!;
    return {
      key: overviewKey("endpoint", row.endpoint.id), label: row.endpoint.name, prefix: prefix ? appName : undefined, badges,
      title: [prefix ? `${appName} · ${row.endpoint.name}` : row.endpoint.name, purpose, connected(row) ? "" : "No table access or integration calls found",
        clickable ? `Click to focus ${appName}` : ""].filter(Boolean).join("\n"),
      focus: clickable ? { kind: "app", id: row.endpoint.appId } : undefined,
      muted: !connected(row),
    };
  };
  const appCard = (group: MatrixGroup, rows: MatrixRow[], chips: Chip[], { limit, wide = false }: { limit?: number; wide?: boolean } = {}): Card => {
    const { app } = group;
    const total = group.endpoints.length;
    const focused = sameFocus(focus, { kind: "app", id: app.id });
    return {
      key: overviewKey("app", app.id), kind: "app", title: app.name,
      subtitle: rows.length === total ? plural(total, "endpoint") : `${rows.length} of ${plural(total, "endpoint")}`,
      description: purposes.get(app.id) ?? app.description,
      badges: app.visibility === "unknown" ? [] : [{ label: titleCase(app.visibility), tone: app.visibility }],
      chips, limit, focus: { kind: "app", id: app.id }, focused, wide: wide || focused,
    };
  };
  const tableUsage = (tableId: string) => {
    const usage = { apps: 0, endpoints: 0, readers: 0, writers: 0 };
    for (const group of groups) {
      const rows = group.endpoints.filter((row) => row.access.has(tableId));
      if (rows.length) usage.apps++;
      usage.endpoints += rows.length;
      usage.readers += rows.filter((row) => [...row.access.get(tableId)!].some((operation) => reads.has(operation))).length;
      usage.writers += rows.filter((row) => [...row.access.get(tableId)!].some((operation) => writes.has(operation))).length;
    }
    return usage;
  };
  const integrationUsage = (integrationId: string, scope = groups) => {
    const users = scope.filter((group) => group.integrations.has(integrationId));
    return { apps: users, endpoints: users.reduce((sum, group) => sum + group.endpoints.filter((row) => row.integrations.has(integrationId)).length, 0) };
  };
  const integrationCard = (id: string, { scope, chips = false }: { scope?: MatrixGroup[]; chips?: boolean } = {}): Card => {
    const entity = data.integrations.find((integration) => integration.id === id)!;
    const usage = integrationUsage(id, scope);
    const focused = sameFocus(focus, { kind: "integration", id });
    const category = entity.category ? titleCase(entity.category) : "Integration";
    return {
      key: overviewKey("integration", id), kind: "integration", title: entity.name, category: entity.category,
      subtitle: usage.endpoints === 0 ? `${category} · not called` : scope
        ? `${category} · called by ${plural(usage.endpoints, "endpoint")}`
        : `${category} · ${plural(usage.endpoints, "endpoint")} in ${plural(usage.apps.length, "app")}`,
      description: entity.description, badges: [], muted: usage.endpoints === 0,
      chips: chips ? usage.apps.map((group) => ({
        key: overviewKey("app", group.app.id), label: group.app.name, badges: [], focus: { kind: "app", id: group.app.id },
        title: `${group.app.name}\nClick to focus`,
      })) : [],
      limit: chips ? overviewLimits.integrationApps : undefined,
      focus: { kind: "integration", id }, focused, wide: focused,
    };
  };
  const tableChip = (id: string, name: string, badges: Badge[] = []): Chip => {
    const description = data.tables.find((table) => table.id === id)?.description;
    const usage = tableUsage(id);
    return {
      key: overviewKey("table", id), label: name, badges, focus: { kind: "table", id }, muted: usage.endpoints === 0,
      title: [name, description, usage.endpoints === 0 ? "Not accessed by any endpoint" : `Used by ${plural(usage.apps, "app")} through ${plural(usage.endpoints, "endpoint")}`, "Click to focus"]
        .filter(Boolean).join("\n"),
    };
  };
  const section = (id: SectionId, title: string, meta: string, cards: Card[]): Section[] => cards.length ? [{ id, title, meta, cards }] : [];
  const repo = model.repository.name;

  const focusedApp = focus?.kind === "app" ? groups.find((group) => group.app.id === focus.id) : undefined;
  if (focusedApp) {
    const tables = data.tables.filter((table) => focusedApp.access.has(table.id));
    const integrations = data.integrations.filter((integration) => focusedApp.integrations.has(integration.id));
    const rows = [...focusedApp.endpoints].sort(byProminence);
    const { app } = focusedApp;
    return {
      header: {
        kicker: `${repo} · application`, title: app.name,
        subtitle: [`${app.visibility === "unknown" ? "Unknown visibility" : titleCase(app.visibility)} app`, plural(rows.length, "endpoint"),
          `uses ${plural(tables.length, "table")}`, integrations.length ? `calls ${integrations.map((integration) => integration.name).join(", ")}` : "no integrations"].join(" · "),
      },
      sections: [
        ...section("database", "Database", `${tables.length} of ${plural(data.tables.length, "table")}`, tables.length ? [{
          key: "database", kind: "database", title: "Tables used", subtitle: `${plural(tables.length, "table")} accessed by ${app.name}`, wide: true, badges: [],
          chips: tables.map((table) => tableChip(table.id, table.name, accessBadge(focusedApp.access.get(table.id), app.name, table.name))),
        }] : []),
        ...section("integrations", "Integrations", plural(integrations.length, "integration"), integrations.map((integration) => integrationCard(integration.id, { scope: [focusedApp] }))),
        ...section("applications", "Application", plural(rows.length, "endpoint"), [appCard(focusedApp, rows, rows.map((row) => endpointChip(row, { clickable: false })))]),
      ],
      related,
    };
  }

  const focusedTable = focus?.kind === "table" ? data.tables.find((table) => table.id === focus.id) : undefined;
  const focusedIntegration = focus?.kind === "integration" ? data.integrations.find((integration) => integration.id === focus.id) : undefined;
  if (focusedTable || focusedIntegration) {
    const id = (focusedTable ?? focusedIntegration)!.id;
    const uses = (row: MatrixRow) => focusedTable ? row.access.has(id) : row.integrations.has(id);
    const apps = groups.map((group) => ({ group, rows: group.endpoints.filter(uses).sort(byProminence) })).filter(({ rows }) => rows.length);
    const endpoints = apps.reduce((sum, { rows }) => sum + rows.length, 0);
    // Apps with many endpoints get a full row so their chips stay readable.
    const appCards = apps.map(({ group, rows }) => appCard(group, rows, rows.map((row) => endpointChip(row, {
      badges: focusedTable ? accessBadge(row.access.get(id), row.endpoint.name, focusedTable.name) : [],
    })), { wide: rows.length > 8 }));
    let header: Overview["header"];
    let focusSection: Section[];
    if (focusedTable) {
      const usage = tableUsage(id);
      const subtitle = usage.endpoints === 0 ? "Not accessed by any endpoint"
        : [`Used by ${plural(usage.apps, "app")}`, `read by ${plural(usage.readers, "endpoint")}`, `written by ${plural(usage.writers, "endpoint")}`].join(" · ");
      header = { kicker: `${repo} · table`, title: focusedTable.name, subtitle };
      focusSection = section("database", "Database", "1 table", [{
        key: overviewKey("table", id), kind: "table", title: focusedTable.name, subtitle, description: focusedTable.description,
        badges: [], chips: [], focus: { kind: "table", id }, focused: true, wide: true, muted: usage.endpoints === 0,
      }]);
    } else {
      const card = integrationCard(id);
      header = { kicker: `${repo} · integration`, title: focusedIntegration!.name, subtitle: card.subtitle! };
      focusSection = section("integrations", "Integrations", "1 integration", [card]);
    }
    return {
      header,
      sections: [...focusSection, ...section("applications", "Applications", `${plural(apps.length, "app")} · ${plural(endpoints, "endpoint")}`, appCards)],
      related,
    };
  }

  // Default view. Capabilities only list endpoints shown in the current access mode.
  const shown = new Map(groups.flatMap((group) => group.endpoints.map((row) => [row.endpoint.id, row])));
  const capabilities = interpretation.capabilities.map((capability) => ({
    capability,
    rows: interpretation.endpoints.filter((endpoint) => endpoint.capabilityId === capability.id && shown.has(endpoint.endpointId))
      .map((endpoint) => shown.get(endpoint.endpointId)!).sort(byProminence),
  })).filter(({ rows }) => rows.length);
  const endpointCount = shown.size;
  return {
    header: {
      kicker: "System overview", title: repo,
      subtitle: [plural(groups.length, "app"), plural(endpointCount, "endpoint"), plural(data.tables.length, "table"),
        plural(data.integrations.length, "integration"), capabilityCount(capabilities.length)].join(" · "),
    },
    sections: [
      ...section("database", "Database", plural(data.tables.length, "table"), data.tables.length ? [{
        key: "database", kind: "database", title: "Shared database", subtitle: `${plural(data.tables.length, "table")} shared by all apps`, wide: true, badges: [],
        chips: data.tables.map((table) => tableChip(table.id, table.name)), limit: overviewLimits.tables,
      }] : []),
      ...section("integrations", "Integrations", plural(data.integrations.length, "integration"), data.integrations.map((integration) => integrationCard(integration.id, { chips: true }))),
      ...section("applications", "Applications", `${plural(groups.length, "app")} · ${plural(endpointCount, "endpoint")}`,
        groups.map((group) => {
          const rows = [...group.endpoints].sort(byProminence);
          return appCard(group, rows, rows.map((row) => endpointChip(row)), { limit: overviewLimits.appEndpoints });
        })),
      ...section("capabilities", "Capabilities", capabilityCount(capabilities.length), capabilities.map(({ capability, rows }) => ({
        key: overviewKey("capability", capability.id), kind: "capability", title: capability.label, description: capability.purpose,
        subtitle: `${plural(rows.length, "endpoint")} in ${[...new Set(rows.map((row) => appNames.get(row.endpoint.appId)))].join(", ")}`,
        badges: [], chips: rows.map((row) => endpointChip(row, { prefix: true })), limit: overviewLimits.capabilityEndpoints,
      }))),
    ],
    related,
  };
}
