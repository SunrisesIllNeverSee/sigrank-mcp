/**
 * tools/_schemas.mjs — MCP tool annotation + input/output schema objects.
 */

// Smithery quality: output schemas + annotations
// MCP tool annotations hint to clients about side-effects, read-only status, etc.
export const ANNOTATIONS = {
  readOnlyHint: { readOnlyHint: true },
  destructiveHint: { destructiveHint: false },
  idempotentHint: { idempotentHint: true },
  openWorldHint: { openWorldHint: false },
};

// Common output schema for cascade results (rank_paste, simulate_change, etc.)
export const CASCADE_OUTPUT = {
  type: "object",
  properties: {
    yield_: {
      type: "number",
      description:
        "Υ Yield — the headline efficiency metric (Cache Reads × Output / Input²)",
    },
    snr: { type: "number", description: "Signal-to-noise ratio" },
    leverage: {
      type: "number",
      description: "Cr/I — cache reads divided by input",
    },
    velocity: { type: "number", description: "O/I — output divided by input" },
    tenx_dev: { type: "number", description: "10xDEV score" },
    class: {
      type: "string",
      enum: ["Burner", "Builder", "10xer"],
      description: "Operator class tier",
    },
    card: {
      type: "string",
      description: "Deterministic prose summary of the cascade result",
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Parse or data warnings if any",
    },
  },
  required: ["yield_", "class"],
};

export const LEADERBOARD_OUTPUT = {
  type: "object",
  properties: {
    operators: {
      type: "array",
      description: "Array of ranked operators sorted by yield",
      items: {
        type: "object",
        properties: {
          codename: { type: "string", description: "Public display name" },
          yield_: { type: "number", description: "Υ Yield metric" },
          leverage: { type: "number", description: "Cr/I ratio" },
          velocity: { type: "number", description: "O/I ratio" },
          class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
          rank: { type: "integer", description: "1-based rank position" },
        },
      },
    },
  },
};

export const OPERATOR_OUTPUT = {
  type: "object",
  properties: {
    codename: { type: "string", description: "Operator display name" },
    yield_: { type: "number", description: "Υ Yield metric" },
    leverage: { type: "number", description: "Cr/I ratio" },
    velocity: { type: "number", description: "O/I ratio" },
    class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
    rank: { type: "integer", description: "1-based rank position" },
    windows: {
      type: "array",
      description: "Per-window breakdowns (7d, 30d, 90d, all-time)",
      items: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["7d", "30d", "90d", "all_time"] },
          pillars: {
            type: "object",
            properties: {
              input: { type: "integer" },
              output: { type: "integer" },
              cacheCreate: { type: "integer" },
              cacheRead: { type: "integer" },
            },
          },
        },
      },
    },
  },
};

export const BEST_OPERATOR_OUTPUT = {
  type: "object",
  properties: {
    top_operators: {
      type: "array",
      description: "Top N operators ranked by yield",
      items: {
        type: "object",
        properties: {
          codename: { type: "string", description: "Public display name" },
          yield_: { type: "number", description: "Υ Yield metric" },
          leverage: { type: "number", description: "Cr/I ratio" },
          velocity: { type: "number", description: "O/I ratio" },
          class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
          rank: { type: "integer", description: "1-based rank position" },
          behavioral_framing: {
            type: "string",
            description: "Plain-language interpretation of the operator's cascade in power-user terms",
          },
        },
      },
    },
    total_operators: { type: "integer", description: "Total operators on the board" },
    summary: {
      type: "string",
      description: "One-line summary of the top operator's achievement in behavioral terms",
    },
  },
};

export const COMPARE_SELF_OUTPUT = {
  type: "object",
  properties: {
    your_metrics: {
      type: "object",
      description: "Your cascade metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number", description: "Υ Yield metric" },
        leverage: { type: "number", description: "Cr/I ratio" },
        velocity: { type: "number", description: "O/I ratio" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer", description: "1-based rank position" },
      },
    },
    power_user_assessment: {
      type: "string",
      description: "Behavioral interpretation: are you an AI power user? Maps class tier to power-user language.",
    },
    comparison: {
      type: "object",
      description: "How you compare to board averages and archetypes",
      properties: {
        your_yield_vs_avg: { type: "string", description: "Your yield vs board average" },
        your_class_meaning: { type: "string", description: "What your class tier means in power-user terms" },
        percentile: { type: "number", description: "Your percentile rank (0-100)" },
      },
    },
    suggestion: {
      type: "string",
      description: "One actionable suggestion to improve your cascade efficiency",
    },
  },
};

