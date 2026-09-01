/**
 * Local, opt-in API proxy for provider-reported token usage.
 *
 * The proxy is inert until `sigrank proxy` starts it. It binds to loopback,
 * forwards request/response bytes, and persists usage metadata only — never
 * prompts, API keys, response text, or tool calls.
 */

import http from "node:http";
import https from "node:https";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAMS = Object.freeze({
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
});

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function defaultProxyLogPath() {
  return join(homedir(), ".sigrank-mcp", "proxy-sessions.jsonl");
}

export function parseProxyPort(value, { allowZero = false } = {}) {
  const port = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < min || port > 65_535) {
    throw new Error(`Invalid proxy port "${value}" (expected ${min}-${65_535})`);
  }
  return port;
}

function routeFor(pathname) {
  if (pathname === "/v1/messages") {
    return { backend: "anthropic", endpoint: "messages" };
  }
  if (pathname === "/v1/chat/completions") {
    return { backend: "openai", endpoint: "chat-completions" };
  }
  if (pathname === "/v1/responses") {
    return { backend: "openai", endpoint: "responses" };
  }
  return null;
}

function finiteTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function usageFields(backend, usage) {
  if (!usage || typeof usage !== "object") return null;
  if (backend === "anthropic") {
    return {
      input: finiteTokenCount(usage.input_tokens),
      output: finiteTokenCount(usage.output_tokens),
      cacheRead: finiteTokenCount(usage.cache_read_input_tokens),
      cacheCreate: finiteTokenCount(usage.cache_creation_input_tokens),
    };
  }

  const totalInput = finiteTokenCount(
    usage.prompt_tokens ?? usage.input_tokens,
  );
  const cacheRead = finiteTokenCount(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens,
  );
  return {
    // OpenAI's prompt/input total includes cached tokens. SigRank's input pillar
    // is fresh input, so subtract the separately reported cache read amount.
    input: Math.max(0, totalInput - cacheRead),
    output: finiteTokenCount(
      usage.completion_tokens ?? usage.output_tokens,
    ),
    cacheRead,
    cacheCreate: 0,
  };
}

function mergeDefinedUsage(target, source) {
  if (!source || typeof source !== "object") return false;
  let found = false;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    if (source[key] != null) {
      target[key] = source[key];
      found = true;
    }
  }
  return found;
}

function createUsageTracker({ backend, endpoint, requestModel, warn }) {
  let model = requestModel || null;
  let usage = null;
  const anthropicUsage = {};

  function observe(payload) {
    if (!payload || typeof payload !== "object") return;

    if (backend === "anthropic") {
      model = payload.message?.model || payload.model || model;
      const next = payload.message?.usage || payload.usage;
      if (mergeDefinedUsage(anthropicUsage, next)) usage = anthropicUsage;
      return;
    }

    if (endpoint === "responses") {
      const response = payload.response || payload;
      model = response.model || model;
      if (response.usage && typeof response.usage === "object") {
        usage = response.usage;
      }
      return;
    }

    model = payload.model || model;
    if (payload.usage && typeof payload.usage === "object") {
      usage = payload.usage;
    }
  }

  function observeJson(text) {
    try {
      observe(JSON.parse(text));
    } catch (error) {
      warn(`[proxy] usage parse warning: ${error.message}`);
    }
  }

  function result() {
    const fields = usageFields(backend, usage);
    return fields ? { model: model || "unknown", ...fields } : null;
  }

  return { observe, observeJson, result };
}

/** Incremental SSE parser. Network chunks are not assumed to align with events. */
function createSseInspector(onData, warn) {
  const decoder = new TextDecoder();
  let buffer = "";

  function parseFrame(frame) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      onData(JSON.parse(data));
    } catch (error) {
      warn(`[proxy] SSE usage parse warning: ${error.message}`);
    }
  }

  function drain(final = false) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      parseFrame(frame);
    }
    if (final && buffer.trim()) {
      parseFrame(buffer);
      buffer = "";
    }
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(false);
    },
    end() {
      buffer += decoder.decode();
      drain(true);
    },
  };
}

function sanitizeRequestHeaders(headers, bodyLength) {
  const out = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete out[name];
  delete out.host;
  // Usage inspection operates on the raw response. Asking upstream for identity
  // encoding avoids buffering/decompressing streamed provider responses.
  out["accept-encoding"] = "identity";
  out["content-length"] = String(bodyLength);
  return out;
}

function sanitizeResponseHeaders(headers) {
  const out = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete out[name];
  return out;
}

function prepareRequestBody(route, rawBody, injectOpenAIUsage, warn) {
  let json = null;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { body: rawBody, json: null };
  }

  if (
    injectOpenAIUsage &&
    route.endpoint === "chat-completions" &&
    json?.stream === true
  ) {
    json.stream_options = {
      ...(json.stream_options || {}),
      include_usage: true,
    };
    try {
      return { body: Buffer.from(JSON.stringify(json)), json };
    } catch (error) {
      warn(`[proxy] request usage-option warning: ${error.message}`);
    }
  }
  return { body: rawBody, json };
}

