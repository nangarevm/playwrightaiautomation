// Module 9 -- FR-9.5/FR-9.6/FR-9.7: a lightweight, dependency-free stand-in for a
// unified LLM gateway (the SRS names LiteLLM/GPTCache/LLMLingua as reference
// implementations of this pattern). This module implements the same three
// behaviors natively so the platform has no new external service dependency:
//   - FR-9.5 semantic caching: near-duplicate requests (e.g. structurally similar
//     screens/tickets) are served from an in-process cache instead of a new LLM call.
//   - FR-9.6 prompt compression: large inputs are shrunk before submission by
//     collapsing redundant whitespace/duplicate lines, which measurably lowers
//     token count without discarding unique content.
//   - FR-9.7 cost-aware routing: simpler generation tasks are routed to a
//     lower-cost model tier; every routing decision (and any FR-9.4 failover) is
//     logged to llm_usage_log for the FR-6.10 usage/cost dashboard.
//
// Token counts are estimated via the common ~4-chars-per-token heuristic (no
// tokenizer dependency); this is an approximation, consistent with FR-6.10's
// "estimated cost" framing.

import { nanoid } from "nanoid";
import { db } from "../db.js";
import type { ModelTier } from "../llm/modelConfig.js";
import { getMaxInputChars } from "../llm/modelConfig.js";

export type { ModelTier } from "../llm/modelConfig.js";
export type LlmCallType = "test_case_generation" | "script_generation" | "exploratory_decision";

// $/MTok, matching the SRS 13.5 worked example (Claude Sonnet 5 introductory
// pricing) for the primary tier; the economy tier models a materially cheaper
// model, consistent with FR-9.7's "route simpler tasks to a lower-cost model".
const PRICING_USD_PER_MTOK: Record<ModelTier, { input: number; output: number }> = {
  primary: { input: 2, output: 10 },
  economy: { input: 0.25, output: 1.25 },
};

// Fuzzy (Jaccard-similarity) cache matching is safe for test-case generation --
// worst case, a near-duplicate description gets a slightly-off but still
// plausible title/rationale back. It is NOT safe for script_generation: the
// cached response is real Playwright code with a specific field's actual
// locators/labels baked in (e.g. page.getByLabel('Email')). A "near-duplicate"
// scenario that differs only in which field/page it targets (very common
// across the AI Crawler's templated per-field/per-form scenarios -- "Verify
// Contact Form rejects an invalid email in 'Email'" vs. "...in 'Phone'") would
// return code that clicks/fills the WRONG element: a token-savings "win" that
// silently produces an incorrect automation script and a false sense of
// coverage. So script_generation only cache-hits on an exact (1.0) match of
// its normalized prompt -- still a real, correctness-safe token saving for
// genuine duplicates (the same field pattern re-crawled unchanged, or the
// same field/form appearing verbatim on more than one page).
const CACHE_SIMILARITY_THRESHOLD: Record<LlmCallType, number> = {
  test_case_generation: 0.82,
  script_generation: 1,
  // Phase 4c: exact match only, same reasoning as script_generation -- a
  // fuzzy-matched cache hit could return a decision naming an actionId that
  // doesn't exist in THIS call's actual availableActions list (each state's
  // candidate actions are effectively unique), which the caller would then
  // have to fall back from anyway. An exact match is still a real savings
  // for a genuinely repeated state (e.g. re-visiting the same page shape).
  exploratory_decision: 1,
};
const CACHE_MAX_ENTRIES = 200;
const COMPRESSION_TRIGGER_CHARS = 1200; // only compress inputs large enough for it to matter (FR-9.6: "large inputs")

const TRUNCATION_MARKER = (omitted: number) =>
  `\n\n[... ${omitted} characters omitted to stay within the LLM input budget; beginning and end preserved ...]\n\n`;

// FR-9.6 extension: very large document inputs are head/tail-truncated before
// compression and submission. Keeps the start (context/title) and end (recent
// requirements) while dropping the middle bulk that blows up token count.
export function truncateLargeInput(
  text: string,
  maxChars: number = getMaxInputChars()
): { truncated: string; wasTruncated: boolean } {
  if (text.length <= maxChars) return { truncated: text, wasTruncated: false };

  const marker = TRUNCATION_MARKER(text.length - maxChars);
  const bodyBudget = maxChars - marker.length;
  const headLen = Math.floor(bodyBudget * 0.7);
  const tailLen = bodyBudget - headLen;
  const truncated = text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  return { truncated, wasTruncated: true };
}

// Full pre-gateway pipeline: truncate oversized inputs, then dedupe/compress lines.
export function preparePromptForLlm(text: string): {
  prepared: string;
  wasTruncated: boolean;
  wasCompressed: boolean;
} {
  const { truncated, wasTruncated } = truncateLargeInput(text);
  const { compressed, wasCompressed } = compressPrompt(truncated);
  return { prepared: compressed, wasTruncated, wasCompressed: wasCompressed || wasTruncated };
}

