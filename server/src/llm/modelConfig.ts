// Central model-tier configuration for cost-aware multi-model routing (FR-9.7).
// Primary tier handles complex/long inputs; economy tier uses a cheaper model for
// simpler tasks while preserving the same output contract.

export type ModelTier = "primary" | "economy";

const DEFAULT_PRIMARY = "claude-sonnet-4-6";
const DEFAULT_ECONOMY = "claude-haiku-4-5";

export function getModelForTier(tier: ModelTier): string {
  if (tier === "economy") {
    return process.env.LLM_MODEL_ECONOMY?.trim() || DEFAULT_ECONOMY;
  }
  return process.env.LLM_MODEL_PRIMARY?.trim() || DEFAULT_PRIMARY;
}

export function getMaxTokensForTier(tier: ModelTier, callType: "test_case_generation" | "script_generation"): number {
  const defaults =
    callType === "test_case_generation"
      ? { primary: 2000, economy: 1500 }
      : { primary: 1500, economy: 1200 };
  const envKey =
    callType === "test_case_generation"
      ? tier === "primary"
        ? "LLM_MAX_TOKENS_TEST_PRIMARY"
        : "LLM_MAX_TOKENS_TEST_ECONOMY"
      : tier === "primary"
        ? "LLM_MAX_TOKENS_SCRIPT_PRIMARY"
        : "LLM_MAX_TOKENS_SCRIPT_ECONOMY";
  const fromEnv = process.env[envKey];
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  return defaults[tier];
}

export function getMaxInputChars(): number {
  const fromEnv = process.env.LLM_MAX_INPUT_CHARS;
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  return 24_000; // ~6k tokens at the 4-chars/token heuristic
}

export type ScriptLanguage = "typescript" | "javascript" | "python";

export function getDefaultScriptLanguage(): ScriptLanguage {
  const lang = process.env.LLM_DEFAULT_SCRIPT_LANGUAGE?.trim().toLowerCase();
  if (lang === "javascript" || lang === "python" || lang === "typescript") return lang;
  return "typescript";
}
