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

export type LlmProviderCallType = "test_case_generation" | "script_generation" | "exploratory_decision" | "visual_diff_reasoning";

const MAX_TOKENS_DEFAULTS: Record<LlmProviderCallType, { primary: number; economy: number }> = {
  test_case_generation: { primary: 2000, economy: 1500 },
  script_generation: { primary: 1500, economy: 1200 },
  // Phase 4c: the exploratory decision response is a tiny structured
  // {actionId, rationale} object, not prose/code -- a much smaller budget suffices.
  exploratory_decision: { primary: 400, economy: 300 },
  // Master-prompt §7: a short classification + one-sentence reasoning.
  visual_diff_reasoning: { primary: 400, economy: 300 },
};

const MAX_TOKENS_ENV_KEYS: Record<LlmProviderCallType, { primary: string; economy: string }> = {
  test_case_generation: { primary: "LLM_MAX_TOKENS_TEST_PRIMARY", economy: "LLM_MAX_TOKENS_TEST_ECONOMY" },
  script_generation: { primary: "LLM_MAX_TOKENS_SCRIPT_PRIMARY", economy: "LLM_MAX_TOKENS_SCRIPT_ECONOMY" },
  exploratory_decision: { primary: "LLM_MAX_TOKENS_EXPLORE_PRIMARY", economy: "LLM_MAX_TOKENS_EXPLORE_ECONOMY" },
  visual_diff_reasoning: { primary: "LLM_MAX_TOKENS_VISUAL_PRIMARY", economy: "LLM_MAX_TOKENS_VISUAL_ECONOMY" },
};

export function getMaxTokensForTier(tier: ModelTier, callType: LlmProviderCallType): number {
  const fromEnv = process.env[MAX_TOKENS_ENV_KEYS[callType][tier]];
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  return MAX_TOKENS_DEFAULTS[callType][tier];
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
