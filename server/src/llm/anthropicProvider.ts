import Anthropic from "@anthropic-ai/sdk";
import { GeneratedTestCase, LlmProvider } from "./types.js";

// Real LLM-backed provider. Only used when ANTHROPIC_API_KEY is set and
// USE_MOCK_LLM=false. FR-9.2 sanitization happens upstream in
// services/safetyService.ts (applied to every provider, not just this one) --
// inputText arriving here is already sanitized.

export function makeAnthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  return {
    name: "anthropic",

    async generateTestCases(inputText: string): Promise<GeneratedTestCase[]> {
      // Trimmed to the minimum instruction needed to constrain output shape --
      // every word here is billed as input tokens on every single call, so
      // this is a direct, guaranteed token reduction (unlike Anthropic's
      // native prompt-cache, which only activates above a ~1024-token minimum
      // this prompt is nowhere near, so it wouldn't help here).
      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system:
          "Experienced QA engineer, not a template engine. Output ONLY a JSON array of test cases (no prose/fences). " +
          "Fields per item: title, category (Smoke|Regression|Functional|Edge Case|Negative|API), steps (string[]), " +
          "expected_result, confidence_score (0-1), source_rationale. Phrase titles/steps like a human QA plan " +
          "(e.g. 'Verify login fails with an incorrect password'), not a mechanical field-by-field template.",
        messages: [{ role: "user", content: inputText }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const jsonStr = text.replace(/```json|```/g, "").trim();
      return JSON.parse(jsonStr) as GeneratedTestCase[];
    },

    async generatePlaywrightScript(testCase): Promise<string> {
      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system:
          "Generate a runnable Playwright TypeScript test. Prefer getByRole/getByLabel over CSS/XPath. " +
          "Page Object where sensible. Output ONLY code, no prose/fences.",
        messages: [
          {
            role: "user",
            content: `Title: ${testCase.title}\nSteps:\n${testCase.steps
              .map((s) => `- ${s}`)
              .join("\n")}\nExpected: ${testCase.expected_result}\n\nTarget URL from process.env.TARGET_URL.`,
          },
        ],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      return text.replace(/```typescript|```ts|```/g, "").trim();
    },
  };
}
