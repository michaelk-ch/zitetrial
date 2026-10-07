"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { importWorkspaceAction } from "./import-action";

export default function ImportDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const queryClient = useQueryClient();

  // onSubmit rather than a form action: React resets action forms, losing the paste on errors.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setError(undefined);
    startTransition(async () => {
      const result = await importWorkspaceAction(formData);
      if ("error" in result) return setError(result.error);
      // A replaced workspace must be re-analyzed rather than served from the session cache.
      queryClient.removeQueries({ queryKey: ["system-model", result.workspace] });
      dialog.current?.close();
      form.reset();
      router.push(`/${encodeURIComponent(result.workspace)}`);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="mt-3 w-full rounded-lg px-2 py-2 text-left text-[13px] text-muted hover:bg-[#f0f0f0] hover:text-ink"
      >
        + Import
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="import-title"
        className="m-auto w-[min(640px,calc(100vw-32px))] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/30"
      >
        <form onSubmit={submit} className="flex flex-col gap-4 p-5">
          <div>
            <h2 id="import-title" className="text-base font-semibold tracking-[-0.02em]">Import workspace</h2>
            <p className="mt-1 text-xs text-muted">
              Paste the repository files API response. The workspace is named after <code>project.name</code> in <code>zite.config.json</code> and
              stored in <code>userdata/&lt;workspace&gt;/&lt;headSha&gt;</code>.
            </p>
          </div>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Response JSON
            <textarea
              name="json"
              required
              rows={12}
              spellCheck={false}
              placeholder={'{ "files": [{ "path": "…", "content": "…" }], "headSha": "…" }'}
              className="w-full resize-y rounded-lg border border-line-strong bg-white px-2.5 py-2 font-mono text-xs"
            />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="replace" /> Replace the workspace if it already exists
          </label>
          {error && <p role="alert" className="text-[13px] whitespace-pre-wrap text-[#b42318] [overflow-wrap:anywhere]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg px-3 py-2 text-[13px] hover:bg-fill">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="rounded-lg bg-ink px-3 py-2 text-[13px] text-white disabled:opacity-60">
              {pending ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
