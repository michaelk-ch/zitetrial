"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SystemModel } from "@/system-model/schema";
import { accessLabel, type Operation } from "@/system-model/inference/access-matrix";
import {
  edgeKind, graphSizes, layoutGraph,
  type EdgeKind, type GraphApp, type GraphEdge, type GraphFocus, type GraphIntegration, type GraphLayout, type GraphTable,
} from "@/system-model/inference/graph-layout";
import Panel from "../panel";

// The graph is plain SVG with inline presentation attributes, so the exported image matches the screen.
const SANS = "Arial, Helvetica, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const HEADER = 156;
const INK = "#1f2328";
const MUTED = "#6e7379";
const FAINT = "#a3a7ad";
const BORDER = "#dfe1e4";

// Writes are red and reads blue, so edges that do both blend to violet.
const colors: Record<EdgeKind, string> = { read: "#3b7ddd", write: "#e5484d", both: "#8e4ec6", unknown: "#9aa0a6", call: "#12a594" };
const legend: [EdgeKind, string][] = [["read", "Reads"], ["write", "Writes"], ["both", "Reads & writes"], ["call", "Calls"], ["unknown", "Unclassified"]];
const verbs: Record<Operation, string> = { read: "reads", join: "joins", create: "creates", update: "updates", delete: "deletes", unknown: "accesses (unclassified)" };
const visibility = {
  public: { label: "Public", fill: "#e6f4ec", ink: "#257047" },
  internal: { label: "Internal", fill: "#eef0f5", ink: "#4d5670" },
  unknown: { label: "", fill: "#f1f2f3", ink: MUTED },
};
const categories: Record<string, { fill: string; ink: string; icon: ReactNode }> = {
  ai: { fill: "#f1ebfd", ink: "#6941c6", icon: <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" /> },
  email: { fill: "#e7f0fc", ink: "#2c64b0", icon: <><rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 4.5L8 8.8l5.5-4.3" fill="none" stroke="currentColor" strokeWidth="1.5" /></> },
  payments: { fill: "#e6f4ec", ink: "#257047", icon: <><rect x="1.5" y="3.5" width="13" height="9" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="2" /></> },
  other: { fill: "#f0f1f3", ink: "#4d5670", icon: <path d="M9 1.5L3 9h4.5L7 14.5 13 7H8.5z" /> },
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const titleCase = (text: string) => text.length <= 2 ? text.toUpperCase() : text[0].toUpperCase() + text.slice(1);
const focusKey = (focus: GraphFocus) => focus ? `${focus.kind}:${focus.id}` : "";

let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string) {
  measureContext ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * Number.parseFloat(font.split("px")[0].split(" ").pop()!) * 0.55;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
/** Truncates with an ellipsis to fit `maxWidth` pixels. */
function fit(text: string, maxWidth: number, font: string) {
  if (textWidth(text, font) <= maxWidth) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textWidth(`${text.slice(0, middle)}…`, font) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

function edgePath({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const middle = (x1 + x2) / 2;
  return `M${x1} ${y1}C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`;
}

/** Node keys map to short CSS class tokens so hover highlighting is a single generated stylesheet. */
type Tokens = Map<string, string>;
const tokenClass = (tokens: Tokens, ...keys: string[]) => [...new Set(keys)].map((key) => tokens.get(key)).join(" ");

const Edges = memo(function Edges({ edges, tokens, names }: { edges: GraphEdge[]; tokens: Tokens; names: Map<string, string> }) {
  const opacity = edges.length > 600 ? 0.16 : edges.length > 200 ? 0.3 : 0.5;
  return (
    <g fill="none" strokeOpacity={opacity} strokeLinecap="round">
      {edges.map((edge) => {
        const title = `${names.get(edge.sourceKey)} ${edge.kind === "call" ? "calls" : edge.operations.map((operation) => verbs[operation]).join(", ")} ${names.get(edge.targetKey)}`
          + (edge.weight > 1 ? ` (${edge.weight} endpoints)` : "");
        return (
          <path
            key={edge.key}
            className={`edge ${tokenClass(tokens, edge.sourceKey, edge.appKey, edge.targetKey)}`}
            d={edgePath(edge)}
            stroke={colors[edge.kind]}
            strokeWidth={1.3 + Math.min(3, Math.log2(edge.weight) * 0.8)}
            strokeDasharray={edge.kind === "unknown" ? "4 4" : undefined}
          >
            <title>{title}</title>
          </path>
        );
      })}
    </g>
  );
});

type NodeProps = {
  tokens: Tokens; focused: boolean; onFocus: () => void; onHover: (key: string | null) => void; label: string; tooltip: string; className?: string; nodeKey: string; children: ReactNode;
};
/** A clickable, keyboard-focusable graph box. */
function Node({ tokens, focused, onFocus, onHover, label, tooltip, nodeKey, className = "", children }: NodeProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFocus();
  };
  return (
    <g
      className={`node ${tokens.get(nodeKey)} group cursor-pointer outline-none ${className}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={focused}
      onClick={onFocus}
      onKeyDown={onKeyDown}
      onMouseEnter={() => onHover(nodeKey)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(nodeKey)}
      onBlur={() => onHover(null)}
    >
      <title>{tooltip}</title>
      {children}
    </g>
  );
}

/** Card with a soft shadow; `.card` gets hover and keyboard-focus styles. */
function Card({ x, y, w, h, r, focused, dashed }: { x: number; y: number; w: number; h: number; r: number; focused?: boolean; dashed?: boolean }) {
  return (
    <>
      <rect x={x} y={y + 3} width={w} height={h} rx={r} fill="#1f2328" fillOpacity={0.04} />
      <rect x={x} y={y + 1} width={w} height={h} rx={r} fill="#1f2328" fillOpacity={0.04} />
      <rect
        className="card transition-[stroke] group-hover:stroke-[#9ea3aa] group-focus-visible:stroke-focus group-focus-visible:stroke-2"
        x={x} y={y} width={w} height={h} rx={r}
        fill={focused ? "#fbfaf7" : "#ffffff"} stroke={focused ? INK : BORDER} strokeWidth={focused ? 1.6 : 1}
        strokeDasharray={dashed ? "4 3" : undefined}
      />
    </>
  );
}

function Icon({ x, y, size = 16, color, children }: { x: number; y: number; size?: number; color: string; children: ReactNode }) {
  return <svg x={x} y={y} width={size} height={size} viewBox="0 0 16 16" color={color} fill={color} aria-hidden="true">{children}</svg>;
}

const tableIcon = <><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.5 6.5h13M6 6.5v7" stroke="currentColor" strokeWidth="1.4" /></>;
const appIcon = <><rect x="1.5" y="2" width="13" height="12" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.5" /><circle cx="3.8" cy="3.8" r=".6" /><circle cx="5.6" cy="3.8" r=".6" /></>;

function Header({ kicker, title, subtitle, width, kinds }: { kicker: string; title: string; subtitle: string; width: number; kinds: Set<EdgeKind> }) {
  const { pad } = graphSizes;
  const items = legend.filter(([kind]) => kinds.has(kind) || kind === "read" || kind === "write");
  const font = `12px ${SANS}`;
  const widths = items.map(([, label]) => 26 + textWidth(label, font) + 18);
  const starts = widths.map((_, index) => width - pad + 18 - widths.slice(index).reduce((sum, value) => sum + value, 0));
  const titleFont = `700 26px ${SANS}`;
  return (
    <g fontFamily={SANS}>
      <text x={pad} y={46} fontSize={11} fontWeight={700} letterSpacing={1.4} fill={FAINT}>{kicker.toUpperCase()}</text>
      <text x={pad} y={78} fontSize={26} fontWeight={700} letterSpacing={-0.6} fill={INK}>{fit(title, width - pad * 2 - 420, titleFont)}</text>
      <text x={pad} y={102} fontSize={13} fill={MUTED}>{fit(subtitle, width - pad * 2 - 120, `13px ${SANS}`)}</text>
      {items.map(([kind, label], index) => {
        const itemX = starts[index];
        const line = (dy: number, color: string) => <path d={`M${itemX} ${48 + dy}h20`} stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={kind === "unknown" ? "3 3" : undefined} />;
        return (
          <g key={kind}>
            {line(0, colors[kind])}
            <text x={itemX + 26} y={52} fontSize={12} fill={MUTED}>{label}</text>
          </g>
        );
      })}
      <path d={`M${pad} 124H${width - pad}`} stroke="#ebecee" />
    </g>
  );
}

type NodeCallbacks = { focus: GraphFocus; tokens: Tokens; onFocus: (focus: GraphFocus) => void; onHover: (key: string | null) => void };

function AppNode({ node, focus, tokens, onFocus, onHover, pinned, onPin }: { node: GraphApp; pinned: string | null; onPin: (key: string) => void } & NodeCallbacks) {
  const { x, y, w, h, app } = node;
  const badge = visibility[app.visibility];
  const focused = focus?.kind === "app" && focus.id === app.id;
  const badgeWidth = badge.label ? textWidth(badge.label, `700 10.5px ${SANS}`) + 16 : 0;
  const endpointText = node.expanded && node.rows.length !== node.totalEndpoints
    ? `${node.rows.length} of ${plural(node.totalEndpoints, "endpoint")}`
    : plural(node.totalEndpoints, "endpoint");
  const stats: [EdgeKind, string][] = [["read", `reads ${node.stats.reads}`], ["write", `writes ${node.stats.writes}`], ["call", `calls ${node.stats.calls}`]];
  const nameFont = `700 14.5px ${SANS}`;
  const rowFont = `11.5px ${MONO}`;
  return (
    <Node
      nodeKey={node.key} tokens={tokens} focused={focused}
      onFocus={() => onFocus(focused ? null : { kind: "app", id: app.id })} onHover={onHover}
      label={`${app.name}, ${badge.label ? `${badge.label.toLowerCase()} ` : ""}app with ${plural(node.totalEndpoints, "endpoint")}`}
      tooltip={`${app.name}${app.description ? `\n${app.description}` : ""}\n${badge.label ? `${badge.label} app · ` : ""}${plural(node.totalEndpoints, "endpoint")}\nReads ${plural(node.stats.reads, "table")}, writes ${node.stats.writes}, calls ${plural(node.stats.calls, "integration")}\n${focused ? "Click to show all apps" : "Click to focus and show endpoints"}`}
    >
      <Card x={x} y={y} w={w} h={h} r={14} focused={focused} />
      <rect x={x + 16} y={y + 17} width={34} height={34} rx={9} fill={badge.fill} />
      <Icon x={x + 25} y={y + 26} color={badge.ink}>{appIcon}</Icon>
      <text x={x + 62} y={y + 31} fontFamily={SANS} fontSize={14.5} fontWeight={700} fill={INK}>{fit(app.name, w - 62 - 16, nameFont)}</text>
      {badge.label && (
        <g>
          <rect x={x + 62} y={y + 38} width={badgeWidth} height={17} rx={8.5} fill={badge.fill} />
          <text x={x + 62 + badgeWidth / 2} y={y + 50} textAnchor="middle" fontFamily={SANS} fontSize={10.5} fontWeight={700} fill={badge.ink}>{badge.label}</text>
        </g>
      )}
      <text x={x + 62 + (badgeWidth ? badgeWidth + 8 : 0)} y={y + 51} fontFamily={SANS} fontSize={12} fill={MUTED}>{endpointText}</text>
      <path d={`M${x + 1} ${y + 66}h${w - 2}`} stroke="#eef0f2" />
      {!node.expanded && stats.map(([kind, label], index) => (
        <g key={kind}>
          <circle cx={x + 22 + index * 92} cy={y + 83} r={3.5} fill={colors[kind]} />
          <text x={x + 31 + index * 92} y={y + 87} fontFamily={SANS} fontSize={12} fill={MUTED}>{label}</text>
        </g>
      ))}
      {node.expanded && node.rows.length === 0 && (
        <text x={x + 18} y={y + graphSizes.app.header + 16} fontFamily={SANS} fontSize={12} fill={FAINT}>No endpoints</text>
      )}
      {node.rows.map((row) => {
        const kind = row.operations && row.operations.length > 0 ? edgeKind(row.operations) : null;
        const label = row.operations ? accessLabel(new Set(row.operations)) : "";
        return (
          <g
            key={row.key}
            className={`row ${tokens.get(row.key)} group/row`}
            onClick={(event) => { event.stopPropagation(); onPin(row.key); }}
            onMouseEnter={() => onHover(row.key)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${row.endpoint.name}${row.endpoint.description ? `\n${row.endpoint.description}` : ""}${row.connected ? "" : "\nNo table access or integration calls found"}\n${pinned === row.key ? "Click to unpin" : "Click to pin its connections"}`}</title>
            <rect
              x={x + 6} y={row.y + 1} width={w - 12} height={row.h - 2} rx={5}
              fill={pinned === row.key ? "#eceff3" : "transparent"} className={pinned === row.key ? "" : "group-hover/row:fill-[#f3f4f6]"}
            />
            <text x={x + 18} y={row.y + row.h / 2 + 4} fontFamily={MONO} fontSize={11.5} fill={row.connected ? "#33383e" : FAINT}>
              {fit(row.endpoint.name, w - 36 - (label ? textWidth(label, `700 ${rowFont}`) + 10 : 0), rowFont)}
            </text>
            {label && kind && (
              <text x={x + w - 16} y={row.y + row.h / 2 + 4} textAnchor="end" fontFamily={MONO} fontSize={11.5} fontWeight={700} fill={colors[kind]}>{label}</text>
            )}
          </g>
        );
      })}
    </Node>
  );
}

