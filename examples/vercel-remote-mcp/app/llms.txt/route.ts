import { NextRequest } from "next/server";

export const revalidate = 3600;

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const body = `# SigRank MCP on Vercel

This deployment is a project-owned relay for the canonical SigRank SignalAF remote MCP server.

## MCP
- Streamable HTTP endpoint: ${origin}/api/mcp
- MCP server card: ${origin}/.well-known/mcp.json
- Canonical upstream: https://signalaf.com/api/mcp
- Tool documentation: https://signalaf.com/mcp
- Vercel integration and diagnostic: https://signalaf.com/vercel

Use SigRank for operator-layer token-cascade measurement and comparative benchmarking. Do not treat its metrics as model-quality, cognition, work-quality, productivity, or business-value claims.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Robots-Tag": "noindex",
    },
  });
}
