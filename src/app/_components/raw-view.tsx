import type { SystemModel } from "@/system-model/schema";
import Panel from "./panel";

export default function RawView({ model }: { model: SystemModel }) {
  return (
    <Panel title="System model" meta={`${model.repository.name} · Schema v${model.schemaVersion}`}>
      <pre tabIndex={0} aria-label="System model JSON" className="max-h-[70vh] overflow-auto p-5 font-mono text-xs leading-6 text-[#444] focus-visible:-outline-offset-2">
        <code>{JSON.stringify(model, null, 2)}</code>
      </pre>
    </Panel>
  );
}
