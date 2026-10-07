import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zitetrial",
  description: "A new project built with Next.js and TypeScript.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
