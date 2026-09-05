// Phase 3a -- Deterministic field-type-aware mutation (master prompt #8/#9).
// Upgrades, rather than replaces, the existing negative-testing generation:
// crawler/scenarios.ts already generates one "invalid format" scenario per
// email/number/tel/url field, but its step text was vague ("enters a value
// that isn't a valid email") with no concrete value a human/automation could
// actually type. This module classifies a crawler-captured ElementRecord
// (which already carries `inputType` from the discovered HTML5 input type
// attribute -- see crawler/types.ts) into a mutation strategy and generates a
// concrete, deterministic boundary/negative value set for it, the same way
// this codebase's other analysis services (consoleErrorService,
// apiSchemaService) are hand-rolled rule engines rather than calling an LLM
// for something that's really just a lookup table.
//
// This feeds crawler/scenarios.ts's existing deterministic (non-LLM)
// scenario generation as concrete values, and is a structured hint the
// LLM-driven generationService.ts/mockProvider.ts path could equally consume
// for a form captured outside the crawler (the same role traceability_context
// already plays there) -- it does not replace either existing generation path.
//
// FALSE-POSITIVE RISK: none directly -- this module only produces candidate
// input VALUES for a test step; it makes no claim about what the target app
// SHOULD do with them (that's still the scenario's own assertion text, e.g.
// "a format-validation error is shown"). The one thing to watch is scenario
// volume: a form with many format-typed fields could get many similar-
// looking negative scenarios. That's bounded the same way as everything else
// in scenarios.ts -- MAX_PER_FIELD_CATEGORY / MAX_COMBINATION_SCENARIOS caps.

import type { ElementRecord } from "../crawler/types.js";

export type FieldMutationStrategy = "email" | "number" | "tel" | "url" | "date" | "password" | "text" | "unmutable";

export interface MutationValue {
  /** Human-readable label for the boundary/negative case, e.g. "over-max-length" or "unicode/emoji". */
  label: string;
  /** The concrete value to type into the field. */
  value: string;
}

const UNMUTABLE_TYPES = new Set(["file", "checkbox", "radio", "range", "color", "hidden"]);

/** Classify a captured field into a mutation strategy. Pure, no I/O. */
export function classifyFieldMutationStrategy(field: Pick<ElementRecord, "type" | "inputType">): FieldMutationStrategy {
  if (field.type === "checkbox" || field.type === "dropdown") return "unmutable";
  if (field.inputType && UNMUTABLE_TYPES.has(field.inputType)) return "unmutable";
  if (field.inputType === "email") return "email";
  if (field.inputType === "number") return "number";
  if (field.inputType === "tel") return "tel";
  if (field.inputType === "url") return "url";
  if (field.inputType === "date") return "date";
  if (field.inputType === "password") return "password";
  return "text"; // plain text/textarea, or an unrecognized input type -- treat as free text
}

const LONG_STRING = "x".repeat(300);