function usageTooltip(name: string, description: string | undefined, lines: string[], focused: boolean) {
  return [name, description, ...lines, focused ? "Click to show all apps" : "Click to focus"].filter(Boolean).join("\n");
}

function TableNode({ node, focus, tokens, onFocus, onHover }: { node: GraphTable } & NodeCallbacks) {
  const { x, y, w, h, entity, usage } = node;
  const focused = focus?.kind === "table" && focus.id === entity.id;
  const unused = usage.endpoints === 0;
  const font = `${focused ? "700 " : ""}12.5px ${SANS}`;
  const lines = unused ? ["Not accessed by any endpoint"] : [
    `Used by ${plural(usage.apps, "app")} through ${plural(usage.endpoints, "endpoint")}`,
    `Read by ${usage.readers}, written by ${usage.writers}`,
  ];
  return (
    <Node
      nodeKey={node.key} tokens={tokens} focused={focused} className={unused ? "opacity-60" : ""}
      onFocus={() => onFocus(focused ? null : { kind: "table", id: entity.id })} onHover={onHover}
      label={`${entity.name} table, ${unused ? "not accessed" : `used by ${plural(usage.apps, "app")}`}`}
      tooltip={usageTooltip(entity.name, entity.description, lines, focused)}
    >
      <Card x={x} y={y} w={w} h={h} r={9} focused={focused} dashed={unused} />
      <Icon x={x + 12} y={y + h / 2 - 7} size={14} color={unused ? FAINT : "#868c94"}>{tableIcon}</Icon>
      <text x={x + 34} y={y + h / 2 + 4.5} fontFamily={SANS} fontSize={12.5} fontWeight={focused ? 700 : 400} fill={unused ? MUTED : INK}>
        {fit(entity.name, w - 34 - (unused ? 58 : 14), font)}
      </text>
      {unused && <text x={x + w - 12} y={y + h / 2 + 4} textAnchor="end" fontFamily={SANS} fontSize={10.5} fill={FAINT}>unused</text>}
    </Node>
  );
}

