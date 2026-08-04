// class-tiers.test.mjs — guards the single-source-of-truth class-tier taxonomy.
//
// Run: node --test __tests__/class-tiers.test.mjs
//
// The 8-tier dev10x taxonomy lives in analytics/cascade.mjs (CLASS_TIERS +
// classify() + UNCLASSED). Before this guard, the TUI color map, the CLI
// color map, the MCP output-schema enums, and resources/class-tiers.md each
// maintained their own tier list — and they had drifted (TUI/CLI carried a
// dead BEARER entry; schemas inlined the legacy 3-tier ["Burner","Builder",
// "10xer"]; the doc described only 3 tiers). This test asserts every consumer
// matches the canonical list so a future drift fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLASS_TIERS, UNCLASSED, classify } from "../analytics/cascade.mjs";
import { CASCADE_OUTPUT, CLASS_ENUM } from "../tools/_schemas.mjs";

test("CLASS_TIERS is the 8-tier dev10x list in cut order", () => {
  assert.deepEqual(
    CLASS_TIERS,
    ["TRANSMITTER", "ARCH+", "ARCH", "POWER", "BASE", "SEEKER", "REFINER", "IGNITER"],
  );
});

test("UNCLASSED is a distinct string, not a real tier", () => {
  assert.equal(UNCLASSED, "UNCLASSED");
  assert.ok(!CLASS_TIERS.includes(UNCLASSED));
});

test("classify() returns UNCLASSED for the all-null degenerate case", () => {
  assert.equal(classify(null, null), UNCLASSED);
  assert.equal(classify(undefined, undefined), UNCLASSED);
});

test("classify() returns a real tier for normal inputs", () => {
  assert.equal(classify(2000, 3), "TRANSMITTER");
  assert.equal(classify(0, 1.5), "ARCH+");
  assert.equal(classify(0, -1), "IGNITER");
});

test("MCP output schemas use the canonical class enum (no legacy 3-tier, no extras)", () => {
  // The exported CLASS_ENUM must EQUAL [...CLASS_TIERS, UNCLASSED] — not just
  // include them. An extra bogus tier in the enum would silently pass an
  // inclusion-only check; equality catches it.
  assert.deepEqual(
    CLASS_ENUM,
    [...CLASS_TIERS, UNCLASSED],
    "CLASS_ENUM must be exactly [...CLASS_TIERS, UNCLASSED] — no extra or missing values",
  );
  // Every output schema that declares a `class` enum must use CLASS_ENUM
  // (verified by import in _schemas.mjs). Spot-check CASCADE_OUTPUT as the
  // canonical example — its enum IS CLASS_ENUM (same reference).
  assert.strictEqual(
    CASCADE_OUTPUT.properties.class.enum,
    CLASS_ENUM,
    "CASCADE_OUTPUT.class.enum must be the CLASS_ENUM reference, not a copy",
  );
  // Legacy 3-tier values must NOT appear anywhere in the canonical enum.
  for (const legacy of ["Burner", "Builder", "10xer"]) {
    assert.ok(!CLASS_ENUM.includes(legacy), `CLASS_ENUM still carries legacy "${legacy}"`);
  }
});

test("resources/class-tiers.md documents every canonical tier + UNCLASSED", () => {
  const md = readFileSync(
    fileURLToPath(new URL("../resources/class-tiers.md", import.meta.url)),
    "utf8",
  );
  for (const t of CLASS_TIERS) {
    assert.ok(
      md.includes(`## ${t}`),
      `class-tiers.md missing section for tier "${t}"`,
    );
  }
  assert.ok(md.includes("## UNCLASSED"), "class-tiers.md missing UNCLASSED section");
  // Legacy 3-tier names should not be presented as current tiers.
  assert.ok(
    !/^## (Burner|Builder|10xer)/m.test(md),
    "class-tiers.md still documents the legacy 3-tier taxonomy as current",
  );
});