// One deterministic value set per strategy -- every entry is a concrete,
// literal value (not a description of one), so a generated scenario step can
// say exactly what to type. Ordering is stable so callers picking "the first
// N" get consistent results across runs.
function valuesForStrategy(strategy: FieldMutationStrategy): MutationValue[] {
  switch (strategy) {
    case "email":
      return [
        { label: "invalid format", value: "not-an-email" },
        { label: "missing domain", value: "user@" },
        { label: "empty", value: "" },
        { label: "whitespace-only", value: "   " },
        { label: "over-max-length", value: `${LONG_STRING}@example.com` },
        { label: "unicode/emoji", value: "😀user@例え.jp" },
        { label: "sqli-like", value: "' OR '1'='1' --@example.com" },
      ];
    case "number":
      return [
        { label: "invalid format", value: "abc" },
        { label: "negative", value: "-1" },
        { label: "zero", value: "0" },
        { label: "decimal", value: "3.14" },
        { label: "extreme-large", value: "99999999999999999999" },
        { label: "empty", value: "" },
      ];
    case "tel":
      return [
        { label: "invalid format", value: "not-a-phone-number" },
        { label: "letters mixed in", value: "555-CALL-NOW" },
        { label: "empty", value: "" },
        { label: "extreme-large", value: "1".repeat(30) },
      ];
    case "url":
      return [
        { label: "invalid format", value: "not a url" },
        { label: "missing scheme", value: "example.com" },
        { label: "empty", value: "" },
        { label: "xss-like", value: "javascript:alert(1)" },
      ];
    case "date":
      return [
        { label: "invalid format", value: "31/31/9999" },
        { label: "non-date text", value: "not-a-date" },
        { label: "empty", value: "" },
      ];
    case "password":
      return [
        { label: "empty", value: "" },
        { label: "whitespace-only", value: "   " },
        { label: "over-max-length", value: LONG_STRING },
        { label: "unicode/emoji", value: "🔒パスワード" },
      ];
    case "text":
      return [
        { label: "empty", value: "" },
        { label: "whitespace-only", value: "   " },
        { label: "over-max-length", value: LONG_STRING },
        { label: "unicode/emoji", value: "😀🚀 テスト" },
        { label: "sqli-like", value: "' OR '1'='1' --" },
        { label: "xss-like", value: "<script>alert(1)</script>" },
      ];
    case "unmutable":
    default:
      return [];
  }
}

/** The full deterministic boundary/negative value set for a captured field. */
export function generateMutationValues(field: Pick<ElementRecord, "type" | "inputType">): MutationValue[] {
  return valuesForStrategy(classifyFieldMutationStrategy(field));
}

/**
 * A single representative "invalid format" value -- used to make an existing
 * one-scenario-per-format-field negative case concrete (e.g. "enters
 * 'not-an-email' into 'Email'" instead of the vague "enters a value that
 * isn't a valid email"). Falls back to a generic placeholder for a strategy
 * with no format-invalid concept (e.g. plain text has no "format" to violate).
 */
export function representativeInvalidValue(field: Pick<ElementRecord, "type" | "inputType">): string {
  const values = generateMutationValues(field);
  const invalidFormat = values.find((v) => v.label === "invalid format");
  return invalidFormat?.value ?? "an invalid value";
}

export interface FieldCombinationState {
  field: ElementRecord;
  state: "invalid" | "empty";
}

export interface FieldCombination {
  label: string;
  states: FieldCombinationState[];
}

// Bounds how many multi-field combination scenarios one form generates --
// same reasoning as scenarios.ts's own MAX_PER_FIELD_CATEGORY: a form with
// many mutable fields shouldn't produce a combinatorial explosion.
export const FIELD_COMBINATION_CONFIG = {
  maxCombinations: 3,
};

/**
 * Generates "field A invalid + field B empty, everything else valid"
 * combination scenarios for a multi-field form -- the gap the existing
 * one-field-at-a-time negative scenarios (scenarios.ts items 3/4) don't
 * cover: two simultaneously-wrong fields can surface validation bugs a
 * single-field case can't (e.g. a form that short-circuits on the first
 * error and never reports the second). Only meaningful with 2+ mutable
 * fields; returns [] otherwise.
 */
export function generateFieldCombinationMatrix(fields: ElementRecord[]): FieldCombination[] {
  const mutable = fields.filter((f) => classifyFieldMutationStrategy(f) !== "unmutable");
  if (mutable.length < 2) return [];

  const combos: FieldCombination[] = [];
  for (let i = 0; i < mutable.length && combos.length < FIELD_COMBINATION_CONFIG.maxCombinations; i++) {
    const j = (i + 1) % mutable.length;
    if (i === j) continue;
    const invalidField = mutable[i];
    const emptyField = mutable[j];
    combos.push({
      label: `${invalidField.label} invalid + ${emptyField.label} empty`,
      states: [
        { field: invalidField, state: "invalid" },
        { field: emptyField, state: "empty" },
      ],
    });
  }
  return combos;
}