interface CacheEntry<T> {
  callType: LlmCallType;
  tokenSet: Set<string>;
  response: T;
}

const semanticCache: CacheEntry<any>[] = [];

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeToTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// FR-9.5: return a cached response for a structurally near-duplicate prior
// request of the same call type, or null on a cache miss.
function findCacheHit<T>(callType: LlmCallType, prompt: string): T | null {
  const candidateTokens = normalizeToTokenSet(prompt);
  const threshold = CACHE_SIMILARITY_THRESHOLD[callType];
  for (const entry of semanticCache) {
    if (entry.callType !== callType) continue;
    if (jaccardSimilarity(candidateTokens, entry.tokenSet) >= threshold) {
      return entry.response as T;
    }
  }
  return null;
}

function storeInCache<T>(callType: LlmCallType, prompt: string, response: T) {
  semanticCache.push({ callType, tokenSet: normalizeToTokenSet(prompt), response });
  if (semanticCache.length > CACHE_MAX_ENTRIES) semanticCache.shift(); // simple LRU-by-insertion eviction
}

// FR-9.6: collapse redundant whitespace/duplicate lines in large inputs before
// LLM submission. Deliberately conservative -- it never removes a line that
// isn't an exact duplicate of one already kept, so unique content is preserved.
export function compressPrompt(text: string): { compressed: string; wasCompressed: boolean } {
  if (text.length < COMPRESSION_TRIGGER_CHARS) return { compressed: text, wasCompressed: false };

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[ \t]+/g, " ").trimEnd();
    if (line.trim() === "") continue;
    if (seen.has(line)) continue; // drop exact duplicate lines (repeated boilerplate)
    seen.add(line);
    lines.push(line);
  }
  const compressed = lines.join("\n");
  return { compressed, wasCompressed: compressed.length < text.length };
}

// FR-9.7: route simpler generation tasks to a lower-cost model tier. Uses input
// size and (when known) test-case category as the complexity signal -- short
// inputs and Negative/Edge Case cases are cheaper to get right and don't need
// the primary model.
//
// Single-QA cost-saving mode (Settings) raises the length threshold from the
// base 400 chars to org_settings.economy_tier_length_threshold (default 1200)
// when enabled, routing more calls to the cheap tier -- a solo QA trades a
// little quality on longer inputs for lower cost/latency on most calls. Off
// by default, so existing behavior is unchanged unless a user opts in.
function getEconomyLengthThreshold(): number {
  try {
    const row = db.prepare("SELECT cost_saving_mode, economy_tier_length_threshold FROM org_settings WHERE id = 1").get() as
      | { cost_saving_mode: number; economy_tier_length_threshold: number }
      | undefined;
    if (!row || !row.cost_saving_mode) return 400;
    return row.economy_tier_length_threshold || 1200;
  } catch {
    return 400; // best-effort -- never let a settings-read failure break routing
  }
}

export function chooseModelTier(promptOrCategory: string, category?: string): ModelTier {
  if (category === "Negative" || category === "Edge Case") return "economy";
  if (promptOrCategory.length < getEconomyLengthThreshold()) return "economy";
  return "primary";
}