function IntegrationNode({ node, focus, tokens, onFocus, onHover }: { node: GraphIntegration } & NodeCallbacks) {
  const { x, y, w, h, entity, usage } = node;
  const focused = focus?.kind === "integration" && focus.id === entity.id;
  const style = categories[entity.category ?? ""] ?? categories.other;
  const category = entity.category ? titleCase(entity.category) : "Integration";
  return (
    <Node
      nodeKey={node.key} tokens={tokens} focused={focused}
      onFocus={() => onFocus(focused ? null : { kind: "integration", id: entity.id })} onHover={onHover}
      label={`${entity.name} integration, called by ${plural(usage.endpoints, "endpoint")}`}
      tooltip={usageTooltip(entity.name, entity.description, [`${category} integration`, `Called by ${plural(usage.endpoints, "endpoint")} in ${plural(usage.apps, "app")}`], focused)}
    >
      <Card x={x} y={y} w={w} h={h} r={12} focused={focused} />
      <rect x={x + 12} y={y + 11} width={32} height={32} rx={9} fill={style.fill} />
      <Icon x={x + 20} y={y + 19} color={style.ink}>{style.icon}</Icon>
      <text x={x + 56} y={y + 24} fontFamily={SANS} fontSize={13.5} fontWeight={700} fill={INK}>{fit(entity.name, w - 68, `700 13.5px ${SANS}`)}</text>
      <text x={x + 56} y={y + 41} fontFamily={SANS} fontSize={11.5} fill={MUTED}>{fit(`${category} · ${plural(usage.endpoints, "endpoint")}`, w - 68, `11.5px ${SANS}`)}</text>
    </Node>
  );
}