export const COMPARE_OPERATORS_OUTPUT = {
  type: "object",
  properties: {
    operator_a: {
      type: "object",
      description: "First operator's metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number" },
        leverage: { type: "number" },
        velocity: { type: "number" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer" },
      },
    },
    operator_b: {
      type: "object",
      description: "Second operator's metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number" },
        leverage: { type: "number" },
        velocity: { type: "number" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer" },
      },
    },
    verdict: {
      type: "string",
      description: "Who is more efficient and why, in behavioral terms",
    },
    yield_delta: { type: "number", description: "Yield difference (A - B)" },
  },
};

export const SUBMIT_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ok", "error", "skipped"],
      description: "Submission status",
    },
    preview: CASCADE_OUTPUT,
    server_response: {
      type: "object",
      description: "Server-side response including new rank if accepted",
    },
    reason: {
      type: "string",
      description: "Error or skip reason if status is not ok",
    },
  },
};

export const TOKENPULL_OUTPUT = {
  type: "object",
  properties: {
    platform: { type: "string", description: "Source platform name" },
    generatedAt: { type: "string", description: "ISO timestamp of the pull" },
    windows: {
      type: "array",
      description: "Per-window token usage + cascade results",
      items: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["7d", "30d", "90d", "all"] },
          pillars: {
            type: "object",
            properties: {
              input: { type: "integer" },
              output: { type: "integer" },
              cacheCreate: { type: "integer" },
              cacheRead: { type: "integer" },
            },
          },
          messages: {
            type: "integer",
            description: "Number of messages in window",
          },
          estimated: {
            type: "boolean",
            description: "True if cacheCreate was estimated",
          },
          cascade: CASCADE_OUTPUT,
        },
      },
    },
  },
};

export const ENROLL_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["enrolled", "error"],
      description: "Enrollment result",
    },
    codename: { type: "string", description: "Operator codename if enrolled" },
    operator_id: { type: "string", description: "Operator ID if enrolled" },
    device_id: { type: "string", description: "Local device ID" },
    trust_status: { type: "string", description: "Trust level of the device" },
    reason: { type: "string", description: "Error reason if status is error" },
  },
};

export const COMPARE_OUTPUT = {
  type: "object",
  properties: {
    platform: { type: "string" },
    sources: {
      type: "array",
      description: "Side-by-side comparison of each token source",
      items: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Source name (tokenpull, ccusage, token-dash, tokscale)",
          },
          pillars: { type: "object" },
          cascade: CASCADE_OUTPUT,
          delta_pct: {
            type: "object",
            description: "Delta % vs tokenpull baseline",
          },
        },
      },
    },
  },
};

export const SIMULATE_OUTPUT = {
  type: "object",
  properties: {
    current: CASCADE_OUTPUT,
    simulated: CASCADE_OUTPUT,
    yield_delta: {
      type: "number",
      description: "Υ Yield change (simulated - current)",
    },
    class_change: {
      type: "string",
      description: "Class tier change description",
    },
    metric_diffs: {
      type: "object",
      description: "Per-metric before/after diffs",
    },
  },
};

export const DIAGNOSE_OUTPUT = {
  type: "object",
  properties: {
    pillars: { type: "object", description: "The 4 raw token pillars" },
    cascade: CASCADE_OUTPUT,
    diagnosis: {
      type: "array",
      description: "Ranked list of efficiency leaks found, worst first",
      items: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            description: "Which metric is underperforming",
          },
          severity: {
            type: "string",
            enum: ["critical", "warning", "info"],
            description: "How bad the leak is",
          },
          finding: { type: "string", description: "What the analysis found" },
          recommendation: {
            type: "string",
            description: "What to do about it",
          },
          estimated_yield_impact: {
            type: "string",
            description: "Estimated Υ improvement if fixed",
          },
        },
      },
    },
    summary: {
      type: "string",
      description: "One-line summary of the operator's cascade health",
    },
  },
};

export const SUGGEST_OUTPUT = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      description: "Ranked recommendations, highest Υ impact first",
      items: {
        type: "object",
        properties: {
          rank: { type: "number", description: "1-based rank by Υ impact" },
          action: { type: "string", description: "What to change" },
          pillar: { type: "string", description: "Which pillar to adjust" },
          delta: { type: "string", description: "How much to change it" },
          simulated_yield: {
            type: "number",
            description: "Projected Υ after the change",
          },
          yield_delta: { type: "number", description: "Υ change vs current" },
          class_after: {
            type: "string",
            description: "Projected class after the change",
          },
          rationale: { type: "string", description: "Why this helps" },
        },
      },
    },
    current_yield: {
      type: "number",
      description: "Current Υ before any changes",
    },
    current_class: { type: "string", description: "Current class tier" },
    best_single_change: {
      type: "string",
      description: "The single highest-impact change",
    },
  },
};