function costForTier(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const rate = PRICING_USD_PER_MTOK[tier];
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

interface UsageLogInput {
  callType: LlmCallType;
  inputId?: string | null;
  provider: string;
  modelTier: ModelTier;
  cacheHit: boolean;
  compressed: boolean;
  failoverUsed: boolean;
  inputTokensBefore: number;
  inputTokensAfter: number;
  outputTokens: number;
}

function logUsage(entry: UsageLogInput) {
  // Cost actually incurred (0 on a cache hit -- no LLM call was made).
  const costUsd = entry.cacheHit ? 0 : costForTier(entry.modelTier, entry.inputTokensAfter, entry.outputTokens);
  // What it would have cost with none of the FR-9.5/9.6/9.7 optimizations applied:
  // always the primary tier, uncompressed input, and no cache hit -- this is the
  // baseline the FR-6.10 dashboard compares "savings attributable to caching and
  // model routing" against.
  const costWithoutOptimization = costForTier("primary", entry.inputTokensBefore, entry.outputTokens);

  db.prepare(`
    INSERT INTO llm_usage_log
      (id, call_type, input_id, provider, model_tier, cache_hit, compressed, failover_used,
       input_tokens_before, input_tokens_after, output_tokens, cost_usd, cost_usd_without_optimization, created_at)
    VALUES (@id, @call_type, @input_id, @provider, @model_tier, @cache_hit, @compressed, @failover_used,
       @input_tokens_before, @input_tokens_after, @output_tokens, @cost_usd, @cost_usd_without_optimization, @created_at)
  `).run({
    id: nanoid(10),
    call_type: entry.callType,
    input_id: entry.inputId ?? null,
    provider: entry.provider,
    model_tier: entry.modelTier,
    cache_hit: entry.cacheHit ? 1 : 0,
    compressed: entry.compressed ? 1 : 0,
    failover_used: entry.failoverUsed ? 1 : 0,
    input_tokens_before: entry.inputTokensBefore,
    input_tokens_after: entry.inputTokensAfter,
    output_tokens: entry.outputTokens,
    cost_usd: costUsd,
    cost_usd_without_optimization: costWithoutOptimization,
    created_at: new Date().toISOString(),
  });
}

// Orchestrates FR-9.5 (cache) + FR-9.6 (compression) + FR-9.7 (routing) around a
// single LLM generation call, and records the outcome via logUsage for FR-6.10.
// `run` is the actual provider call (already wrapped in FR-9.3 retry/degraded-mode
// and, when `onFailover` is supplied, FR-9.4 failover upstream of this function).
export async function withLlmGateway<T>(
  callType: LlmCallType,
  opts: { inputId?: string | null; provider: string; prompt: string; category?: string; failoverUsed?: boolean; onCompressionResolved?: (wasCompressed: boolean) => void },
  run: (preparedPrompt: string, tier: ModelTier) => Promise<{ result: T; outputText: string }>
): Promise<T> {
  const inputTokensBefore = estimateTokens(opts.prompt);
  const { prepared, wasTruncated, wasCompressed } = preparePromptForLlm(opts.prompt);
  // FR-9.6: let the caller tag output records when any input-shrinking ran.
  opts.onCompressionResolved?.(wasCompressed || wasTruncated);
  const inputTokensAfter = estimateTokens(prepared);
  const tier = chooseModelTier(prepared, opts.category);

  const cached = findCacheHit<T>(callType, prepared);
  if (cached !== null) {
    logUsage({
      callType,
      inputId: opts.inputId,
      provider: opts.provider,
      modelTier: tier,
      cacheHit: true,
      compressed: wasCompressed || wasTruncated,
      failoverUsed: opts.failoverUsed ?? false,
      inputTokensBefore,
      inputTokensAfter,
      outputTokens: 0,
    });
    return cached;
  }

  const { result, outputText } = await run(prepared, tier);

  logUsage({
    callType,
    inputId: opts.inputId,
    provider: opts.provider,
    modelTier: tier,
    cacheHit: false,
    compressed: wasCompressed || wasTruncated,
    failoverUsed: opts.failoverUsed ?? false,
    inputTokensBefore,
    inputTokensAfter,
    outputTokens: estimateTokens(outputText),
  });

  storeInCache(callType, prepared, result);
  return result;
}

// Records a script-generation call (FR-9.7 routing only -- no semantic cache/
// compression, since automation code isn't the "structurally similar
// screens/tickets" text FR-9.5/9.6 target) into the same usage log FR-6.10 reads.
export function logScriptGenerationUsage(inputId: string, tier: ModelTier, provider: string, promptText: string, outputText: string) {
  const inputTokens = estimateTokens(promptText);
  logUsage({
    callType: "script_generation",
    inputId,
    provider,
    modelTier: tier,
    cacheHit: false,
    compressed: false,
    failoverUsed: false,
    inputTokensBefore: inputTokens,
    inputTokensAfter: inputTokens,
    outputTokens: estimateTokens(outputText),
  });
}

// FR-6.10 (amended): aggregate usage/cost/savings for the dashboard.
export function getLlmUsageSummary() {
  const rows = db.prepare("SELECT * FROM llm_usage_log ORDER BY created_at DESC").all() as any[];

  const totalCalls = rows.length;
  const cacheHits = rows.filter((r) => r.cache_hit).length;
  const compressedCalls = rows.filter((r) => r.compressed).length;
  const failovers = rows.filter((r) => r.failover_used).length;
  const totalCostUsd = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalCostWithoutOptimizationUsd = rows.reduce((sum, r) => sum + r.cost_usd_without_optimization, 0);
  const savingsUsd = totalCostWithoutOptimizationUsd - totalCostUsd;
  const savingsPct = totalCostWithoutOptimizationUsd > 0 ? (savingsUsd / totalCostWithoutOptimizationUsd) * 100 : 0;

  const byTier = { primary: 0, economy: 0 } as Record<ModelTier, number>;
  for (const r of rows) byTier[r.model_tier as ModelTier] = (byTier[r.model_tier as ModelTier] ?? 0) + 1;

  return {
    total_calls: totalCalls,
    cache_hits: cacheHits,
    cache_hit_rate_pct: totalCalls > 0 ? (cacheHits / totalCalls) * 100 : 0,
    compressed_calls: compressedCalls,
    failovers,
    total_cost_usd: Number(totalCostUsd.toFixed(4)),
    total_cost_without_optimization_usd: Number(totalCostWithoutOptimizationUsd.toFixed(4)),
    savings_usd: Number(savingsUsd.toFixed(4)),
    savings_pct: Number(savingsPct.toFixed(1)),
    calls_by_model_tier: byTier,
    recent: rows.slice(0, 25),
  };
}
