import Anthropic from "@anthropic-ai/sdk";
import { GeneratedTestCase, LlmProvider } from "./types.js";
import type { ModelTier, LlmProviderCallType } from "./modelConfig.js";
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

  async function createMessage(tier: ModelTier, callType: LlmProviderCallType, system: string, userContent: string) {
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

    // Phase 4c: the one place in this platform an LLM call picks an ACTION
    // rather than generating text/code. Output is constrained to a tiny JSON
    // object naming ONE of the caller-supplied candidate ids -- the caller
    // (exploratoryAgentService.ts) never trusts this alone: it validates the
    // id is actually in availableActions and enforces its own hard budget
    // regardless of what comes back here.
    async decideNextExploratoryAction(input, options): Promise<{ actionId: string; rationale: string }> {
      const tier: ModelTier = options?.tier ?? "economy"; // a small routing decision -- economy tier by default, per FR-9.7's own cost-aware-routing intent
      const system =
        "You are choosing the single highest-value next exploratory action on a web page under test, to surface real bugs. " +
        'Output ONLY a JSON object: {"actionId": "<id from the list, or the literal string \\"stop\\">", "rationale": "<one sentence>"}. ' +
        "No prose, no code fences. Prefer actions not already tried. Prefer actions plausibly related to areas where bugs were already found nearby (a broken flow often has more than one issue), " +
        'but do not repeat an identical prior action. If every listed action has already been tried, or none seem worth pursuing, respond with actionId "stop".';
      const userContent = [
        `Current URL: ${input.currentUrl}`,
        `Actions remaining in budget: ${input.actionsRemaining}`,
        `Already-tried action ids this session: ${input.alreadyTriedActionIds.join(", ") || "(none yet)"}`,
        `Bugs already found this session: ${input.priorBugsSummary.join("; ") || "(none yet)"}`,
        `Available actions:\n${input.availableActions.map((a) => `- id="${a.id}": ${a.description}`).join("\n")}`,
      ].join("\n");
      const msg = await createMessage(tier, "exploratory_decision", system, userContent);
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const jsonStr = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(jsonStr);
        return { actionId: String(parsed.actionId ?? "stop"), rationale: String(parsed.rationale ?? "") };
      } catch {
        // Malformed/unparseable response -- the caller's own validation
        // (actionId must be in availableActions) will treat this as "stop"
        // just as safely as an explicit stop would.
        return { actionId: "stop", rationale: "Could not parse the model's response." };
      }
    },

    // Master-prompt §7: the one place in this platform an LLM call looks at
    // actual image bytes. Layered on top of the deterministic pixel-diff --
    // this NEVER decides whether a finding exists (screensService's
    // pixelmatch threshold already did), only annotates it with a classification
    // of likely-real-regression vs. likely-dynamic-content-noise, always
    // presented as inference (see bugConfidenceService's use of this result).
    async analyzeVisualDiff(input, options): Promise<{ isLikelyRealRegression: boolean; reasoning: string }> {
      const tier: ModelTier = options?.tier ?? "economy";
      const system =
        "You are looking at a BEFORE and AFTER screenshot of the same web page, which a pixel-diff tool has already flagged as differing. " +
        "Decide whether the visual difference looks like a REAL UI regression (broken layout, missing/moved element, changed styling, broken image) " +
        "versus LIKELY NOISE from dynamic content (a timestamp, a live counter, an ad, an animation frame, a carousel position, randomized sample data). " +
        'Output ONLY a JSON object: {"isLikelyRealRegression": true|false, "reasoning": "<one sentence>"}. No prose, no code fences.';
      const userContent = `Pixel-diff was ${input.diffPercentage}% (configured threshold: ${input.thresholdPercent}%). The first image is BEFORE, the second is AFTER.`;
      const model = getModelForTier(tier);
      const max_tokens = getMaxTokensForTier(tier, "visual_diff_reasoning");
      const msg = await client.messages.create({
        model,
        max_tokens,
        system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userContent },
              { type: "image", source: { type: "base64", media_type: "image/png", data: input.beforeImageBase64 } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: input.afterImageBase64 } },
            ],
          },
        ],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const jsonStr = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(jsonStr);
        return { isLikelyRealRegression: Boolean(parsed.isLikelyRealRegression), reasoning: String(parsed.reasoning ?? "") };
      } catch {
        // Unparseable response -- default to NOT claiming a real regression
        // (the deterministic pixel-diff finding still stands on its own;
        // this only fails to add a confident annotation, never suppresses it).
        return { isLikelyRealRegression: false, reasoning: "Could not parse the model's response." };
      }
    },
  };
}
