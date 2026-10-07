import { notFound } from "next/navigation";
import { findWorkspace } from "@/workspaces/discover";
import WorkspaceViews from "../_components/workspace-views";

export default async function WorkspacePage({ params }: PageProps<"/[workspace]">) {
  const { workspace: id } = await params;
  if (!(await findWorkspace(id))) notFound();
  return <WorkspaceViews key={id} workspaceId={id} />;
}
