import { Suspense } from "react";
import path from "node:path";
import { notFound } from "next/navigation";
import { discoverWorkspaces, type Workspace } from "@/workspaces/discover";
import { analyzeRepository } from "@/analyzer";
import Viewer, { WorkspacePlaceholder } from "../viewer";
import WorkspaceViews from "../workspace-views";
import ViewsSkeleton from "../views-skeleton";

async function AnalyzedViews({ workspace }: { workspace: Workspace }) {
  // Revisions are sorted by discovery; use the first until revision selection exists.
  const checkout = path.join(process.cwd(), "userdata", workspace.id, workspace.revisions[0]);
  const model = await analyzeRepository(checkout);
  return <WorkspaceViews model={model}><WorkspacePlaceholder selected={workspace} /></WorkspaceViews>;
}

async function WorkspaceViewer({ params }: PageProps<"/[workspace]">) {
  const { workspace: id } = await params;
  const workspaces = await discoverWorkspaces();
  const selected = workspaces.find((workspace) => workspace.id === id);
  if (!selected) notFound();
  return (
    <Viewer workspaces={workspaces} selected={selected}>
      <Suspense key={selected.id} fallback={<ViewsSkeleton />}>
        <AnalyzedViews workspace={selected} />
      </Suspense>
    </Viewer>
  );
}

export default function WorkspacePage(props: PageProps<"/[workspace]">) {
  return (
    <Suspense fallback={<Viewer workspaces={[]} loadingWorkspaces><ViewsSkeleton /></Viewer>}>
      <WorkspaceViewer {...props} />
    </Suspense>
  );
}
