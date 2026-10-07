import Link from "next/link";
import type { Workspace } from "@/workspaces/discover";

export default function Viewer({ workspaces, selected }: {
  workspaces: Workspace[];
  selected?: Workspace;
}) {
  return (
    <div className="grid min-h-screen grid-cols-[252px_minmax(0,1fr)] max-[760px]:grid-cols-[200px_minmax(0,1fr)] max-[540px]:grid-cols-[minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-screen flex-col border-r border-[#e9e9e9] bg-[#fafafa] px-3.5 py-5 max-[760px]:px-2.5 max-[540px]:static max-[540px]:h-auto max-[540px]:border-r-0 max-[540px]:border-b max-[540px]:p-4">
        <nav aria-label="Workspaces">
          <h2 className="mb-2.5 flex items-center justify-between px-2 text-xs leading-[normal] font-medium text-[#707070]">Workspaces <span className="text-[11px] text-[#929292]">{workspaces.length}</span></h2>
          <ul className="flex list-none flex-col gap-1">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/${encodeURIComponent(workspace.id)}`}
                  className={`flex items-center gap-2 rounded-lg px-1.5 py-2 text-[13px] leading-[18px] [overflow-wrap:anywhere] hover:bg-[#f0f0f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8d766d] ${selected?.id === workspace.id ? "bg-[#ececec]" : ""}`}
                  aria-current={selected?.id === workspace.id ? "page" : undefined}
                >
                  <span className="grid size-[19px] shrink-0 place-items-center rounded-[5px] border border-[#d6d9dd] bg-[#f0f1f3] text-[10px] text-[#667085]" aria-hidden="true">{workspace.id.charAt(0).toUpperCase()}</span>
                  <span>{workspace.id}</span>
                </Link>
              </li>
            ))}
          </ul>
          {workspaces.length === 0 && <p className="p-2 text-xs text-[#777]">No workspaces available</p>}
        </nav>
      </aside>
      <main className="min-w-0 bg-[#eeeff0]">
        <div className="min-h-[calc(100vh-172px)] rounded-[18px] border border-r-0 border-b-0 border-[#dedede] bg-white px-10 py-11 max-[760px]:px-6 max-[760px]:py-7 max-[540px]:min-h-[500px] max-[540px]:px-5">
          <div className="mx-auto max-w-[780px]">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-base leading-[normal] font-semibold tracking-[-0.02em]">System overview</h2>
            </div>
            <section className="grid min-h-[420px] place-items-center rounded-xl border border-[#e8e8e8] bg-[#fcfcfc] px-6 py-10 shadow-[0_2px_3px_#00000004] max-[540px]:min-h-[340px]" aria-labelledby="placeholder-title">
              <div className="max-w-[360px] text-center">
                <div className="relative mx-auto h-[78px] w-[108px] before:absolute before:inset-x-6 before:inset-y-4 before:rounded-xl before:border before:border-[#d3d6d5] before:content-['']" aria-hidden="true"><span className="absolute top-0 left-2 h-7 w-8 rounded-[7px] border border-[#d8dcda] bg-[#f2f3f2]" /><span className="absolute top-6 right-[3px] h-7 w-8 rounded-[7px] border border-[#cde5d9] bg-[#e6f3ed]" /><span className="absolute bottom-0 left-[22px] h-7 w-8 rounded-[7px] border border-[#d8dcda] bg-[#f2f3f2]" /></div>
                <h3 className="mt-5 mb-2.5 text-xl leading-[normal] font-medium tracking-[-0.03em]" id="placeholder-title">{selected ? "Your system, at a glance" : "No workspaces yet"}</h3>
                <p className="text-[13px] leading-[1.8] text-[#777] [overflow-wrap:anywhere]">{selected
                  ? "Apps, tables, and integrations will come together here. Choose a workspace in the sidebar to explore a different system."
                  : "Add a repository checkout to userdata/<workspace>/<sha>, then refresh to see it here."}</p>
                {selected && <span className="mt-[22px] inline-block rounded-md border border-[#e8e8e8] bg-[#f5f5f5] px-[9px] py-[5px] text-[11px] text-[#777]">Visualization coming soon</span>}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