type NodesProps = NodeCallbacks & { layout: GraphLayout; pinned: string | null; onPin: (key: string) => void };
const Nodes = memo(function Nodes({ layout, pinned, onPin, ...props }: NodesProps) {
  return (
    <>
      {layout.tables.map((node) => <TableNode key={node.key} node={node} {...props} />)}
      {layout.apps.map((node) => <AppNode key={node.key} node={node} pinned={pinned} onPin={onPin} {...props} />)}
      {layout.integrations.map((node) => <IntegrationNode key={node.key} node={node} {...props} />)}
    </>
  );
});

function describe(model: SystemModel, layout: GraphLayout, focus: GraphFocus) {
  const repo = model.repository.name;
  if (focus?.kind === "app") {
    const node = layout.apps[0];
    const calls = layout.integrations.map((integration) => integration.entity.name);
    return {
      kicker: `${repo} · application`, title: node.app.name,
      subtitle: [
        `${visibility[node.app.visibility].label || "Unknown visibility"} app`, plural(node.totalEndpoints, "endpoint"),
        `reads ${plural(node.stats.reads, "table")}`, `writes ${plural(node.stats.writes, "table")}`,
        calls.length ? `calls ${calls.join(", ")}` : "no integrations",
      ].join(" · "),
    };
  }
  if (focus?.kind === "table") {
    const { entity, usage } = layout.tables[0];
    return {
      kicker: `${repo} · table`, title: entity.name,
      subtitle: usage.endpoints === 0 ? "Not accessed by any endpoint" : [
        `Used by ${plural(usage.apps, "app")}`, `read by ${plural(usage.readers, "endpoint")}`, `written by ${plural(usage.writers, "endpoint")}`,
      ].join(" · "),
    };
  }
  if (focus?.kind === "integration") {
    const { entity, usage } = layout.integrations[0];
    return {
      kicker: `${repo} · integration`, title: entity.name,
      subtitle: `${entity.category ? `${titleCase(entity.category)} integration` : "Integration"} · called by ${plural(usage.endpoints, "endpoint")} in ${plural(usage.apps, "app")}`,
    };
  }
  return {
    kicker: "System map", title: repo,
    subtitle: [plural(model.apps.length, "app"), plural(model.endpoints.length, "endpoint"), plural(model.tables.length, "table"), plural(model.integrations.length, "integration")].join(" · "),
  };
}

