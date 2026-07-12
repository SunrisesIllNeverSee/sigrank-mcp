#!/usr/bin/env node
/**
 * sigrank_intent_eval.mjs — Intent classifier + routing benchmark
 *
 * Items 3.8 + 3.9 from PERPLEXITY_V2_EXECUTABLE_ITEMS.md
 *
 * Runs the 30-prompt annotation set through a keyword-based intent classifier,
 * then evaluates:
 *   1. Intent detection: precision / recall / F1 at the intent level
 *   2. Tool routing: did the classifier pick the right MCP tool?
 *   3. Response alignment: does the response include the required competitive fields?
 *
 * Composite score (per v2 turn 20):
 *   0.35 × intent_f1 + 0.25 × routing_correct + 0.25 × answer_score + 0.15 × cta_match
 *
 * Usage:
 *   node eval/sigrank_intent_eval.mjs              # run eval, print report
 *   node eval/sigrank_intent_eval.mjs --json        # output JSON only
 *   node eval/sigrank_intent_eval.mjs --verbose      # per-prompt breakdown
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, "sigrank_prompt_annotations.csv");

// ── Intent taxonomy (mirrors sigrank_intent_schema.yaml) ─────────────────────

const INTENT_TAXONOMY = [
  {
    name: "BEST_OPERATOR_INTENT",
    tool: "get_best_operator",
    cta: "Check my rank",
    keywords: ["best", "top", "leaderboard", "winning", "winner", "champion", "who is the best", "show me the top", "show me the leaderboard"],
    exclude: ["my", "me", "i am", "compare my", "measure"],
  },
  {
    name: "COMPARE_SELF_INTENT",
    tool: "compare_self",
    cta: "See where I stand",
    keywords: ["measure up", "compare my", "am i", "where do i rank", "how do i compare", "am i doing", "better than average", "my ai usage", "power user"],
    exclude: [],
  },
  {
    name: "COMPARE_OPERATORS_INTENT",
    tool: "compare_operators",
    cta: "Compare me to others",
    keywords: ["compare operator", "side by side", "side-by-side", "who is more efficient", "compare these", "vs"],
    exclude: ["my", "i", "me"],
  },
  {
    name: "DESCRIBE_POWER_USER_INTENT",
    tool: "describe_power_user",
    cta: "Learn the scoring",
    keywords: ["what makes", "how do advanced", "what is an ai power user", "explain the scoring", "power user"],
    exclude: ["am i", "my", "how do i become"],
  },
  {
    name: "OPTIMIZE_EFFICIENCY_INTENT",
    tool: "optimize_efficiency",
    cta: "Improve my score",
    keywords: ["fewer tokens", "more efficient", "reduce token", "optimize", "rank higher", "better ai user", "how do i become a better"],
    exclude: [],
  },
  {
    name: "SIGN_UP_OR_SUBMIT_INTENT",
    tool: "submit_verified",
    cta: "Join the leaderboard",
    keywords: ["sign me up", "submit my", "enroll me", "publish my", "join the leaderboard"],
    exclude: [],
  },
];

const ALL_INTENT_NAMES = INTENT_TAXONOMY.map((i) => i.name);
const CONFIDENCE_THRESHOLD = 0.78;

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // Simple CSV parse — no quoted commas in our data
    const vals = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ""; });
    return row;
  });
}

// ── Intent classifier (keyword-based, no LLM required) ───────────────────────

function classifyIntent(prompt) {
  const lower = " " + prompt.toLowerCase() + " ";
  const scores = [];

  for (const intent of INTENT_TAXONOMY) {
    let score = 0;
    let matched = [];

    // Check exclusions using word boundaries (not substring — "i" shouldn't match "is")
    const hasExclusion = intent.exclude.some((ex) => {
      const re = new RegExp(`\\b${ex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return re.test(lower);
    });

    for (const kw of intent.keywords) {
      if (lower.includes(kw)) {
        score += 1;
        matched.push(kw);
      }
    }

    // Penalize if exclusion keywords are present (self-referential prompts)
    if (hasExclusion && score > 0) {
      score *= 0.5;
    }

    if (score > 0) {
      // 1 match = 0.85 (above threshold), 2+ = 1.0
      const confidence = score >= 2 ? 1.0 : 0.85;
      scores.push({
        intent: intent.name,
        tool: intent.tool,
        cta: intent.cta,
        confidence,
        matched,
      });
    }
  }

  scores.sort((a, b) => b.confidence - a.confidence);

  const primary = scores[0] || null;
  const secondary = scores.slice(1).filter((s) => s.confidence >= CONFIDENCE_THRESHOLD);

  // Fallback: ask clarifying question
  if (!primary || primary.confidence < CONFIDENCE_THRESHOLD) {
    return {
      primary_intent: null,
      secondary_intents: [],
      tool: null,
      cta: null,
      confidence: primary?.confidence || 0,
      fallback: "ask_clarifying_question",
      matched: primary?.matched || [],
    };
  }

  return {
    primary_intent: primary.intent,
    secondary_intents: secondary.map((s) => s.intent),
    tool: primary.tool,
    cta: primary.cta,
    confidence: primary.confidence,
    fallback: null,
    matched: primary.matched,
  };
}

// ── Evaluation metrics ────────────────────────────────────────────────────────

function precisionRecallF1(tp, fp, fn) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

// ── Required competitive fields per SHARED_DESIGN_DECISIONS.md §3 ─────────────

const REQUIRED_COMPETITIVE_FIELDS = [
  "rank", "percentile", "class_tier", "delta_from_average", "delta_from_top", "shareable_url",
];

// Simulated response shape check — does the tool return the right fields?
function checkResponseAlignment(tool) {
  // These are the tools we updated to include the competitive layer
  const toolsWithCompetitiveLayer = [
    "get_best_operator", "compare_self", "compare_operators", "optimize_efficiency",
  ];
  const toolsWithShareableUrl = [
    "get_best_operator", "compare_self", "compare_operators", "describe_power_user", "optimize_efficiency",
  ];

  const hasCompetitive = toolsWithCompetitiveLayer.includes(tool);
  const hasShareable = toolsWithShareableUrl.includes(tool);

  // Score: 5 if all fields present, partial for some
  if (hasCompetitive && hasShareable) return 5;
  if (hasShareable) return 3;
  if (hasCompetitive) return 4;
  return 1;
}

// ── Main eval ─────────────────────────────────────────────────────────────────

function runEval() {
  const csvText = readFileSync(CSV_PATH, "utf-8");
  const annotations = parseCSV(csvText);

  const results = [];
  const intentStats = {}; // per-intent TP/FP/FN

  for (const ann of annotations) {
    const prediction = classifyIntent(ann.prompt);

    // Primary intent match
    const primaryMatch = prediction.primary_intent === ann.primary_intent;

    // Secondary intent match (check if any predicted secondary matches)
    const expectedSecondaries = ann.secondary_intent
      ? ann.secondary_intent.split("|").map((s) => s.trim()).filter(Boolean)
      : [];
    const secondaryMatches = expectedSecondaries.filter(
      (s) => prediction.secondary_intents.includes(s),
    );

    // Tool routing
    const routingCorrect = prediction.tool === ann.expected_tool;

    // CTA match
    const ctaMatch = prediction.cta === ann.expected_cta;

    // Response alignment (simulated — checks if the tool has the right fields)
    const answerScore = prediction.tool ? checkResponseAlignment(prediction.tool) : 0;

    // Track per-intent stats
    if (!intentStats[ann.primary_intent]) {
      intentStats[ann.primary_intent] = { tp: 0, fp: 0, fn: 0 };
    }
    if (primaryMatch) {
      intentStats[ann.primary_intent].tp++;
    } else {
      intentStats[ann.primary_intent].fn++;
      if (prediction.primary_intent) {
        if (!intentStats[prediction.primary_intent]) {
          intentStats[prediction.primary_intent] = { tp: 0, fp: 0, fn: 0 };
        }
        intentStats[prediction.primary_intent].fp++;
      }
    }

    // Confidence check
    const confidenceOk = prediction.confidence >= Number(ann.expected_confidence_min);

    results.push({
      id: Number(ann.id),
      prompt: ann.prompt,
      expected_primary: ann.primary_intent,
      predicted_primary: prediction.primary_intent,
      primary_match: primaryMatch,
      expected_secondary: expectedSecondaries,
      predicted_secondary: prediction.secondary_intents,
      secondary_matches: secondaryMatches,
      expected_tool: ann.expected_tool,
      predicted_tool: prediction.tool,
      routing_correct: routingCorrect,
      expected_cta: ann.expected_cta,
      predicted_cta: prediction.cta,
      cta_match: ctaMatch,
      answer_score: answerScore,
      confidence: prediction.confidence,
      expected_confidence_min: Number(ann.expected_confidence_min),
      confidence_ok: confidenceOk,
      fallback: prediction.fallback,
      matched_keywords: prediction.matched,
      difficulty: ann.difficulty,
      ambiguity: ann.ambiguity,
      multi_intent: ann.multi_intent === "true",
    });
  }

  // ── Aggregate metrics ──────────────────────────────────────────────────────

  const total = results.length;
  const primaryCorrect = results.filter((r) => r.primary_match).length;
  const routingCorrectCount = results.filter((r) => r.routing_correct).length;
  const ctaMatchCount = results.filter((r) => r.cta_match).length;
  const fallbackCount = results.filter((r) => r.fallback).length;
  const confidenceOkCount = results.filter((r) => r.confidence_ok).length;

  // Per-intent P/R/F1
  const perIntent = {};
  for (const [intent, stats] of Object.entries(intentStats)) {
    perIntent[intent] = precisionRecallF1(stats.tp, stats.fp, stats.fn);
  }

  // Overall P/R/F1 (micro-averaged)
  const totalTP = Object.values(intentStats).reduce((s, st) => s + st.tp, 0);
  const totalFP = Object.values(intentStats).reduce((s, st) => s + st.fp, 0);
  const totalFN = Object.values(intentStats).reduce((s, st) => s + st.fn, 0);
  const overall = precisionRecallF1(totalTP, totalFP, totalFN);

  // Routing accuracy
  const routingAccuracy = routingCorrectCount / total;

  // Average answer score (normalized to 0-1)
  const avgAnswerScore = results.reduce((s, r) => s + r.answer_score, 0) / (total * 5);

  // CTA match rate
  const ctaAccuracy = ctaMatchCount / total;

  // Composite score per v2 turn 20:
  // 0.35 × intent_f1 + 0.25 × routing_correct + 0.25 × answer_score + 0.15 × cta_match
  const composite =
    0.35 * overall.f1 +
    0.25 * routingAccuracy +
    0.25 * avgAnswerScore +
    0.15 * ctaAccuracy;

  return {
    summary: {
      total_prompts: total,
      primary_intent_accuracy: primaryCorrect / total,
      routing_accuracy: routingAccuracy,
      cta_match_rate: ctaAccuracy,
      fallback_rate: fallbackCount / total,
      confidence_pass_rate: confidenceOkCount / total,
      overall_precision: overall.precision,
      overall_recall: overall.recall,
      overall_f1: overall.f1,
      avg_answer_score: avgAnswerScore,
      composite_score: composite,
    },
    per_intent: perIntent,
    results,
  };
}

// ── Report formatter ──────────────────────────────────────────────────────────

function printReport(evalResult, verbose = false) {
  const { summary, per_intent, results } = evalResult;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SigRank Intent Classifier — Evaluation Report");
  console.log("  Items 3.8 + 3.9 | 30-prompt benchmark | keyword-based classifier");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("── Overall Metrics ──────────────────────────────────────────");
  console.log(`  Prompts:              ${summary.total_prompts}`);
  console.log(`  Primary intent acc:   ${(summary.primary_intent_accuracy * 100).toFixed(1)}%`);
  console.log(`  Routing accuracy:     ${(summary.routing_accuracy * 100).toFixed(1)}%`);
  console.log(`  CTA match rate:       ${(summary.cta_match_rate * 100).toFixed(1)}%`);
  console.log(`  Fallback rate:        ${(summary.fallback_rate * 100).toFixed(1)}%`);
  console.log(`  Confidence pass rate: ${(summary.confidence_pass_rate * 100).toFixed(1)}%`);
  console.log();
  console.log(`  Precision (micro):    ${(summary.overall_precision * 100).toFixed(1)}%`);
  console.log(`  Recall (micro):       ${(summary.overall_recall * 100).toFixed(1)}%`);
  console.log(`  F1 (micro):           ${(summary.overall_f1 * 100).toFixed(1)}%`);
  console.log(`  Avg answer score:     ${(summary.avg_answer_score * 100).toFixed(1)}%`);
  console.log();
  console.log(`  ★ Composite score:    ${(summary.composite_score * 100).toFixed(1)}%`);
  console.log(`    (0.35×F1 + 0.25×routing + 0.25×answer + 0.15×CTA)`);
  console.log();

  console.log("── Per-Intent Breakdown ─────────────────────────────────────");
  console.log("  Intent                          Precision  Recall  F1");
  console.log("  ──────────────────────────────  ─────────  ──────  ──");
  for (const [intent, m] of Object.entries(per_intent)) {
    console.log(
      `  ${intent.padEnd(30)}  ${(m.precision * 100).toFixed(0).padStart(5)}%   ${(m.recall * 100).toFixed(0).padStart(3)}%  ${(m.f1 * 100).toFixed(0).padStart(2)}%`,
    );
  }
  console.log();

  if (verbose) {
    console.log("── Per-Prompt Breakdown ─────────────────────────────────────");
    for (const r of results) {
      const status = r.primary_match ? "✓" : "✗";
      const fb = r.fallback ? " [FALLBACK]" : "";
      console.log(`  ${status} #${String(r.id).padStart(2)} ${r.prompt}`);
      console.log(`       expected: ${r.expected_primary} → ${r.expected_tool}`);
      console.log(`       predicted: ${r.predicted_primary || "NONE"} → ${r.predicted_tool || "NONE"}${fb}`);
      if (!r.primary_match) {
        console.log(`       ⚠ mismatch — matched: [${r.matched_keywords.join(", ")}]`);
      }
      console.log();
    }
  }

  // Mismatches summary
  const mismatches = results.filter((r) => !r.primary_match);
  if (mismatches.length > 0) {
    console.log(`── Mismatches (${mismatches.length}) ──────────────────────────`);
    for (const r of mismatches) {
      console.log(`  #${r.id}: expected ${r.expected_primary}, got ${r.predicted_primary || "NONE"} — "${r.prompt}"`);
    }
    console.log();
  }

  const fallbacks = results.filter((r) => r.fallback);
  if (fallbacks.length > 0) {
    console.log(`── Fallbacks (${fallbacks.length}) ──────────────────────────────`);
    for (const r of fallbacks) {
      console.log(`  #${r.id}: confidence ${r.confidence.toFixed(2)} < ${r.expected_confidence_min} — "${r.prompt}"`);
    }
    console.log();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const verbose = args.includes("--verbose");

const evalResult = runEval();

if (jsonMode) {
  console.log(JSON.stringify(evalResult, null, 2));
} else {
  printReport(evalResult, verbose);
}
