"use client";

import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import EmptyState from "../_components/empty-state";

export default function WorkspaceError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // Failed queries stay in the error state unless the boundary is reset before re-rendering.
  const { reset } = useQueryErrorResetBoundary();
  return (
    <EmptyState
      title="Couldn’t load this workspace"
      footer={
        <button
          type="button"
          onClick={() => { reset(); retry(); }}
          className="cursor-pointer rounded-md border border-line-strong bg-white px-3 py-1.5 text-[13px] hover:bg-subtle"
        >
          Try again
        </button>
      }
    >
      {error.message}
    </EmptyState>
  );
}
