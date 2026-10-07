"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type Tab = { id: string; label: string; content: ReactNode };

const nextIndexByKey: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Accessible tabs; only the active panel's content is mounted. */
export default function Tabs({ label, tabs, toolbar }: { label: string; tabs: Tab[]; toolbar?: ReactNode }) {
  const [active, setActive] = useState(tabs[0].id);
  const prefix = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent, index: number) {
    const next = nextIndexByKey[event.key]?.(index, tabs.length);
    if (next === undefined) return;
    event.preventDefault();
    setActive(tabs[next].id);
    buttons.current[next]?.focus();
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={label} className="inline-flex gap-1 rounded-lg border border-line bg-subtle p-1">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              role="tab"
              id={`${prefix}-${tab.id}-tab`}
              aria-controls={`${prefix}-${tab.id}-panel`}
              aria-selected={active === tab.id}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-[13px] ${active === tab.id ? "bg-white shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-ink"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {toolbar}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${prefix}-${tab.id}-panel`}
          aria-labelledby={`${prefix}-${tab.id}-tab`}
          hidden={active !== tab.id}
          tabIndex={0}
          className="rounded-xl"
        >
          {active === tab.id && tab.content}
        </div>
      ))}
    </>
  );
}
