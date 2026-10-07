import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zite System Viewer",
  description: "Explore the apps, tables, and integrations in your Zite workspaces.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full max-w-screen overflow-x-hidden scheme-light">
      <body className="flex min-h-full max-w-screen flex-col overflow-x-hidden bg-white font-sans leading-[normal] text-[#202020] antialiased">{children}</body>
    </html>
  );
}
