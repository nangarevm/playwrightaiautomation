import type { ModelTier, ScriptLanguage } from "./modelConfig.js";

export interface LlmCallOptions {
  tier?: ModelTier;
  language?: ScriptLanguage;
  framework?: "playwright" | "selenium" | "cypress";
  apiSpecHint?: string;
}

export interface GeneratedTestCase {
  title: string;
  category: "Smoke" | "Regression" | "Functional" | "Edge Case" | "Negative" | "API";
  steps: string[];
  expected_result: string;
  confidence_score: number; // 0-1
  source_rationale: string;
  priority?: "Low" | "Medium" | "High";
}

export interface AutomationArtifacts {
  language: "typescript" | "javascript" | "python";
  framework: "playwright" | "selenium" | "cypress";
  code: string;
  fileName: string;
}

// Phase 4c: exploratory AI agent -- the one place in this platform an LLM
// call picks the next ACTION rather than generating text/code. Deliberately
// a narrow, structured request/response (a list of concrete candidate
// actions in, one chosen id + a short rationale out) rather than open-ended
// prose, so the caller (exploratoryAgentService.ts) can validate the answer
// mechanically and never has to parse free text to find out what to do.
export interface ExploratoryDecisionInput {
  currentUrl: string;
  availableActions: Array<{ id: string; description: string }>;
  alreadyTriedActionIds: string[];
  priorBugsSummary: string[];
  actionsRemaining: number;
}

export interface ExploratoryDecision {
  /** Must be one of availableActions[].id, or the literal "stop". Anything else is treated as "stop" by the caller. */
  actionId: string;
  rationale: string;
}

// Master-prompt §7: optional AI visual-diff reasoning, layered ON TOP OF
// (never replacing) screensService.ts's deterministic pixel-diff -- the
// pixel-diff still decides whether a finding exists at all; this only adds
// an annotation (never gates the finding's existence) distinguishing a
// likely-real visual regression from likely dynamic-content noise
// (timestamps/ads/counters/animations the mask-selector list didn't catch).
// Always an inference, per master prompt §19 -- callers must label it as
// such, never as confirmed fact.
export interface VisualDiffReasoningInput {
  beforeImageBase64: string;
  afterImageBase64: string;
  diffPercentage: number;
  thresholdPercent: number;
}

export interface VisualDiffReasoningResult {
  isLikelyRealRegression: boolean;
  reasoning: string;
}

export interface LlmProvider {
  name: string;
  generateTestCases(inputText: string, options?: Pick<LlmCallOptions, "tier">): Promise<GeneratedTestCase[]>;
  generatePlaywrightScript(
    testCase: {
      title: string;
      steps: string[];
      expected_result: string;
      category?: string;
    },
    options?: LlmCallOptions
  ): Promise<string>;
  /** Mock-only convenience; real providers generate one language per call via generatePlaywrightScript. */
  generateAutomationArtifacts?(
    testCase: {
      title: string;
      steps: string[];
      expected_result: string;
      category?: string;
    },
    options?: LlmCallOptions
  ): Promise<AutomationArtifacts[]>;
  /** Phase 4c: pick the next exploratory action. Every provider implements this -- exploratoryAgentService.ts never trusts the answer alone (see its own hard budget/validity enforcement). */
  decideNextExploratoryAction(input: ExploratoryDecisionInput, options?: Pick<LlmCallOptions, "tier">): Promise<ExploratoryDecision>;
  /** Master-prompt §7: classify a detected pixel-diff as likely-real vs. likely-noise. Every provider implements this; the mock provider's answer is a deterministic stand-in (no real vision), not a genuine image analysis. */
  analyzeVisualDiff(input: VisualDiffReasoningInput, options?: Pick<LlmCallOptions, "tier">): Promise<VisualDiffReasoningResult>;
}
