import type { SystemModel } from "@/system-model/schema";
import { accessLabel, buildAccessMatrix } from "@/viewer/access-matrix";

export default function CrudView({ model }: { model: SystemModel }) {
  const groups = buildAccessMatrix(model);
  const tables = [...model.tables].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (groups.length === 0 || tables.length === 0) {
    return <p className="rounded-xl border border-[#e8e8e8] bg-[#fcfcfc] p-8 text-sm text-[#777]">No {groups.length === 0 ? "apps" : "tables"} found in this workspace.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[#e8e8e8]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e8e8] bg-[#fcfcfc] px-5 py-3">
        <h3 className="text-sm font-medium">Table access</h3>
        <p className="text-xs text-[#777]">R = read · W = write · ? = unknown · blank = no observed access</p>
      </div>
      <div className="max-h-[70vh] overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#8d766d]" tabIndex={0} role="region" aria-label="CRUD access matrix">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Apps and their endpoints by database table. App rows aggregate access from all their endpoints.</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 left-0 z-30 min-w-[250px] border-r border-b border-[#e8e8e8] bg-[#fafafa] px-4 py-3 text-left font-medium">App / Endpoint</th>
              {tables.map((table) => <th key={table.id} scope="col" title={table.description ?? table.name} className="sticky top-0 z-20 min-w-[110px] max-w-[180px] border-r border-b border-[#e8e8e8] bg-[#fafafa] px-3 py-3 text-center font-medium">{table.name}</th>)}
            </tr>
          </thead>
          {groups.map(({ app, access, endpoints }) => (
            <tbody key={app.id}>
              <tr>
                <th scope="row" title={app.description ?? app.name} className="sticky left-0 z-10 border-r border-b border-[#e3e3e3] bg-[#f0f1f0] px-4 py-3 text-left font-semibold">
                  {app.name}<span className="ml-2 font-normal text-[#888]">({endpoints.length})</span>
                </th>
                {tables.map((table) => <td key={table.id} className="border-r border-b border-[#e3e3e3] bg-[#f0f1f0] px-3 py-3 text-center font-mono font-semibold text-[#385e4b]">{accessLabel(access.get(table.id))}</td>)}
              </tr>
              {endpoints.map(({ endpoint, access }) => (
                  <tr key={endpoint.id} className="group">
                    <th scope="row" title={endpoint.description ?? endpoint.name} className="sticky left-0 z-10 max-w-[320px] border-r border-b border-[#eeeeee] bg-white py-2.5 pr-4 pl-7 text-left font-normal [overflow-wrap:anywhere] group-hover:bg-[#fafafa]">
                      <span aria-hidden="true" className="mr-2 text-[#aaa]">↳</span>{endpoint.name}
                    </th>
                    {tables.map((table) => <td key={table.id} className="border-r border-b border-[#eeeeee] px-3 py-2.5 text-center font-mono text-[#496b59] group-hover:bg-[#fafafa]">{accessLabel(access.get(table.id))}</td>)}
                  </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
