import Anthropic from "@anthropic-ai/sdk";
import { GeneratedTestCase, LlmProvider } from "./types.js";
import type { ModelTier } from "./modelConfig.js";
import { getMaxTokensForTier, getModelForTier } from "./modelConfig.js";

// Real LLM-backed provider. Only used when ANTHROPIC_API_KEY is set and
// USE_MOCK_LLM=false. FR-9.2 sanitization happens upstream in
// services/safetyService.ts (applied to every provider, not just this one) --
// inputText arriving here is already sanitized.

const TEST_CASE_SYSTEM =
  "Experienced QA engineer, not a template engine. Output ONLY a JSON array of test cases (no prose/fences). " +
  "Fields per item: title, category (Smoke|Regression|Functional|Edge Case|Negative|API), steps (string[]), " +
  "expected_result, confidence_score (0-1), source_rationale. Phrase titles/steps like a human QA plan " +
  "(e.g. 'Verify login fails with an incorrect password'), not a mechanical field-by-field template.\n\n" +
  "Coverage: don't stop at one happy-path case. For every distinct behavior, field, or flow named or implied " +
  "in the input, work through it from multiple angles and emit a separate test case per angle that actually " +
  "applies to that input (skip any that don't) -- positive/Smoke (the documented happy path), Negative " +
  "(wrong/invalid input, unauthorized action, unmet precondition), Edge Case (empty/boundary/max-length values, " +
  "unusual but valid input, rapid repeated actions), and Regression (a previously-specified behavior that a " +
  "related change could silently break). A short input describing one form or one flow should still normally " +
  "yield 4-8 cases, not 1-2, once positive/negative/edge angles are each considered.\n\n" +
  "Detail: steps must be concrete and independently reproducible by someone unfamiliar with the feature -- " +
  "name the exact field/button/label text, the exact value entered (e.g. 'Enter \"invalid@\" (missing domain) " +
  "in the Email field', not 'enter an invalid email'), and split multi-action instructions into separate step " +
  "strings. expected_result must state every observable outcome of the case, not just one -- UI state changed, " +
  "message/error text shown (verbatim where the input specifies it), data persisted or rejected, and any " +
  "side effect (redirect, email sent, record created) -- as full sentences, not a single fragment.";

function scriptSystemPrompt(language: string, framework: string): string {
  if (framework !== "playwright") {
    return `Generate a runnable ${framework} test in ${language}. Prefer accessible locators where possible. Output ONLY code, no prose/fences.`;
  }
  return (
    `Generate a runnable Playwright ${language} test. Prefer getByRole/getByLabel over CSS/XPath. ` +
    "Page Object where sensible. Output ONLY code, no prose/fences."
  );
}

function scriptFileExtension(language: string, framework: string): string {
  if (framework === "cypress") return "cy.js";
  if (framework === "selenium") return "selenium.js";
  if (language === "python") return "py";
  if (language === "javascript") return "spec.js";
  return "spec.ts";
}

function stripCodeFences(text: string, language: string): string {
  const langTag = language === "python" ? "python" : language === "javascript" ? "javascript|js" : "typescript|ts";
  return text.replace(new RegExp(`\`\`\`(?:${langTag})?`, "g"), "").replace(/```/g, "").trim();
}

export function makeAnthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  async function createMessage(tier: ModelTier, callType: "test_case_generation" | "script_generation", system: string, userContent: string) {
    const model = getModelForTier(tier);
    const max_tokens = getMaxTokensForTier(tier, callType);
    return client.messages.create({
      model,
      max_tokens,
      system,
      messages: [{ role: "user", content: userContent }],
    });
  }

  return {
    name: "anthropic",

    async generateTestCases(inputText: string, options?: { tier?: ModelTier }): Promise<GeneratedTestCase[]> {
      const tier: ModelTier = options?.tier ?? "primary";
      const msg = await createMessage(tier, "test_case_generation", TEST_CASE_SYSTEM, inputText);
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const jsonStr = text.replace(/```json|```/g, "").trim();
      return JSON.parse(jsonStr) as GeneratedTestCase[];
    },

    async generatePlaywrightScript(testCase, options): Promise<string> {
      const tier: ModelTier = options?.tier ?? "primary";
      const language = options?.language ?? "typescript";
      const framework = options?.framework ?? "playwright";
      const userContent =
        `Title: ${testCase.title}\nSteps:\n${testCase.steps.map((s) => `- ${s}`).join("\n")}\n` +
        `Expected: ${testCase.expected_result}\n\nTarget URL from process.env.TARGET_URL.`;
      const msg = await createMessage(tier, "script_generation", scriptSystemPrompt(language, framework), userContent);
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      return stripCodeFences(text, language);
    },

    // Real provider: one language/framework per LLM call (cost control).
    async generateAutomationArtifacts(testCase, options) {
      const language = options?.language ?? "typescript";
      const framework = options?.framework ?? "playwright";
      const code = await this.generatePlaywrightScript(testCase, { ...options, language, framework });
      return [
        {
          language,
          framework,
          code,
          fileName: `script.${scriptFileExtension(language, framework)}`,
        },
      ];
    },
  };
}
