import { Suspense } from "react";
import { redirect } from "next/navigation";
import { discoverWorkspaces } from "@/workspaces/discover";
import EmptyState from "./_components/empty-state";
import { SystemViewsSkeleton } from "./_components/system-views";

async function FirstWorkspace() {
  const [first] = await discoverWorkspaces();
  if (first) redirect(`/${encodeURIComponent(first.id)}`);
  return (
    <EmptyState title="No workspaces yet">
      Add a repository checkout to <code>userdata/&lt;workspace&gt;/&lt;sha&gt;</code>, then refresh to see it here.
    </EmptyState>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<SystemViewsSkeleton />}>
      <FirstWorkspace />
    </Suspense>
  );
}