function createUsageWriter(logPath, logger) {
  let queue = Promise.resolve();
  const directory = dirname(logPath);

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
  }

  function append(record) {
    queue = queue
      .then(async () => {
        await ensureDirectory();
        await appendFile(logPath, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(logPath, 0o600).catch(() => {});
      })
      .catch((error) => {
        logger.warn(`[proxy] usage log warning: ${error.message}`);
      });
    return queue;
  }

  return { ensureDirectory, append, flush: () => queue };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function formatUsage(fields) {
  return `input=${fields.input} output=${fields.output} cacheRead=${fields.cacheRead} cacheCreate=${fields.cacheCreate}`;
}

/**
 * Start the opt-in loopback proxy.
 *
 * Test hooks (`upstreams`, `logPath`, `port: 0`, and `logger`) keep tests local;
 * the CLI uses fixed provider origins and port 8787 by default.
 */
export async function startProxy({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  logPath = defaultProxyLogPath(),
  upstreams = DEFAULT_UPSTREAMS,
  injectOpenAIUsage = true,
  logger = console,
} = {}) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("SigRank proxy must bind to a loopback host");
  }
  port = parseProxyPort(port, { allowZero: true });
  const writer = createUsageWriter(logPath, logger);
  await writer.ensureDirectory();
  let lastCaptureMs = 0;
  const nextCaptureTimestamp = () => {
    // The adapter intentionally deduplicates by timestamp. Keep timestamps
    // monotonic so distinct responses completing within one millisecond cannot
    // collapse into one call.
    lastCaptureMs = Math.max(Date.now(), lastCaptureMs + 1);
    return new Date(lastCaptureMs).toISOString();
  };

  const server = http.createServer(async (req, res) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request URL\n");
      return;
    }

    const route = routeFor(parsedUrl.pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("SigRank proxy supports /v1/messages, /v1/chat/completions, and /v1/responses\n");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, {
        allow: "POST",
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("Method not allowed\n");
      return;
    }

    let rawBody;
    try {
      rawBody = await readRequestBody(req);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Could not read request body\n");
      logger.warn(`[proxy] request read warning: ${error.message}`);
      return;
    }

    const prepared = prepareRequestBody(
      route,
      rawBody,
      injectOpenAIUsage,
      logger.warn.bind(logger),
    );
    const upstreamBase = upstreams[route.backend];
    if (!upstreamBase) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`No upstream configured for ${route.backend}\n`);
      return;
    }

    const upstreamUrl = new URL(parsedUrl.pathname + parsedUrl.search, upstreamBase);
    // Defense-in-depth: verify the constructed URL origin matches the intended
    // upstream. This prevents an absolute-form request target (e.g.
    // "http://attacker.example/v1/messages") from overriding upstreamBase via
    // new URL(req.url, base) — which would forward credentials to an attacker.
    if (upstreamUrl.origin !== new URL(upstreamBase).origin) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Refused to proxy to unexpected origin\n");
      return;
    }
    const transport = upstreamUrl.protocol === "http:" ? http : https;
    const tracker = createUsageTracker({
      backend: route.backend,
      endpoint: route.endpoint,
      requestModel: prepared.json?.model,
      warn: logger.warn.bind(logger),
    });

    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: "POST",
        headers: sanitizeRequestHeaders(req.headers, prepared.body.length),
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        const headers = sanitizeResponseHeaders(upstreamRes.headers);
        res.writeHead(statusCode, headers);

        const contentType = String(upstreamRes.headers["content-type"] || "");
        const contentEncoding = String(
          upstreamRes.headers["content-encoding"] || "identity",
        );
        const inspect = statusCode >= 200 && statusCode < 300;
        const isSse = inspect && contentType.includes("text/event-stream");
        const canInspect = contentEncoding === "identity";
        const jsonChunks = [];
        const inspector =
          isSse && canInspect
            ? createSseInspector(tracker.observe, logger.warn.bind(logger))
            : null;

        upstreamRes.on("data", (chunk) => {
          // Forward first, inspect second: parsing never holds back streamed tokens.
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once("drain", () => upstreamRes.resume());
          }
          if (inspector) inspector.push(chunk);
          else if (inspect && canInspect) jsonChunks.push(Buffer.from(chunk));
        });

        upstreamRes.on("end", () => {
          if (inspector) inspector.end();
          else if (inspect && canInspect && jsonChunks.length) {
            tracker.observeJson(Buffer.concat(jsonChunks).toString("utf8"));
          }

          const fields = tracker.result();
          if (fields) {
            writer.append({
              ts: nextCaptureTimestamp(),
              backend: route.backend,
              model: fields.model,
              input: fields.input,
              output: fields.output,
              cacheRead: fields.cacheRead,
              cacheCreate: fields.cacheCreate,
            });
            logger.log(
              `[proxy] ${statusCode} POST ${parsedUrl.pathname} → ${route.backend} (${formatUsage(fields)})`,
            );
          } else {
            logger.log(
              `[proxy] ${statusCode} POST ${parsedUrl.pathname} → ${route.backend}`,
            );
          }
          res.end();
        });

        upstreamRes.on("error", (error) => {
          logger.warn(`[proxy] upstream response warning: ${error.message}`);
          if (!res.writableEnded) res.destroy(error);
        });
      },
    );

    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    upstreamReq.on("error", (error) => {
      logger.warn(`[proxy] upstream request warning: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("Upstream request failed\n");
      } else if (!res.writableEnded) {
        res.destroy(error);
      }
    });
    upstreamReq.end(prepared.body);
  });

  server.on("clientError", (error, socket) => {
    logger.warn(`[proxy] client warning: ${error.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const listeningPort = typeof address === "object" ? address.port : port;
  return {
    server,
    host,
    port: listeningPort,
    url: `http://${host}:${listeningPort}`,
    logPath,
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await writer.flush();
    },
  };
}
