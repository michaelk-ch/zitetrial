"use client";

import EmptyState from "../_components/empty-state";

export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <EmptyState
      title="Couldn’t analyze this workspace"
      footer={
        <button type="button" onClick={retry} className="cursor-pointer rounded-md border border-line-strong bg-white px-3 py-1.5 text-[13px] hover:bg-subtle">
          Try again
        </button>
      }
    >
      {error.message}
    </EmptyState>
  );
}