/** Renders the SVG at 2× into a PNG and downloads it. */
async function exportPng(svg: SVGSVGElement, fileName: string, highlight: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("class", highlight ? "graph-canvas dim" : "");
  clone.querySelector("style")!.textContent = highlight;
  clone.removeAttribute("style");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    // Browsers cap canvas size; tall focus views fall back to a lower scale.
    const scale = Math.max(1, Math.min(2, 16000 / height, 16000 / width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d")!;
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the image");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph";

export default function GraphView({ model }: { model: SystemModel }) {
  const [requestedFocus, setFocus] = useState<GraphFocus>(null);
  // Ignore a focus that no longer exists, e.g. after the model changed.
  const focus = requestedFocus && ({ app: model.apps, table: model.tables, integration: model.integrations }[requestedFocus.kind] as { id: string }[])
    .some((entity) => entity.id === requestedFocus.id) ? requestedFocus : null;
  const [hover, setHover] = useState<string | null>(null);
  // A clicked endpoint row stays highlighted (and is exported that way) until clicked again.
  const [pinned, setPinned] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => layoutGraph(model, focus, { top: HEADER }), [model, focus]);
  const { tokens, names, related } = useMemo(() => {
    const tokens: Tokens = new Map();
    const names = new Map<string, string>();
    const add = (key: string, name: string) => { tokens.set(key, `k${tokens.size}`); names.set(key, name); };
    for (const app of layout.apps) {
      add(app.key, app.app.name);
      for (const row of app.rows) add(row.key, row.endpoint.name);
    }
    for (const table of layout.tables) add(table.key, table.entity.name);
    for (const integration of layout.integrations) add(integration.key, integration.entity.name);
    // Hovering a box highlights it, its edges, and every box at the other end of them.
    const related = new Map<string, Set<string>>();
    for (const edge of layout.edges) {
      const keys = [edge.sourceKey, edge.appKey, edge.targetKey];
      for (const key of keys) {
        const set = related.get(key) ?? new Set([key]);
        keys.forEach((other) => set.add(other));
        related.set(key, set);
      }
    }
    return { tokens, names, related };
  }, [layout]);

  /** Stylesheet that dims everything except `key`, its edges, and the boxes they connect. */
  const highlightFor = (key: string | null) => {
    if (!key || !tokens.has(key)) return "";
    const lit = [...(related.get(key) ?? [key])].map((other) => `.${tokens.get(other)}`).join(",");
    return `.graph-canvas.dim .edge{stroke-opacity:.05}.graph-canvas.dim :is(.node,.row){opacity:.28}`
      + `.graph-canvas.dim .edge.${tokens.get(key)}{stroke-opacity:.9}.graph-canvas.dim :is(.node,.row):is(${lit}){opacity:1}`;
  };
  const highlight = highlightFor(hover ?? pinned);

  const kinds = useMemo(() => new Set(layout.edges.map((edge) => edge.kind)), [layout]);
  const { kicker, title, subtitle } = describe(model, layout, focus);
  const changeFocus = useCallback((next: GraphFocus) => {
    setFocus(next);
    setHover(null);
    setPinned(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const onPin = useCallback((key: string) => setPinned((current) => current === key ? null : key), []);
  useEffect(() => {
    if (!focus && !pinned) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pinned) setPinned(null);
      else changeFocus(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus, pinned, changeFocus]);

  if (model.apps.length === 0) return <Panel className="p-8 text-sm text-muted">No apps found in this workspace.</Panel>;

  const sorted = (entities: { id: string; name: string }[]) => [...entities].sort((a, b) => a.name.localeCompare(b.name));
  const options: ["app" | "table" | "integration", string, { id: string; name: string }[]][] = [
    ["app", "Applications", sorted(model.apps)],
    ["table", "Tables", sorted(model.tables)],
    ["integration", "Integrations", sorted(model.integrations)],
  ];
  const focusName = focus && names.get(`${focus.kind}:${focus.id}`);
  const commit = model.repository.commit?.slice(0, 7);

  const onExport = async () => {
    if (!svgRef.current) return;
    setExporting(true);
    try {
      await exportPng(svgRef.current, `${slug(model.repository.name)}${focus ? `-${slug(focusName ?? focus.id)}` : ""}-graph.png`, highlightFor(pinned));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 text-xs">
        <nav aria-label="Graph focus" className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {focus ? (
            <>
              <button type="button" onClick={() => changeFocus(null)} className="cursor-pointer rounded px-1 text-muted hover:text-ink hover:underline">All apps</button>
              <span aria-hidden="true" className="text-faint">/</span>
              <span className="truncate font-medium" aria-current="page">{focusName}</span>
              <button type="button" onClick={() => changeFocus(null)} aria-label="Clear focus" title="Clear focus (Esc)" className="grid size-6 cursor-pointer place-items-center rounded text-faint hover:bg-subtle hover:text-ink">×</button>
            </>
          ) : <span className="font-medium">All apps</span>}
        </nav>
        <span className="text-faint max-[900px]:hidden">
          {focus ? "Hover to trace connections; click an endpoint to pin them. Esc goes back." : "Click an app, table or integration to focus it. Hover to trace connections."}
        </span>
        <select
          value={focusKey(focus)}
          onChange={(event) => {
            const [kind, ...id] = event.target.value.split(":");
            changeFocus(kind ? { kind: kind as "app" | "table" | "integration", id: id.join(":") } : null);
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
      <div ref={scrollRef} className="max-h-[calc(100vh-230px)] min-h-[420px] overflow-auto bg-[#fafaf9]">
        <svg
          ref={svgRef}
          role="group"
          aria-label={`${title}: ${subtitle}`}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className={`graph-canvas mx-auto block h-auto w-full min-w-[880px] ${highlight ? "dim" : ""}`}
          style={{ maxWidth: layout.width }}
        >
          <style>{highlight}</style>
          <defs>
            <pattern id="graph-dots" width="22" height="22" patternUnits="userSpaceOnUse">
              <circle cx="11" cy="11" r="1" fill="#e2e3e0" />
            </pattern>
          </defs>
          <rect width={layout.width} height={layout.height} fill="#fafaf9" />
          <rect width={layout.width} height={layout.height} fill="url(#graph-dots)" />
          <Header kicker={kicker} title={title} subtitle={subtitle} width={layout.width} kinds={kinds} />
          {layout.columns.map((column) => {
            const focusedColumn = { app: "apps", table: "tables", integration: "integrations" }[focus?.kind ?? "app"] === column.kind && focus;
            const label = { tables: "Table", apps: "Application", integrations: "Integration" }[column.kind] + (focusedColumn ? "" : "s");
            return (
              <text key={column.kind} x={column.x} y={HEADER - 14} fontFamily={SANS} fontSize={10.5} fontWeight={700} letterSpacing={1.3} fill={FAINT}>
                {label.toUpperCase()}<tspan dx={6} fill="#c3c6ca">{column.count}</tspan>
              </text>
            );
          })}
          <Edges edges={layout.edges} tokens={tokens} names={names} />
          <Nodes layout={layout} focus={focus} tokens={tokens} onFocus={changeFocus} onHover={setHover} pinned={pinned} onPin={onPin} />
          <text x={layout.width - graphSizes.pad} y={layout.height - 18} textAnchor="end" fontFamily={SANS} fontSize={10.5} fill="#b9bcc0">
            {model.repository.name}{commit ? ` @ ${commit}` : ""} · Zite System Viewer
          </text>
        </svg>
      </div>
    </Panel>
  );
}
