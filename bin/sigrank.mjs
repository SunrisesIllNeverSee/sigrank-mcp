#!/usr/bin/env node

/**
 * Thin command shim for SigRank Standard commands.
 *
 * All existing commands and MCP/TUI behavior are delegated to ../index.mjs.
 * The shim exists so the standard commands can be added without coupling the
 * large presentation CLI to the standard specification.
 */

const args = process.argv.slice(2);
const cmd = args[0];

const SPEC = "sigrank/0.1-draft";
const STANDARD_URL = "https://signalaf.com/standard";
const SCHEMA_URL =
  "https://signalaf.com/standard/sigrank-operator-record-v0.1.schema.json";

function flag(name, fallback = undefined) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) {
    return args[i + 1];
  }
  return fallback;
}

function printStandard() {
  const payload = {
    spec: SPEC,
    status: "proposed_open_standard",
    scope: "human operation of generative AI systems",
    telemetry: ["input", "output", "cache_write", "cache_read"],
    metrics: {
      yield: "(cache_read * output) / input^2",
      leverage: "cache_read / input",
      velocity: "output / input",
      snr: "output / (input + output)",
      dev10x: "log10(cache_read / input)",
    },
    privacy:
      "Core metrics do not require prompt text, response text, source code, or repository contents.",
    reference_math: "@sigrank/cascade",
    reference_platform: "SignalAF",
    standard_url: STANDARD_URL,
    schema_url: SCHEMA_URL,
  };

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`SigRank Standard ${SPEC}\n`);
  process.stdout.write(`The new standard in operator metrics.\n\n`);
  process.stdout.write(`Scope: ${payload.scope}\n`);
  process.stdout.write(`Primitives: input / output / cache_write / cache_read\n`);
  process.stdout.write(`Core metrics: Yield / Leverage / Velocity / SNR / 10xDEV\n`);
  process.stdout.write(`Reference math: @sigrank/cascade\n`);
  process.stdout.write(`Reference platform: SignalAF\n`);
  process.stdout.write(`Spec: ${STANDARD_URL}\n`);
  process.stdout.write(`Schema: ${SCHEMA_URL}\n`);
}

async function exportStandardRecord() {
  const { callTool } = await import("../tools.mjs");

  const platform = flag("platform", "claude");
  const window = flag("window", "30d");

  const explicit = ["input", "output", "cache-write", "cache-read"].every(
    (name) => flag(name) !== undefined,
  );

  let pillars;
  let sourcePlatform = platform;

  if (explicit) {
    pillars = {
      input: Number(flag("input")),
      output: Number(flag("output")),
      cache_write: Number(flag("cache-write")),
      cache_read: Number(flag("cache-read")),
    };
  } else {
    const pulled = await callTool("tokenpull", { platform });
    const selected = (pulled?.windows || []).find(
      (w) => w.window === window || (window === "all_time" && w.window === "all"),
    );
    if (!selected?.pillars) {
      throw new Error(
        `No ${window} telemetry found for ${platform}. Pass --platform/--window or explicit --input --output --cache-write --cache-read.`,
      );
    }
    sourcePlatform = pulled.platform || platform;
    pillars = {
      input: selected.pillars.input,
      output: selected.pillars.output,
      cache_write: selected.pillars.cacheCreate,
      cache_read: selected.pillars.cacheRead,
    };
  }

  for (const [key, value] of Object.entries(pillars)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a non-negative finite number.`);
    }
  }

  const record = await callTool("get_sigrank_standard_record", {
    ...pillars,
    provider: flag("provider", "local"),
    model: flag("model", "unknown"),
    tool: flag("tool", sourcePlatform || "sigrank"),
    timestamp: new Date().toISOString(),
  });

  record.context = {
    ...(record.context || {}),
    window,
    source_platform: sourcePlatform,
  };

  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

if (cmd === "standard") {
  printStandard();
} else if (cmd === "export" && args.includes("--standard")) {
  exportStandardRecord().catch((err) => {
    process.stderr.write(`[sigrank] ${err?.message || err}\n`);
    process.exitCode = 1;
  });
} else {
  await import("../index.mjs");
}
