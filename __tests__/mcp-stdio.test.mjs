/**
 * __tests__/mcp-stdio.test.mjs — MCP stdio behavior characterization freeze.
 *
 * Spawns `node index.mjs` as a real MCP stdio server (hand-rolled JSON-RPC
 * client — deliberately SDK-agnostic so it survives the v1→v2 migration)
 * and locks the observable contract from the Phase-2A handoff:
 *
 *   initialize          serverInfo {name:sigrank, version:pkg}, capabilities
 *   tools/list          25 tools, each name+description+inputSchema
 *   tools/call          get_sigrank_standard_record → canonical record
 *   unknown tool        JSON-RPC -32602 protocol error (NOT isError)
 *   tool failure        successful response with isError:true + text content
 *   prompts/list        check-my-efficiency / simulate-improvement /
 *                       compare-with-leader
 *   prompts/get         named prompt returns messages; arg substitution works
 *   unknown prompt      JSON-RPC -32602
 *   resources/list      5 sigrank:// URIs
 *   resources/read      markdown text per URI
 *   unknown resource    JSON-RPC -32602
 *   stdout purity       every stdout line parses as JSON-RPC 2.0
 *   routing             no-args+piped → MCP; SIGRANK_MCP_SERVER=1 → MCP;
 *                       any-arg → CLI (stdout is NOT JSON-RPC)
 *   clean exit          server exits on stdin EOF
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENTRY = join(ROOT, "index.mjs");
const PKG_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).version;

const EXPECTED_TOOLS = 25;
const EXPECTED_PROMPTS = [
  "check-my-efficiency",
  "simulate-improvement",
  "compare-with-leader",
];
const EXPECTED_RESOURCES = [
  "sigrank://scoring-formula",
  "sigrank://class-tiers",
  "sigrank://install-guide",
  "sigrank://privacy-model",
  "sigrank://data-policy",
];

// ─── SDK-agnostic JSON-RPC client over stdio ────────────────────────────────

class McpClient {
  constructor(env = {}) {
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutChunks = [];
    this.proc = spawn("node", [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.proc.stdout.on("data", (d) => {
      this.stdoutChunks.push(d);
      this.buffer += d.toString();
      this.drain();
    });
    this.proc.stderr.on("data", () => {}); // diagnostics channel — ignore
    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`server exited (${code}) with requests pending`));
      }
      this.pending.clear();
    });
  }

  drain() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray stdout — counted separately by the purity check
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(msg.error) : resolve(msg.result);
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15000);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  rawStdout() {
    return Buffer.concat(this.stdoutChunks).toString();
  }

  stop() {
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }
}

async function handshake(client, protocolVersion = "2025-06-18") {
  const init = await client.send("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "char-test", version: "0.0.0" },
  });
  client.notify("notifications/initialized");
  return init;
}

// ─── Contract assertions ────────────────────────────────────────────────────

test("stdio server starts, initializes, and advertises capabilities", async () => {
  const client = new McpClient();
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(client.proc.killed, false, "server stays alive awaiting MCP");
    const init = await handshake(client);
    assert.equal(init.serverInfo?.name, "sigrank");
    assert.equal(init.serverInfo?.version, PKG_VERSION);
    assert.equal(typeof init.protocolVersion, "string");
    assert.ok(init.capabilities?.tools !== undefined, "tools capability");
    assert.ok(init.capabilities?.prompts !== undefined, "prompts capability");
    assert.ok(init.capabilities?.resources !== undefined, "resources capability");
  } finally {
    client.stop();
  }
});

test("tools/list returns the full tool table with schemas", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    const { tools } = await client.send("tools/list", {});
    assert.equal(tools.length, EXPECTED_TOOLS);
    assert.ok(tools.some((t) => t.name === "get_sigrank_standard_record"));
    assert.ok(tools.some((t) => t.name === "simulate_change"));
    for (const t of tools) {
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.description, "string");
      assert.equal(typeof t.inputSchema, "object", `${t.name} inputSchema`);
    }
  } finally {
    client.stop();
  }
});

test("tools/call get_sigrank_standard_record returns canonical record", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    const res = await client.send("tools/call", {
      name: "get_sigrank_standard_record",
      arguments: {
        input: 1251211,
        output: 11296121,
        cache_write: 128196310,
        cache_read: 2555179769,
        provider: "test",
        model: "test-model",
        tool: "test-tool",
      },
    });
    assert.notEqual(res.isError, true);
    const record = JSON.parse(res.content[0].text);
    assert.equal(record.spec, "sigrank/0.1-draft");
    assert.equal(record.spec_status, "legacy_alias");
    assert.equal(record.protocol.name, "TTEOP");
    assert.equal(record.protocol.authority, "tteop-spec@0.1.5-draft");
    assert.equal(record.metrics.yield, 18436.98);
    assert.equal(record.metrics.leverage, 2042.2);
  } finally {
    client.stop();
  }
});

test("unknown tool is a protocol error, not an isError result", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    await assert.rejects(
      client.send("tools/call", { name: "nonexistent_tool_xyz", arguments: {} }),
      (err) => {
        assert.equal(err.code, -32602, "InvalidParams code");
        assert.match(String(err.message), /nonexistent_tool_xyz/);
        return true;
      },
    );
  } finally {
    client.stop();
  }
});

test("tool execution failure is an isError result, not a protocol error", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    // simulate_change with empty changes throws inside the tool
    const res = await client.send("tools/call", {
      name: "simulate_change",
      arguments: { changes: {} },
    });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].type, "text");
    assert.match(res.content[0].text, /^Error:/);
  } finally {
    client.stop();
  }
});

test("prompts/list returns the three named prompts", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    const { prompts } = await client.send("prompts/list", {});
    assert.deepEqual(
      prompts.map((p) => p.name).sort(),
      EXPECTED_PROMPTS.slice().sort(),
    );
    const sim = prompts.find((p) => p.name === "simulate-improvement");
    assert.equal(sim.arguments[0].name, "change");
    assert.equal(sim.arguments[0].required, true);
  } finally {
    client.stop();
  }
});

test("prompts/get returns messages and substitutes arguments", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    const base = await client.send("prompts/get", {
      name: "check-my-efficiency",
    });
    assert.equal(base.messages[0].role, "user");
    assert.equal(base.messages[0].content.type, "text");
    assert.ok(base.messages[0].content.text.length > 0);

    const sim = await client.send("prompts/get", {
      name: "simulate-improvement",
      arguments: { change: "reduce input by 999" },
    });
    assert.match(sim.messages[0].content.text, /reduce input by 999/);
    assert.doesNotMatch(sim.messages[0].content.text, /\{\{change\}\}/);
  } finally {
    client.stop();
  }
});

test("unknown prompt is a protocol error", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    await assert.rejects(
      client.send("prompts/get", { name: "no-such-prompt" }),
      (err) => {
        assert.equal(err.code, -32602);
        return true;
      },
    );
  } finally {
    client.stop();
  }
});

test("resources/list returns the five sigrank:// URIs", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    const { resources } = await client.send("resources/list", {});
    assert.deepEqual(
      resources.map((r) => r.uri).sort(),
      EXPECTED_RESOURCES.slice().sort(),
    );
    for (const r of resources) {
      assert.equal(r.mimeType, "text/markdown");
      assert.equal(typeof r.name, "string");
      assert.equal(typeof r.description, "string");
    }
  } finally {
    client.stop();
  }
});

test("resources/read returns markdown for every URI", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    for (const uri of EXPECTED_RESOURCES) {
      const res = await client.send("resources/read", { uri });
      assert.equal(res.contents[0].uri, uri);
      assert.equal(res.contents[0].mimeType, "text/markdown");
      assert.ok(res.contents[0].text.length > 100, `${uri} has content`);
    }
  } finally {
    client.stop();
  }
});

test("unknown resource is a protocol error", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    await assert.rejects(
      client.send("resources/read", { uri: "sigrank://nope" }),
      (err) => {
        assert.equal(err.code, -32602);
        return true;
      },
    );
  } finally {
    client.stop();
  }
});

test("stdout carries only JSON-RPC 2.0 messages (protocol purity)", async () => {
  const client = new McpClient();
  try {
    await handshake(client);
    await client.send("tools/list", {});
    await client.send("resources/list", {});
    const lines = client
      .rawStdout()
      .split("\n")
      .filter((l) => l.trim());
    assert.ok(lines.length > 0, "protocol traffic exists");
    for (const line of lines) {
      const msg = JSON.parse(line); // throws → fail
      assert.equal(msg.jsonrpc, "2.0", `non-protocol stdout line: ${line.slice(0, 80)}`);
    }
  } finally {
    client.stop();
  }
});

test("SIGRANK_MCP_SERVER=1 forces stdio server mode", async () => {
  const client = new McpClient({ SIGRANK_MCP_SERVER: "1" });
  try {
    const init = await handshake(client);
    assert.equal(init.serverInfo?.name, "sigrank");
  } finally {
    client.stop();
  }
});

test("CLI routing: any argument routes to the CLI, not the MCP server", async () => {
  const out = await new Promise((resolve, reject) => {
    const p = spawn("node", [ENTRY, "--help"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SIGRANK_MCP_SERVER: "1" }, // args still win
    });
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("exit", () => resolve(Buffer.concat(chunks).toString()));
    p.on("error", reject);
    setTimeout(() => { p.kill(); reject(new Error("CLI help hung")); }, 15000);
  });
  assert.ok(out.length > 0, "CLI produced output");
  // MCP responses are single-line JSON-RPC; CLI help is human text.
  assert.equal(JSON.stringify({ x: 1 }).charAt(0), "{");
  const firstLine = out.split("\n").find((l) => l.trim());
  assert.throws(() => {
    const m = JSON.parse(firstLine);
    assert.equal(m.jsonrpc, "2.0");
  }, "first stdout line must not be JSON-RPC");
});

test("server exits cleanly on stdin EOF", async () => {
  const client = new McpClient();
  await handshake(client);
  const exitCode = await new Promise((resolve) => {
    client.proc.on("exit", (code) => resolve(code));
    client.proc.stdin.end();
    setTimeout(() => { client.stop(); resolve("timeout"); }, 5000);
  });
  assert.notEqual(exitCode, "timeout", "server did not exit on stdin EOF");
});
