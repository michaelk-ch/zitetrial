"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type FocusEvent, type ReactNode } from "react";
import { toPng } from "html-to-image";
import type { SystemSnapshot } from "@/system-snapshot";
import type { GraphFocus } from "@/system-snapshot/inference/graph-layout";
import { buildOverview, type Badge, type BadgeTone, type Card, type Chip, type Overview } from "@/system-snapshot/inference/overview";
import { accessModes, defaultAccessMode, preprocess } from "@/system-snapshot/inference/preprocess";
import Panel from "../panel";
import AccessModeSelect from "./access-options";
import FocusToolbar, { download, slug } from "./focus-toolbar";
import { appIcon, categories, tableIcon, visibility } from "./graph-view";

const tones: Record<BadgeTone, string> = {
  read: "bg-[#e8f0fc] text-[#2f62b0]",
  write: "bg-[#fdeced] text-[#c4373c]",
  unknown: "bg-[#f1f2f3] text-[#6e7379]",
  public: "bg-[#e6f4ec] text-[#257047]",
  internal: "bg-[#eef0f5] text-[#4d5670]",
};
const traced = (key: string) => /^(app|table|integration|endpoint):/.test(key);
const sameFocus = (a: GraphFocus, b: GraphFocus) => a?.kind === b?.kind && a?.id === b?.id;

function Icon({ size = 16, className = "", children }: { size?: number; className?: string; children: ReactNode }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={`shrink-0 ${className}`}>{children}</svg>;
}

function BadgeView({ badge }: { badge: Badge }) {
  const pill = badge.tone === "public" || badge.tone === "internal";
  return (
    <span title={badge.title} className={`shrink-0 font-bold leading-none ${tones[badge.tone]} ${pill ? "rounded-full px-2 py-[3px] text-[10.5px]" : "rounded px-1 py-[3px] font-mono text-[10px]"}`}>
      {badge.label}
    </span>
  );
}

type Callbacks = { onFocus: (focus: GraphFocus) => void };

function ChipView({ chip, onFocus }: { chip: Chip } & Callbacks) {
  const kind = chip.key.split(":")[0];
  const className = `inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border bg-[#f7f7f8] px-2 text-left text-[12px] ${chip.muted ? "border-dashed border-[#d9dbde] text-muted" : "border-[#e3e5e8] text-ink"}`;
  const content = (
    <>
      {kind === "table" && <Icon size={12} className="text-[#868c94]">{tableIcon}</Icon>}
      {kind === "app" && <Icon size={12} className="text-[#868c94]">{appIcon}</Icon>}
      {chip.prefix && <><span className="max-w-[110px] shrink-0 truncate text-muted">{chip.prefix}</span><span aria-hidden="true" className="text-faint">/</span></>}
      <span className={`truncate ${kind === "endpoint" ? "font-mono text-[11.5px]" : ""}`}>{chip.label}</span>
      {chip.badges.map((badge) => <BadgeView key={badge.label} badge={badge} />)}
    </>
  );
  return (
    <li className="min-w-0">
      {chip.focus ? (
        <button type="button" data-trace={chip.key} title={chip.title} onClick={() => onFocus(chip.focus!)} className={`${className} cursor-pointer hover:border-[#c3c7cc] hover:bg-white`}>{content}</button>
      ) : <span data-trace={chip.key} title={chip.title} className={className}>{content}</span>}
    </li>
  );
}

function CardIcon({ card }: { card: Card }) {
  if (card.kind === "capability") return null;
  let style: { fill: string; ink: string; icon: ReactNode };
  if (card.kind === "integration") style = categories[card.category ?? ""] ?? categories.other;
  else if (card.kind === "app") {
    const tone = visibility[card.badges[0]?.tone === "public" ? "public" : card.badges[0]?.tone === "internal" ? "internal" : "unknown"];
    style = { fill: tone.fill, ink: tone.ink, icon: appIcon };
  } else style = { fill: "#f0f1f3", ink: "#868c94", icon: tableIcon };
  return (
    <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px]" style={{ background: style.fill, color: style.ink }}>
      <Icon>{style.icon}</Icon>
    </span>
  );
}

