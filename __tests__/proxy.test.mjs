import assert from "node:assert";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseProxyPort,
  startProxy,
} from "../proxy.mjs";
import { proxyAdapter } from "../adapters/index.mjs";
import { tokenpull } from "../adapters/tokenpull.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request({ port, path, body, headers = {}, onFirstData }) {
  return new Promise((resolve, reject) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": rawBody.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let first = true;
        res.on("data", (chunk) => {
          if (first) {
            first = false;
            onFirstData?.();
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(rawBody);
  });
}

export async function runProxyTests() {
  const tempRoot = await mkdtemp(join(tmpdir(), "sigrank-proxy-test-"));
  const logPath = join(tempRoot, "state", "proxy-sessions.jsonl");
  const seenRequests = [];
  const logs = [];
  const warnings = [];
  let anthropicUpstreamFinished = false;

  const anthropicSse = [
    "event: message_start\n",
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 1234,
          output_tokens: 1,
          cache_read_input_tokens: 8901,
          cache_creation_input_tokens: 2345,
        },
      },
    })}\n\n`,
    "event: message_delta\r\n",
    `data: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 567 },
    })}\r\n\r\n`,
    "event: message_stop\n",
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");

  const openAiSse = [
    `data: ${JSON.stringify({
      id: "chatcmpl_test",
      model: "gpt-4.1",
      choices: [],
      usage: null,
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl_test",
      model: "gpt-4.1",
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const responsesSse = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { model: "gpt-5", usage: null },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "gpt-5",
        usage: {
          input_tokens: 80,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 60 },
        },
      },
    })}\n\n`,
  ].join("");

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    seenRequests.push({ url: req.url, headers: req.headers, rawBody });

    if (req.url === "/v1/messages?case=error") {
      const body = '{"error":{"type":"rate_limit_error"}}';
      res.writeHead(429, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "retry-after": "7",
        "x-upstream-error": "unchanged",
      });
      res.end(body);
      return;
    }

    if (req.url === "/v1/messages?case=stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-upstream-stream": "anthropic",
      });
      // Deliberately split inside an SSE JSON object. The first fragment is
      // incomplete but must still reach the coding tool immediately.
      res.write(anthropicSse.slice(0, 37));
      await delay(30);
      res.write(anthropicSse.slice(37, 113));
      res.end(anthropicSse.slice(113));
      anthropicUpstreamFinished = true;
      return;
    }

    if (req.url === "/v1/chat/completions?case=json") {
      const body = JSON.stringify({
        id: "chatcmpl_json",
        model: "gpt-4.1-mini",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 70 },
        },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (req.url === "/v1/chat/completions?case=stream") {
      const parsed = JSON.parse(rawBody);
      assert.strictEqual(
        parsed.stream_options?.include_usage,
        true,
        "proxy injects OpenAI streaming usage request",
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(openAiSse.slice(0, 51));
      res.end(openAiSse.slice(51));
      return;
    }

    if (req.url === "/v1/responses?case=stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(responsesSse);
      return;
    }

    res.writeHead(404);
    res.end("missing");
  });

  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    proxy = await startProxy({
      port: 0,
      logPath,
      upstreams: {
        anthropic: `http://127.0.0.1:${upstreamPort}`,
        openai: `http://127.0.0.1:${upstreamPort}`,
      },
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
    });

    let firstAnthropicChunkWasLive = false;
    const anthropic = await request({
      port: proxy.port,
      path: "/v1/messages?case=stream",
      body: { model: "claude-sonnet-4-20250514", stream: true },
      headers: {
        "x-api-key": "test-anthropic-key",
        "anthropic-version": "2023-06-01",
      },
      onFirstData: () => {
        firstAnthropicChunkWasLive = !anthropicUpstreamFinished;
      },
    });
    assert.strictEqual(anthropic.status, 200, "Anthropic SSE status forwarded");
    assert.strictEqual(anthropic.body, anthropicSse, "Anthropic SSE bytes forwarded");
    assert.strictEqual(
      anthropic.headers["x-upstream-stream"],
      "anthropic",
      "Anthropic upstream headers forwarded",
    );
    assert.ok(firstAnthropicChunkWasLive, "SSE reaches client before upstream completes");

    const openAiJson = await request({
      port: proxy.port,
      path: "/v1/chat/completions?case=json",
      body: { model: "gpt-4.1-mini", stream: false },
      headers: { authorization: "Bearer test-openai-key" },
    });
    assert.strictEqual(openAiJson.status, 200, "OpenAI JSON status forwarded");
    assert.deepStrictEqual(JSON.parse(openAiJson.body).usage, {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 70 },
    });

    const openAiStream = await request({
      port: proxy.port,
      path: "/v1/chat/completions?case=stream",
      body: { model: "gpt-4.1", stream: true },
      headers: { authorization: "Bearer test-openai-key" },
    });
    assert.strictEqual(openAiStream.body, openAiSse, "OpenAI SSE bytes forwarded");

    const responses = await request({
      port: proxy.port,
      path: "/v1/responses?case=stream",
      body: { model: "gpt-5", stream: true },
      headers: { authorization: "Bearer test-openai-key" },
    });
    assert.strictEqual(responses.body, responsesSse, "Responses SSE bytes forwarded");

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        request({
          port: proxy.port,
          path: "/v1/chat/completions?case=json",
          body: { model: "gpt-4.1-mini", stream: false },
          headers: { authorization: "Bearer test-openai-key" },
        }),
      ),
    );
    assert.ok(
      concurrent.every((response) => response.status === 200),
      "concurrent provider responses pass through",
    );

    const errorBody = '{"error":{"type":"rate_limit_error"}}';
    const error = await request({
      port: proxy.port,
      path: "/v1/messages?case=error",
      body: { model: "claude-sonnet-4-20250514" },
      headers: { "x-api-key": "test-anthropic-key" },
    });
    assert.strictEqual(error.status, 429, "upstream error status forwarded");
    assert.strictEqual(error.body, errorBody, "upstream error body forwarded unchanged");
    assert.strictEqual(error.headers["retry-after"], "7", "retry header forwarded");
    assert.strictEqual(
      error.headers["x-upstream-error"],
      "unchanged",
      "custom error header forwarded",
    );

    await proxy.close();
    proxy = null;

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.strictEqual(records.length, 12, "every successful response with usage is logged");
    assert.strictEqual(
      new Set(records.map((record) => record.ts)).size,
      records.length,
      "concurrent calls receive unique timestamps and cannot deduplicate each other",
    );

    const anthropicUsage = records.find((r) => r.backend === "anthropic");
    assert.deepStrictEqual(
      {
        model: anthropicUsage.model,
        input: anthropicUsage.input,
        output: anthropicUsage.output,
        cacheRead: anthropicUsage.cacheRead,
        cacheCreate: anthropicUsage.cacheCreate,
      },
      {
        model: "claude-sonnet-4-20250514",
        input: 1234,
        output: 567,
        cacheRead: 8901,
        cacheCreate: 2345,
      },
      "Anthropic start/delta usage is merged without summing cumulative fields",
    );

    const openAiJsonUsage = records.find((r) => r.model === "gpt-4.1-mini");
    assert.deepStrictEqual(
      {
        input: openAiJsonUsage.input,
        output: openAiJsonUsage.output,
        cacheRead: openAiJsonUsage.cacheRead,
        cacheCreate: openAiJsonUsage.cacheCreate,
      },
      { input: 30, output: 20, cacheRead: 70, cacheCreate: 0 },
      "OpenAI cached input is separated from fresh input",
    );

    const openAiStreamUsage = records.find((r) => r.model === "gpt-4.1");
    assert.deepStrictEqual(
      {
        input: openAiStreamUsage.input,
        output: openAiStreamUsage.output,
        cacheRead: openAiStreamUsage.cacheRead,
        cacheCreate: openAiStreamUsage.cacheCreate,
      },
      { input: 10, output: 9, cacheRead: 40, cacheCreate: 0 },
      "OpenAI streaming final usage is captured",
    );

    const responsesUsage = records.find((r) => r.model === "gpt-5");
    assert.deepStrictEqual(
      {
        input: responsesUsage.input,
        output: responsesUsage.output,
        cacheRead: responsesUsage.cacheRead,
        cacheCreate: responsesUsage.cacheCreate,
      },
      { input: 20, output: 12, cacheRead: 60, cacheCreate: 0 },
      "OpenAI Responses streaming usage is captured",
    );

    const directoryMode = (await stat(join(tempRoot, "state"))).mode & 0o777;
    const fileMode = (await stat(logPath)).mode & 0o777;
    assert.strictEqual(directoryMode, 0o700, "proxy data directory mode is 0700");
    assert.strictEqual(fileMode, 0o600, "proxy usage log mode is 0600");

    const anthRequest = seenRequests.find((r) => r.url.includes("case=stream") && r.url.startsWith("/v1/messages"));
    assert.strictEqual(anthRequest.headers["x-api-key"], "test-anthropic-key");
    assert.strictEqual(anthRequest.headers["anthropic-version"], "2023-06-01");
    assert.ok(
      seenRequests.some((r) => r.headers.authorization === "Bearer test-openai-key"),
      "OpenAI authorization header forwarded",
    );
    assert.ok(logs.some((line) => line.includes("cacheCreate=2345")));
    assert.deepStrictEqual(warnings, [], "valid traffic emits no warnings");

    assert.strictEqual(parseProxyPort("8787"), 8787);
    assert.throws(() => parseProxyPort("0"), /Invalid proxy port/);
    assert.throws(() => parseProxyPort("70000"), /Invalid proxy port/);

    // Adapter: malformed records are ignored; identical timestamps keep the
    // last call exactly as requested by the proxy session format contract.
    const adapterPath = join(tempRoot, "adapter.jsonl");
    await writeFile(
      adapterPath,
      [
        JSON.stringify({
          ts: "2026-08-08T17:00:00.000Z",
          backend: "anthropic",
          model: "old",
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheCreate: 4,
        }),
        "not-json",
        JSON.stringify({
          ts: "2026-08-08T17:00:00.000Z",
          backend: "anthropic",
          model: "replacement",
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheCreate: 40,
        }),
        JSON.stringify({
          ts: "2026-08-08T17:01:00.000Z",
          backend: "openai",
          model: "gpt-5",
          input: 5,
          output: 6,
          cacheRead: 7,
          cacheCreate: 0,
        }),
        JSON.stringify({
          ts: "2026-08-08T17:02:00.000Z",
          input: -1,
          output: 1,
          cacheRead: 0,
          cacheCreate: 0,
        }),
      ].join("\n") + "\n",
    );
    const pulled = await tokenpull({
      adapter: proxyAdapter,
      root: adapterPath,
      now: "2026-08-08T18:00:00.000Z",
    });
    const all = pulled.windows.find((window) => window.window === "all");
    assert.strictEqual(pulled.platform, "proxy");
    assert.strictEqual(pulled.totalMessages, 2, "proxy adapter deduplicates by timestamp");
    assert.deepStrictEqual(all.pillars, {
      input: 15,
      output: 26,
      cacheCreate: 40,
      cacheRead: 37,
    });

    console.log(
      "✓ proxy: Anthropic/OpenAI/Responses JSON+SSE · live pass-through · 429 unchanged · secure JSONL · adapter dedup",
    );
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    if (upstream.listening) await closeServer(upstream).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// ─── Regression: absolute-form request target must not escape upstream ───
// An attacker could send "POST http://attacker.example/v1/messages" as the
// request target. Before the fix, new URL(req.url, upstreamBase) would parse
// the absolute URL and forward credentials to the attacker's host. After the
// fix, the proxy constructs the URL from pathname+search only, ignoring any
// host in the request target. Credentials go to the configured upstream.
{
  let proxy;
  let configuredUpstreamHit = false;
  const configuredUpstream = http.createServer((req, res) => {
    configuredUpstreamHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const upstreamPort = await listen(configuredUpstream);
    proxy = await startProxy({
      port: 0,
      upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}`, openai: "https://api.openai.com" },
      logPath: join(await mkdtemp(join(tmpdir(), "sigrank-proxy-")), "sessions.jsonl"),
    });

    // Send a raw HTTP request with an absolute-form target pointing at a
    // different host. fetch() can't do this — it always uses origin-form.
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "POST",
          path: "http://attacker.example/v1/messages",
          headers: {
            "content-type": "application/json",
            "x-api-key": "sk-ant-leaked",
            host: "attacker.example",
          },
        },
        (upstreamRes) => {
          const chunks = [];
          upstreamRes.on("data", (c) => chunks.push(c));
          upstreamRes.on("end", () =>
            resolve({ status: upstreamRes.statusCode, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "claude-3", messages: [] }));
    });

    // The request should reach the CONFIGURED upstream (loopback), proving
    // the absolute-form host was ignored. Credentials were NOT sent to
    // attacker.example — they went to the configured upstream only.
    assert.strictEqual(
      configuredUpstreamHit,
      true,
      "proxy must forward to the configured upstream, not the absolute-form host",
    );

    console.log("✓ proxy: absolute-form request target ignored, credentials sent to configured upstream only");
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    if (configuredUpstream.listening) await closeServer(configuredUpstream).catch(() => {});
  }
}
