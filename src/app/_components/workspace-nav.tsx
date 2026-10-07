import { discoverWorkspaces } from "@/workspaces/discover";
import WorkspaceLink from "./workspace-link";

function NavHeading({ count }: { count?: number }) {
  return (
    <h2 className="mb-2.5 flex items-center justify-between px-2 text-xs leading-[normal] font-medium text-muted">
      Workspaces {count !== undefined && <span className="text-[11px] text-faint">{count}</span>}
    </h2>
  );
}

export async function WorkspaceNav() {
  const workspaces = await discoverWorkspaces();
  return (
    <nav aria-label="Workspaces">
      <NavHeading count={workspaces.length} />
      {workspaces.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {workspaces.map(({ id }) => <li key={id}><WorkspaceLink id={id} /></li>)}
        </ul>
      ) : (
        <p className="p-2 text-xs text-muted">No workspaces available</p>
      )}
    </nav>
  );
}

export function WorkspaceNavSkeleton() {
  return (
    <div role="status">
      <NavHeading />
      <span className="sr-only">Loading workspaces…</span>
      <div aria-hidden="true" className="space-y-3 px-2 motion-safe:animate-pulse">
        {["w-2/3", "w-full", "w-4/5"].map((width) => <div key={width} className={`h-7 rounded-md bg-fill ${width}`} />)}
      </div>
    </div>
  );
}
