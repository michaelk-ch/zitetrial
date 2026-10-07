import type { ReactNode } from "react";

/** Bordered content card with an optional title bar. */
export default function Panel({ title, meta, className = "", children }: {
  title?: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`overflow-hidden rounded-xl border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          {meta && <p className="text-xs text-muted">{meta}</p>}
        </header>
      )}
      {children}
    </section>
  );
}
