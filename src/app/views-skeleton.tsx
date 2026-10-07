export default function ViewsSkeleton() {
  return (
    <div role="status" aria-label="Analyzing workspace" aria-busy="true">
      <span className="sr-only">Analyzing workspace…</span>
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex h-9 gap-2 rounded-lg border border-[#e8e8e8] bg-[#fafafa] p-1">
            <div className="w-20 rounded-md bg-[#e8e8e8]" />
            <div className="w-12 rounded-md bg-[#efefef]" />
            <div className="w-14 rounded-md bg-[#efefef]" />
          </div>
          <div className="h-6 w-28 rounded-md bg-[#efefef]" />
        </div>
        <div className="min-h-[420px] rounded-xl border border-[#e8e8e8] bg-[#fcfcfc] p-6 max-[540px]:min-h-[340px]">
          <div className="mb-8 h-4 w-32 rounded bg-[#e8e8e8]" />
          <div className="space-y-4">
            {["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/5", "w-2/5"].map((width, index) => (
              <div key={index} className={`h-3 rounded bg-[#efefef] ${width}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
