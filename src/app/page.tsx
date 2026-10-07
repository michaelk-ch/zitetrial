import { Suspense } from "react";
import { redirect } from "next/navigation";
import { discoverWorkspaces } from "@/workspaces/discover";
import Viewer from "./viewer";

async function WorkspaceIndex({ searchParams }: PageProps<"/">) {
  const { workspace: requested } = await searchParams;
  const workspaces = await discoverWorkspaces();
  const selected = workspaces.find((workspace) => workspace.id === requested) ?? workspaces[0];
  if (selected) redirect(`/${encodeURIComponent(selected.id)}`);
  return <Viewer workspaces={workspaces} />;
}

export default function Home(props: PageProps<"/">) {
  return <Suspense fallback={<p className="p-10 text-sm text-[#777]">Loading workspaces…</p>}><WorkspaceIndex {...props} /></Suspense>;
}
