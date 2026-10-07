import type { Metadata } from "next";
import { Suspense } from "react";
import Providers from "./_components/providers";
import { WorkspaceNav, WorkspaceNavSkeleton } from "./_components/workspace-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zite System Viewer",
  description: "Explore the apps, tables, and integrations in your Zite workspaces.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="scheme-light">
      <body className="bg-white font-sans leading-[normal] text-ink antialiased">
        <div className="flex min-h-screen max-[540px]:flex-col">
          <aside className="sticky top-0 h-screen w-[252px] shrink-0 overflow-y-auto border-r border-line bg-subtle px-3.5 py-5 max-[760px]:w-[200px] max-[760px]:px-2.5 max-[540px]:static max-[540px]:h-auto max-[540px]:w-auto max-[540px]:border-r-0 max-[540px]:border-b max-[540px]:p-4">
            <Suspense fallback={<WorkspaceNavSkeleton />}>
              <WorkspaceNav />
            </Suspense>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col bg-canvas">
            <div className="flex-1 rounded-tl-[18px] border-t border-l border-line-strong bg-white px-10 py-11 max-[760px]:px-6 max-[760px]:py-7 max-[540px]:rounded-none max-[540px]:border-0 max-[540px]:px-5">
              <div className="mx-auto max-w-[780px]">
                <h1 className="mb-4 text-base leading-[normal] font-semibold tracking-[-0.02em]">System overview</h1>
                <Providers>{children}</Providers>
              </div>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
