import { NextRequest, NextResponse } from "next/server";

export const revalidate = 3600;

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const card = {
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: "2026-07-28",
    supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
    serverInfo: {
      name: "sigrank-vercel-relay",
      title: "SigRank MCP on Vercel",
      version: "1.0.0",
    },
    description:
      "Project-owned Vercel relay for the canonical SigRank SignalAF Streamable HTTP MCP server. Scoring and tool behavior remain canonical at signalaf.com/api/mcp.",
    transports: [
      {
        type: "streamable-http",
        endpoint: `${origin}/api/mcp`,
      },
    ],
    authentication: {
      required: false,
      documentation: "https://signalaf.com/auth.md",
    },
    install: "Deploy with Vercel from https://signalaf.com/vercel",
    docs: "https://signalaf.com/mcp",
    homepage: "https://signalaf.com/vercel",
  };

  return new NextResponse(JSON.stringify(card, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
