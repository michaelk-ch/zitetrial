import type { SystemSnapshot } from "@/system-snapshot";
import Panel from "../panel";

export default function RawView({ snapshot }: { snapshot: SystemSnapshot }) {
  return (
    <Panel title="System snapshot" meta={snapshot.analysis.repository.name}>
      <pre tabIndex={0} aria-label="System snapshot JSON" className="max-h-[70vh] overflow-auto p-5 font-mono text-xs leading-6 text-[#444] focus-visible:-outline-offset-2">
        <code>{JSON.stringify(snapshot, null, 2)}</code>
      </pre>
    </Panel>
  );
}
