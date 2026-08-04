// class-tiers.test.mjs — guards the single-source-of-truth class-tier taxonomy.
//
// Run: node --test __tests__/class-tiers.test.mjs
//
// The 24-stage experience ladder (8 tiers × 3 sub-stages I/II/III) lives in
// analytics/cascade.mjs (CLASS_TIERS + SIGNAL_CLASSES + RS05_CLASS_THRESHOLDS +
// classify() + tierOf() + stageOf() + UNCLASSED). This test asserts every
// consumer matches the canonical lists so a future drift fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLASS_TIERS,
  SIGNAL_CLASSES,
  RS05_CLASS_THRESHOLDS,
  UNCLASSED,
  classify,
  tierOf,
  stageOf,
} from "../analytics/cascade.mjs";
import { CASCADE_OUTPUT, CLASS_ENUM } from "../tools/_schemas.mjs";

test("CLASS_TIERS is the 8 base tier names in cut order", () => {
  assert.deepEqual(
    CLASS_TIERS,
    ["ARCH+", "ARCH", "POWER", "BASE", "SEEKER", "REFINER", "BEARER", "IGNITER"],
  );
});

test("SIGNAL_CLASSES is the 24 sub-stage names in cut order", () => {
  assert.deepEqual(
    SIGNAL_CLASSES,
    [
      "ARCH+ I", "ARCH+ II", "ARCH+ III",
      "ARCH I", "ARCH II", "ARCH III",
      "POWER I", "POWER II", "POWER III",
      "BASE I", "BASE II", "BASE III",
      "SEEKER I", "SEEKER II", "SEEKER III",
      "REFINER I", "REFINER II", "REFINER III",
      "BEARER I", "BEARER II", "BEARER III",
      "IGNITER I", "IGNITER II", "IGNITER III",
    ],
  );
  assert.equal(SIGNAL_CLASSES.length, 24, "must be exactly 24 sub-stages");
});

test("RS05_CLASS_THRESHOLDS has 24 entries matching SIGNAL_CLASSES", () => {
  assert.equal(RS05_CLASS_THRESHOLDS.length, 24);
  for (let i = 0; i < 24; i++) {
    assert.equal(
      RS05_CLASS_THRESHOLDS[i].class,
      SIGNAL_CLASSES[i],
      `threshold[${i}] class name mismatch`,
    );
  }
  // Thresholds must be descending (first-match-wins scan order)
  for (let i = 1; i < 24; i++) {
    assert.ok(
      RS05_CLASS_THRESHOLDS[i].totalMin <= RS05_CLASS_THRESHOLDS[i - 1].totalMin,
      `threshold[${i}] not descending at index ${i}`,
    );
  }
  // Floor must be 0
  assert.equal(RS05_CLASS_THRESHOLDS[23].totalMin, 0, "IGNITER III floor must be 0");
});

test("UNCLASSED is a distinct string, not a real tier or sub-stage", () => {
  assert.equal(UNCLASSED, "UNCLASSED");
  assert.ok(!CLASS_TIERS.includes(UNCLASSED));
  assert.ok(!SIGNAL_CLASSES.includes(UNCLASSED));
});

test("classify() returns UNCLASSED for the null/non-finite degenerate case", () => {
  assert.equal(classify(null), UNCLASSED);
  assert.equal(classify(undefined), UNCLASSED);
  assert.equal(classify(NaN), UNCLASSED);
  assert.equal(classify(Infinity), UNCLASSED);
});

test("classify() returns the right sub-stage for known total-token values", () => {
  // Spot-check each tier's I sub-stage threshold
  assert.equal(classify(7068201104627), "ARCH+ I");
  assert.equal(classify(186207267611), "ARCH I");
  assert.equal(classify(39958782379), "POWER I");
  assert.equal(classify(13960345961), "BASE I");
  assert.equal(classify(5446673659), "SEEKER I");
  assert.equal(classify(2358346840), "REFINER I");
  assert.equal(classify(984078167), "BEARER I");
  assert.equal(classify(216393332), "IGNITER I");
  // Floor
  assert.equal(classify(0), "IGNITER III");
  assert.equal(classify(1), "IGNITER III");
  // MOSES total = 2,695,923,411 ≈ 2.7B → REFINER I (>= 2.36B, < 5.4B SEEKER I)
  assert.equal(classify(2695923411), "REFINER I");
});

test("tierOf() extracts the base tier from sub-stage strings", () => {
  assert.equal(tierOf("ARCH+ I"), "ARCH+");
  assert.equal(tierOf("ARCH+ II"), "ARCH+");
  assert.equal(tierOf("REFINER III"), "REFINER");
  assert.equal(tierOf("IGNITER III"), "IGNITER");
  // Non-sub-stage strings pass through
  assert.equal(tierOf(UNCLASSED), UNCLASSED);
  assert.equal(tierOf("ARCH+"), "ARCH+");
  assert.equal(tierOf(null), null);
});

test("stageOf() extracts the sub-stage roman numeral", () => {
  assert.equal(stageOf("ARCH+ I"), "I");
  assert.equal(stageOf("REFINER II"), "II");
  assert.equal(stageOf("IGNITER III"), "III");
  // Non-sub-stage strings return null
  assert.equal(stageOf(UNCLASSED), null);
  assert.equal(stageOf("ARCH+"), null);
  assert.equal(stageOf(null), null);
});

test("MCP output schemas use the canonical class enum (24 sub-stages + UNCLASSED)", () => {
  // The exported CLASS_ENUM must EQUAL [...SIGNAL_CLASSES, UNCLASSED]
  assert.deepEqual(
    CLASS_ENUM,
    [...SIGNAL_CLASSES, UNCLASSED],
    "CLASS_ENUM must be exactly [...SIGNAL_CLASSES, UNCLASSED]",
  );
  // Spot-check CASCADE_OUTPUT uses CLASS_ENUM by reference
  assert.strictEqual(
    CASCADE_OUTPUT.properties.class.enum,
    CLASS_ENUM,
    "CASCADE_OUTPUT.class.enum must be the CLASS_ENUM reference, not a copy",
  );
  // Legacy 3-tier values + TRANSMITTER (badge, not a class) must NOT appear
  for (const notClass of ["Burner", "Builder", "10xer", "TRANSMITTER"]) {
    assert.ok(!CLASS_ENUM.includes(notClass), `CLASS_ENUM carries "${notClass}" which is not a class stage`);
  }
});

test("resources/class-tiers.md documents every canonical tier + UNCLASSED", () => {
  const md = readFileSync(
    fileURLToPath(new URL("../resources/class-tiers.md", import.meta.url)),
    "utf8",
  );
  for (const t of CLASS_TIERS) {
    assert.ok(
      md.includes(`### ${t}`),
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
