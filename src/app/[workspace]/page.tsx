import { Suspense } from "react";
import { notFound } from "next/navigation";
import { discoverWorkspaces } from "@/workspaces/discover";
import Viewer from "../viewer";

async function WorkspaceViewer({ params }: PageProps<"/[workspace]">) {
  const { workspace: id } = await params;
  const workspaces = await discoverWorkspaces();
  const selected = workspaces.find((workspace) => workspace.id === id);
  if (!selected) notFound();
  return <Viewer workspaces={workspaces} selected={selected} />;
}

export default function WorkspacePage(props: PageProps<"/[workspace]">) {
  return <Suspense fallback={<p className="p-10 text-sm text-[#777]">Loading workspace…</p>}><WorkspaceViewer {...props} /></Suspense>;
}
