"use client";

import { accessModes, type AccessMode } from "@/system-snapshot/inference/preprocess";

/** Access preprocessing mode shared by the table and graph views. */
export default function AccessModeSelect({ value, onChange, hidden = 0 }: { value: AccessMode; onChange: (value: AccessMode) => void; hidden?: number }) {
  const { description, hideUnused } = accessModes[value];
  return (
    <label title={description} className="inline-flex items-center gap-1.5 text-xs text-muted">
      Show
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as AccessMode)}
        className="h-8 cursor-pointer rounded-md border border-line-strong bg-white px-2 text-xs text-ink"
      >
        {Object.entries(accessModes).map(([mode, { label, description }]) => <option key={mode} value={mode} title={description}>{label}</option>)}
      </select>
      {hideUnused && hidden > 0 && <span className="text-faint">({hidden} hidden)</span>}
    </label>
  );
}
