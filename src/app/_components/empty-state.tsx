import type { ReactNode } from "react";
import Panel from "./panel";

const node = "absolute h-7 w-8 rounded-[7px] border";

export default function EmptyState({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <Panel className="grid min-h-[420px] place-items-center px-6 py-10 max-[540px]:min-h-[340px]">
      <div className="max-w-[360px] text-center">
        <div aria-hidden="true" className="relative mx-auto h-[78px] w-[108px]">
          <span className="absolute inset-x-6 inset-y-4 rounded-xl border border-[#d3d6d5]" />
          <span className={`${node} top-0 left-2 border-[#d8dcda] bg-[#f2f3f2]`} />
          <span className={`${node} top-6 right-[3px] border-[#cde5d9] bg-[#e6f3ed]`} />
          <span className={`${node} bottom-0 left-[22px] border-[#d8dcda] bg-[#f2f3f2]`} />
        </div>
        <h2 className="mt-5 mb-2.5 text-xl leading-[normal] font-medium tracking-[-0.03em]">{title}</h2>
        <p className="text-[13px] leading-[1.8] text-muted [overflow-wrap:anywhere]">{children}</p>
        {badge && <span className="mt-[22px] inline-block rounded-md border border-line bg-[#f5f5f5] px-[9px] py-[5px] text-[11px] text-muted">{badge}</span>}
      </div>
    </Panel>
  );
}
