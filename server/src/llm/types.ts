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
}
