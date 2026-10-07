import { notFound } from "next/navigation";
import { analyzeRepository } from "@/analyzer";
import { checkoutPath, discoverWorkspaces } from "@/workspaces/discover";
import SystemViews from "../_components/system-views";

export default async function WorkspacePage({ params }: PageProps<"/[workspace]">) {
  const { workspace: id } = await params;
  const workspace = (await discoverWorkspaces()).find((candidate) => candidate.id === id);
  if (!workspace) notFound();
  // Revisions are sorted by discovery; use the first until revision selection exists.
  const model = await analyzeRepository(checkoutPath(workspace.id, workspace.revisions[0]));
  return <SystemViews model={model} />;
}
