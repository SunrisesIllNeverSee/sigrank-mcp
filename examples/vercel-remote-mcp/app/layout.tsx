import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "SigRank MCP on Vercel",
  description: "A project-owned Vercel endpoint relaying to the canonical SigRank remote MCP server.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0b0b", color: "#f1eee7", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        {children}
      </body>
    </html>
  );
}
