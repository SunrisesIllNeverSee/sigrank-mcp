import { cascade } from "../analytics/cascade.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const SIGRANK_STANDARD_VERSION = "sigrank/0.1-draft";

export const TOOL_DEF = {
  name: "get_sigrank_standard_record",
  description:
    "Build a SigRank Standard v0.1-draft portable operator record from available token telemetry. Input and output are required; unavailable cache telemetry remains null. Computes the canonical cascade locally through @sigrank/cascade and returns the normative core metrics: Yield, Leverage, Velocity, SNR, and 10xDEV. No data is submitted or persisted.",
  annotations: {
    title: "Export SigRank standard record",
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
    required: ["spec", "timestamp", "source", "telemetry", "metrics", "warnings"],
    properties: {
      spec: { const: SIGRANK_STANDARD_VERSION, description: "SigRank specification version." },
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
  const warnings = [...(c.warnings || [])];
  if (cacheWrite === null) warnings.push("cache_write is unavailable; 10xDEV is undefined.");
  if (cacheRead === null) warnings.push("cache_read is unavailable; Yield, Leverage, and 10xDEV are undefined.");

  return {
    spec: SIGRANK_STANDARD_VERSION,
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
