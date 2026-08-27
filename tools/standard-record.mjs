import { cascade } from "../analytics/cascade.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const SIGRANK_STANDARD_VERSION = "sigrank/0.1-draft";

export const TOOL_DEF = {
  name: "get_sigrank_standard_record",
  description:
    "Build a SigRank Standard v0.1-draft portable operator record from four token pillars. Computes the canonical cascade locally through @sigrank/cascade and returns versioned telemetry plus the normative core metrics: Yield, Leverage, Velocity, SNR, and 10xDEV. No data is submitted or persisted. The core record contains token telemetry only and does not require prompt text, code, or response content.",
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
    required: ["input", "output", "cache_write", "cache_read"],
    properties: {
      input: { type: "number", minimum: 0, description: "Fresh input tokens." },
      output: { type: "number", minimum: 0, description: "Output tokens." },
      cache_write: { type: "number", minimum: 0, description: "Cache-write / cache-creation tokens." },
      cache_read: { type: "number", minimum: 0, description: "Cache-read tokens." },
      provider: { type: "string", description: "Optional provider identifier." },
      model: { type: "string", description: "Optional model identifier." },
      tool: { type: "string", description: "Optional tool/client identifier." },
      timestamp: { type: "string", description: "Optional ISO-8601 timestamp. Defaults to the current time." }
    }
  },
  outputSchema: {
    type: "object",
    required: ["spec", "timestamp", "source", "telemetry", "metrics"],
    properties: {
      spec: { type: "string", description: "SigRank specification version." },
      timestamp: { type: "string", description: "ISO-8601 record timestamp." },
      source: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          tool: { type: "string" }
        }
      },
      telemetry: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
          cache_write: { type: "number" },
          cache_read: { type: "number" }
        }
      },
      metrics: {
        type: "object",
        properties: {
          yield: { type: ["number", "null"] },
          leverage: { type: ["number", "null"] },
          velocity: { type: ["number", "null"] },
          snr: { type: ["number", "null"] },
          dev10x: { type: ["number", "null"] },
          construction: { type: ["number", "null"] }
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    }
  }
};

export async function handleGetSigRankStandardRecord(args) {
  const input = Number(args?.input);
  const output = Number(args?.output);
  const cacheWrite = Number(args?.cache_write);
  const cacheRead = Number(args?.cache_read);

  if (![input, output, cacheWrite, cacheRead].every(Number.isFinite)) {
    throw new Error("get_sigrank_standard_record requires four finite numeric token pillars.");
  }
  if ([input, output, cacheWrite, cacheRead].some((v) => v < 0)) {
    throw new Error("get_sigrank_standard_record requires non-negative token pillars.");
  }

  const c = cascade({ input, output, cacheCreate: cacheWrite, cacheRead });
  const construction = output > 0 ? cacheWrite / output : null;

  return {
    spec: SIGRANK_STANDARD_VERSION,
    timestamp: args?.timestamp || new Date().toISOString(),
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
      yield: c.yield,
      leverage: c.leverage,
      velocity: c.velocity,
      snr: c.snr,
      dev10x: c.dev10x,
      construction: construction === null ? null : Number(construction.toFixed(4)),
    },
    warnings: c.warnings || [],
  };
}
