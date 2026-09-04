import { cascade } from "../analytics/cascade.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const SIGRANK_STANDARD_VERSION = "sigrank/0.1-draft";
export const TTEOP_PROTOCOL_VERSION = "tteop/0.1-draft";
export const TTEOP_SPEC_VERSION = "tteop-spec@0.1.5-draft";
export const PRODUCT_ARCHITECTURE = Object.freeze({
  brand: "SignalAF",
  governance: "MO§ES™",
  product: "Upsilon",
  leaderboard: "SigRank",
  wire_spec: SIGRANK_STANDARD_VERSION,
  protocol: TTEOP_PROTOCOL_VERSION,
  protocol_authority: TTEOP_SPEC_VERSION,
});

export const TOOL_DEF = {
  name: "get_sigrank_standard_record",
  description:
    "Build Upsilon's portable sigrank/0.1-draft compatibility record from available token telemetry. Input and output are required; unavailable cache telemetry remains null. Computes the canonical cascade locally through token-cascade and returns Yield, Leverage, Velocity, SNR, and 10xDEV. Upsilon is the measurement product; SigRank is the public leaderboard. No data is submitted or persisted.",
  annotations: {
    title: "Export Upsilon measurement record",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.destructiveHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["input", "output"],
    properties: {
      input: { type: "integer", minimum: 0, description: "Fresh input tokens." },
      output: { type: "integer", minimum: 0, description: "Output tokens." },
      cache_write: { type: ["integer", "null"], minimum: 0, description: "Cache-write / cache-creation tokens, or null when unavailable." },
      cache_read: { type: ["integer", "null"], minimum: 0, description: "Cache-read tokens, or null when unavailable." },
      provider: { type: "string", description: "Optional provider identifier." },
      model: { type: "string", description: "Optional model identifier." },
      tool: { type: "string", description: "Optional tool/client identifier." },
      timestamp: { type: "string", format: "date-time", description: "Optional ISO-8601 timestamp. Defaults to the current time." }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["spec", "spec_status", "protocol", "timestamp", "source", "telemetry", "metrics", "warnings"],
    properties: {
      spec: { const: SIGRANK_STANDARD_VERSION, description: "Legacy wire identifier. Resolves to TTEOP tteop/0.1-draft." },
      spec_status: { const: "legacy_alias", description: "Indicates this spec identifier is a legacy alias, not a current protocol." },
      protocol: {
        type: "object",
        additionalProperties: false,
        required: ["name", "version", "authority"],
        properties: {
          name: { const: "TTEOP", description: "Canonical protocol name." },
          version: { const: TTEOP_PROTOCOL_VERSION, description: "Current TTEOP protocol version." },
          authority: { const: TTEOP_SPEC_VERSION, description: "Canonical executable/reference implementation." }
        }
      },
      timestamp: { type: "string", format: "date-time", description: "ISO-8601 record timestamp." },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "model", "tool"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          tool: { type: "string" }
        }
      },
      telemetry: {
        type: "object",
        additionalProperties: false,
        required: ["input", "output", "cache_write", "cache_read"],
        properties: {
          input: { type: "integer", minimum: 0 },
          output: { type: "integer", minimum: 0 },
          cache_write: { type: ["integer", "null"], minimum: 0 },
          cache_read: { type: ["integer", "null"], minimum: 0 }
        }
      },
      metrics: {
        type: "object",
        additionalProperties: false,
        required: ["yield", "leverage", "velocity", "snr", "dev10x"],
        properties: {
          yield: { type: ["number", "null"] },
          leverage: { type: ["number", "null"] },
          velocity: { type: ["number", "null"] },
          snr: { type: ["number", "null"] },
          dev10x: { type: ["number", "null"] }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  }
};

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function tokenCount(value, name, required) {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${name} is required.`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a non-negative integer token count.`);
  }
  if (value < 0) throw new Error(`${name} must be a non-negative integer token count.`);
  return value;
}

function recordTimestamp(value) {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("timestamp must be a valid ISO-8601 date-time.");
  }
  return value;
}

export async function handleGetSigRankStandardRecord(args) {
  const input = tokenCount(args?.input, "input", true);
  const output = tokenCount(args?.output, "output", true);
  const cacheWrite = tokenCount(args?.cache_write, "cache_write", false);
  const cacheRead = tokenCount(args?.cache_read, "cache_read", false);

  const c = cascade({
    input,
    output,
    cacheCreate: cacheWrite ?? 0,
    cacheRead: cacheRead ?? 0,
  });
  // Standard warning order: cache-unavailability warnings precede the
  // dev10x_undefined warning (the "why" before the "what"). The standalone
  // conformance runner validates warnings as ordered arrays.
  const warnings = [];
  if (cacheWrite === null) warnings.push("cache_write is unavailable; 10xDEV is undefined.");
  if (cacheRead === null) warnings.push("cache_read is unavailable; Yield, Leverage, and 10xDEV are undefined.");
  for (const w of (c.warnings || [])) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  return {
    spec: SIGRANK_STANDARD_VERSION,
    spec_status: "legacy_alias",
    protocol: {
      name: "TTEOP",
      version: TTEOP_PROTOCOL_VERSION,
      authority: TTEOP_SPEC_VERSION,
    },
    timestamp: recordTimestamp(args?.timestamp),
    source: {
      provider: args?.provider || "unknown",
      model: args?.model || "unknown",
      tool: args?.tool || "sigrank-mcp",
    },
    telemetry: {
      input,
      output,
      cache_write: cacheWrite,
      cache_read: cacheRead,
    },
    metrics: {
      yield: cacheRead === null ? null : c.yield,
      leverage: cacheRead === null ? null : c.leverage,
      velocity: c.velocity,
      snr: c.snr,
      dev10x: cacheWrite === null || cacheRead === null ? null : c.dev10x,
    },
    warnings,
  };
}