function CardView({ card, expanded, onToggle, onFocus }: { card: Card; expanded: boolean; onToggle: (key: string) => void } & Callbacks) {
  const limit = expanded || card.limit === undefined ? card.chips.length : card.limit;
  const hidden = card.chips.length - limit;
  const header = (
    <>
      <CardIcon card={card} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`truncate text-[14px] font-bold ${card.muted ? "text-muted" : ""}`}>{card.title}</span>
          {card.badges.map((badge) => <BadgeView key={badge.label} badge={badge} />)}
        </span>
        {card.subtitle && <span className="mt-0.5 block truncate text-xs text-muted">{card.subtitle}</span>}
        {card.description && (
          <span title={card.description} className={`mt-1.5 block text-[12.5px] leading-[1.5] text-[#4b5057] ${card.focused ? "" : card.kind === "capability" ? "line-clamp-3" : "line-clamp-2"}`}>
            {card.description}
          </span>
        )}
      </span>
    </>
  );
  const focusTitle = card.focused ? "Click to show all apps" : "Click to focus";
  return (
    <article
      data-trace={traced(card.key) ? card.key : undefined}
      className={`flex min-w-0 flex-col rounded-xl border shadow-[0_1px_2px_rgba(31,35,40,0.05),0_3px_8px_rgba(31,35,40,0.03)] ${card.wide ? "col-span-full" : ""} ${card.focused ? "border-ink bg-[#fbfaf7] ring-1 ring-ink" : card.muted ? "border-dashed border-[#d3d6da] bg-white" : "border-[#dfe1e4] bg-white"}`}
    >
      {card.focus ? (
        <button type="button" title={focusTitle} aria-pressed={Boolean(card.focused)} onClick={() => onFocus(card.focus!)} className="group flex w-full cursor-pointer items-start gap-3 rounded-xl p-4 text-left hover:bg-[#fafafa]">
          {header}
        </button>
      ) : <div className="flex items-start gap-3 p-4">{header}</div>}
      {card.chips.length > 0 && (
        <ul className="-mt-1 flex flex-wrap gap-1.5 px-4 pb-4">
          {card.chips.slice(0, limit).map((chip) => <ChipView key={chip.key} chip={chip} onFocus={onFocus} />)}
          {(hidden > 0 || expanded) && card.limit !== undefined && card.chips.length > card.limit && (
            <li>
              <button
                type="button"
                onClick={() => onToggle(card.key)}
                aria-expanded={expanded}
                title={expanded ? "Show fewer" : `Show ${hidden} more`}
                className="inline-flex h-7 cursor-pointer items-center rounded-md border border-dashed border-[#cfd2d6] px-2 text-[12px] font-medium text-muted hover:border-[#b5b9be] hover:text-ink"
              >
                {expanded ? "Show less" : `+${hidden}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </article>
  );
}

type SectionsProps = { overview: Overview; expanded: ReadonlySet<string>; onToggle: (key: string) => void } & Callbacks;
const Sections = memo(function Sections({ overview, expanded, onToggle, onFocus }: SectionsProps) {
  return overview.sections.map((section) => (
    <section key={section.id} aria-labelledby={`overview-${section.id}`}>
      <h3 id={`overview-${section.id}`} className="mb-2.5 flex items-baseline gap-2 text-[10.5px] font-bold tracking-[0.13em] text-faint uppercase">
        {section.title}
        <span className="font-normal tracking-normal normal-case">{section.meta}</span>
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {section.cards.map((card) => <CardView key={card.key} card={card} expanded={expanded.has(card.key)} onToggle={onToggle} onFocus={onFocus} />)}
      </div>
    </section>
  ));
});

/** Dims every traced element except `key` and its direct neighbours. */
function highlightFor(overview: Overview, key: string | null) {
  if (!key) return "";
  const lit = [...(overview.related.get(key) ?? [key])].map((other) => `[data-trace="${other.replace(/["\\]/g, "\\$&")}"]`).join(",");
  return `.overview-canvas [data-trace]{opacity:.3}.overview-canvas :is(${lit}){opacity:1}`;
}

export default function OverviewView({ snapshot }: { snapshot: SystemSnapshot }) {
  const model = snapshot.analysis;
  const [requestedFocus, setFocus] = useState<GraphFocus>(null);
  // Ignore a focus that no longer exists, e.g. after the model changed.
  const focus = requestedFocus && ({ app: model.apps, table: model.tables, integration: model.integrations }[requestedFocus.kind] as { id: string }[])
    .some((entity) => entity.id === requestedFocus.id) ? requestedFocus : null;
  const [hover, setHover] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [accessMode, setAccessMode] = useState(defaultAccessMode);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Unused tables and integrations are hidden from the overview but can still be focused.
  const data = useMemo(() => {
    const options = accessModes[accessMode];
    return preprocess(snapshot, { ...options, hideUnused: options.hideUnused && !focus });
  }, [snapshot, accessMode, focus]);
  const overview = useMemo(() => buildOverview(snapshot, data, focus), [snapshot, data, focus]);

  const changeFocus = useCallback((next: GraphFocus) => {
    // Clicking the focused entity again goes back to the overview.
    setFocus((current) => sameFocus(current, next) ? null : next);
    setHover(null);
    setExpanded(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);
  const onToggle = useCallback((key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  useEffect(() => {
    if (!focus) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") changeFocus(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus, changeFocus]);

  if (model.apps.length === 0) return <Panel className="p-8 text-sm text-muted">No apps found in this workspace.</Panel>;

  // Hover and keyboard focus trace the innermost card or chip under the pointer.
  const trace = (event: MouseEvent | FocusEvent) => setHover((event.target as Element).closest("[data-trace]")?.getAttribute("data-trace") ?? null);
  const focusName = focus ? ({ app: model.apps, table: model.tables, integration: model.integrations }[focus.kind] as { id: string; name: string }[])
    .find((entity) => entity.id === focus.id)?.name : undefined;
  const commit = model.repository.commit?.slice(0, 7);
  const { kicker, title, subtitle } = overview.header;

  const onExport = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setExporting(true);
    setHover(null);
    try {
      // Browsers cap canvas size; tall views fall back to a lower scale.
      const pixelRatio = Math.max(1, Math.min(2, 16000 / canvas.scrollHeight, 16000 / canvas.scrollWidth));
      const url = await toPng(canvas, { pixelRatio, backgroundColor: "#fafaf9", skipFonts: true });
      download(await (await fetch(url)).blob(), `${slug(model.repository.name)}${focus ? `-${slug(focusName ?? focus.id)}` : ""}-overview.png`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel>
      <FocusToolbar
        model={model}
        focus={focus}
        focusName={focusName}
        onFocus={changeFocus}
        hint={focus ? "Hover to trace connections. Esc goes back." : "Click a table, integration or app to focus it. Hover to trace connections."}
        exporting={exporting}
        onExport={onExport}
      >
        <AccessModeSelect
          value={accessMode}
          onChange={setAccessMode}
          hidden={model.tables.length + model.integrations.length - data.tables.length - data.integrations.length}
        />
      </FocusToolbar>
      <div ref={scrollRef} className="max-h-[calc(100vh-230px)] min-h-[420px] overflow-auto bg-[#fafaf9]">
        <div
          ref={canvasRef}
          role="group"
          aria-label={subtitle ? `${title}: ${subtitle}` : title}
          onMouseOver={trace}
          onMouseLeave={() => setHover(null)}
          onFocus={trace}
          onBlur={() => setHover(null)}
          className="overview-canvas min-w-[600px] bg-[#fafaf9] bg-[radial-gradient(#e2e3e0_1px,transparent_1px)] bg-size-[22px_22px] bg-position-[11px_11px] px-12 pt-9 pb-6 [&_[data-trace]]:transition-opacity"
        >
          <style>{highlightFor(overview, hover)}</style>
          <header className="mb-7 border-b border-[#ebecee] pb-6">
            <p className="text-[11px] font-bold tracking-[0.13em] text-faint uppercase">{kicker}</p>
            <h2 className="mt-2 truncate text-[26px] leading-tight font-bold tracking-[-0.02em] text-[#1f2328]">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-[#6e7379]">{subtitle}</p>}
          </header>
          <div className="space-y-7">
            <Sections overview={overview} expanded={expanded} onToggle={onToggle} onFocus={changeFocus} />
          </div>
          <p className="mt-8 text-right text-[10.5px] text-[#b9bcc0]">{model.repository.name}{commit ? ` @ ${commit}` : ""} · Zite System Viewer</p>
        </div>
      </div>
    </Panel>
  );
}
