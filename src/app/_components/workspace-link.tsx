"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export default function WorkspaceLink({ id }: { id: string }) {
  const current = useParams<{ workspace?: string }>().workspace === id;
  return (
    <Link
      href={`/${encodeURIComponent(id)}`}
      aria-current={current ? "page" : undefined}
      className={`flex items-center gap-2 rounded-lg px-1.5 py-2 text-[13px] leading-[18px] [overflow-wrap:anywhere] hover:bg-[#f0f0f0] ${current ? "bg-fill" : ""}`}
    >
      <span aria-hidden="true" className="grid size-[19px] shrink-0 place-items-center rounded-[5px] border border-[#d6d9dd] bg-[#f0f1f3] text-[10px] text-[#667085]">
        {id.charAt(0).toUpperCase()}
      </span>
      {id}
    </Link>
  );
}
