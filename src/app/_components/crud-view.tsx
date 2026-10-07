import type { SystemModel } from "@/system-model/schema";
import { accessLabel, buildAccessMatrix } from "@/viewer/access-matrix";
import Panel from "./panel";

const cell = "border-r border-b text-center font-mono";

export default function CrudView({ model }: { model: SystemModel }) {
  const groups = buildAccessMatrix(model);
  const tables = [...model.tables].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (groups.length === 0 || tables.length === 0) {
    return <Panel className="p-8 text-sm text-muted">No {groups.length === 0 ? "apps" : "tables"} found in this workspace.</Panel>;
  }

  return (
    <Panel title="Table access" meta="R = read · W = write · ? = unknown · blank = no observed access">
      <div tabIndex={0} role="region" aria-label="CRUD access matrix" className="max-h-[70vh] overflow-auto bg-white focus-visible:-outline-offset-2">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Apps and their endpoints by database table. App rows aggregate access from all their endpoints.</caption>
          <thead>
            <tr className="bg-subtle">
              <th scope="col" className="sticky top-0 left-0 z-30 min-w-[250px] border-r border-b border-line bg-inherit px-4 py-3 text-left font-medium">App / Endpoint</th>
              {tables.map((table) => (
                <th key={table.id} scope="col" title={table.description ?? table.name} className="sticky top-0 z-20 max-w-[180px] min-w-[110px] border-r border-b border-line bg-inherit px-3 py-3 text-center font-medium">
                  {table.name}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(({ app, access, endpoints }) => (
            <tbody key={app.id}>
              <tr className="bg-[#f0f1f0]">
                <th scope="row" title={app.description ?? app.name} className="sticky left-0 z-10 border-r border-b border-[#e3e3e3] bg-inherit px-4 py-3 text-left font-semibold">
                  {app.name}<span className="ml-2 font-normal text-faint">({endpoints.length})</span>
                </th>
                {tables.map((table) => (
                  <td key={table.id} className={`${cell} border-[#e3e3e3] px-3 py-3 font-semibold text-[#385e4b]`}>{accessLabel(access.get(table.id))}</td>
                ))}
              </tr>
              {endpoints.map(({ endpoint, access }) => (
                <tr key={endpoint.id} className="bg-white hover:bg-subtle">
                  <th scope="row" title={endpoint.description ?? endpoint.name} className="sticky left-0 z-10 max-w-[320px] border-r border-b border-[#eeeeee] bg-inherit py-2.5 pr-4 pl-7 text-left font-normal [overflow-wrap:anywhere]">
                    <span aria-hidden="true" className="mr-2 text-faint">↳</span>{endpoint.name}
                  </th>
                  {tables.map((table) => (
                    <td key={table.id} className={`${cell} border-[#eeeeee] px-3 py-2.5 text-[#496b59]`}>{accessLabel(access.get(table.id))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Panel>
  );
}
