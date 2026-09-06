import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANONICAL_MCP = "https://signalaf.com/api/mcp";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Auth guard — rejects unauthenticated requests before proxying to the
 * upstream MCP server. Set RELAY_API_KEY in your Vercel environment and
 * require clients to send it as the Authorization header.
 *
 * GET (initialize/list) is allowed without auth so discovery works.
 * POST/DELETE (mutating) require the relay key.
 */
function checkAuth(request: NextRequest): Response | null {
  if (request.method === "GET") return null; // read-only discovery
  const relayKey = process.env.RELAY_API_KEY;
  if (!relayKey) {
    return new Response(JSON.stringify({ error: "RELAY_API_KEY not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const auth = request.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== relayKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

async function proxy(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const outboundHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outboundHeaders.set(key, value);
  });
  outboundHeaders.set("x-sigrank-vercel-relay", "1");

  const upstream = await fetch(CANONICAL_MCP, {
    method: request.method,
    headers: outboundHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  responseHeaders.set("x-sigrank-upstream", "signalaf.com/api/mcp");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
