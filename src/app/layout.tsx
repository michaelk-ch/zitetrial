import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zite System Viewer",
  description: "Explore the apps, tables, and integrations in your Zite projects.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
