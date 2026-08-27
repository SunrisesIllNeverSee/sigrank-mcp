import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(tmpdir(), "sigrank-packed-"));

function runNode(script, args = []) {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function exerciseStdio(binPath) {
  const child = spawn(process.execPath, [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const pending = new Map();
  let stdout = "";
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "packed-artifact-smoke", version: "1.0.0" },
    });
    assert.equal(initialized.serverInfo.name, "sigrank");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await request(2, "tools/list");
    assert.ok(
      listed.tools.some((tool) => tool.name === "get_sigrank_standard_record"),
      "packed MCP tools/list must expose get_sigrank_standard_record",
    );

    const called = await request(3, "tools/call", {
      name: "get_sigrank_standard_record",
      arguments: {
        input: 1_251_211,
        output: 11_296_121,
        cache_write: 128_196_310,
        cache_read: 2_555_179_769,
        timestamp: "2026-08-27T00:00:00.000Z",
      },
    });
    assert.notEqual(called.isError, true);
    const record = JSON.parse(called.content[0].text);
    assert.equal(record.spec, "sigrank/0.1-draft");
    assert.equal(record.metrics.yield, 18436.98);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

try {
  const packJson = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", tempRoot],
    { cwd: ROOT, encoding: "utf8" },
  );
  const [packed] = JSON.parse(packJson);
  const names = packed.files.map((file) => file.path);
  assert.ok(names.includes("omp-cache.mjs"), "omp-cache.mjs must ship");
  assert.ok(names.includes("connect.mjs"), "connect.mjs must ship");
  assert.ok(
    names.every((name) => !/(^|\/)(__tests__|fixtures?|\.env|canon_parity)(\/|$)|\.key$/i.test(name)),
    "test fixtures and sensitive files must not ship",
  );

  const installRoot = path.join(tempRoot, "install");
  await mkdir(installRoot);
  const tarball = path.join(tempRoot, packed.filename);
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: installRoot, stdio: "pipe" },
  );

  const binPath = path.join(installRoot, "node_modules", "sigrank", "bin", "sigrank.mjs");
  const standard = JSON.parse(runNode(binPath, ["standard", "--json"]));
  assert.equal(standard.spec, "sigrank/0.1-draft");

  const exported = JSON.parse(
    runNode(binPath, [
      "export",
      "--standard",
      "--input",
      "1251211",
      "--output",
      "11296121",
      "--cache-write",
      "128196310",
      "--cache-read",
      "2555179769",
    ]),
  );
  assert.equal(exported.metrics.yield, 18436.98);

  await exerciseStdio(binPath);
  console.log("packed-artifact-smoke.mjs: ok");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
