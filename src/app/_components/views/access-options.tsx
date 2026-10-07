"use client";

import type { AccessOptions } from "@/system-model/inference/preprocess";

const options: [keyof AccessOptions, string, string?][] = [
  ["hideUnused", "Hide unused columns"],
  ["showJoins", "Show joins"],
  ["prioritize", "Prioritize", "For each endpoint, keep create/delete accesses first, then updates, then reads, then joins."],
];

/** Checkboxes for the access preprocessing shared by the table and graph views. */
export default function AccessOptionsControls({ value, onChange, hidden = 0 }: { value: AccessOptions; onChange: (value: AccessOptions) => void; hidden?: number }) {
  return options.map(([key, label, title]) => (
    <label key={key} title={title} className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none">
      <input type="checkbox" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} className="accent-[#385e4b]" />
      {label}{key === "hideUnused" && value.hideUnused && hidden > 0 && <span className="text-faint">({hidden} hidden)</span>}
    </label>
  ));
}
