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
      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system:
          "You are an experienced QA engineer writing test cases by hand, not a template engine. Given a " +
          "description of an application or feature, output ONLY a JSON array of test cases, no prose, no " +
          "markdown fences. Each item must have: title (string), category (one of 'Smoke','Regression'," +
          "'Functional','Edge Case','Negative','API'), steps (array of strings), expected_result (string), " +
          "confidence_score (0-1 float), source_rationale (string explaining what in the input drove this " +
          "test case). Write titles and steps the way a human QA engineer actually phrases them in a real " +
          "test plan (e.g. 'Verify login fails with an incorrect password', not 'Submit Login Form with " +
          "field Password = invalid') -- natural, concise language, not a mechanical field-by-field template.",
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
          "You generate runnable Playwright TypeScript test scripts. Use accessibility-first locators " +
          "(getByRole/getByLabel) over CSS/XPath. Structure as a lightweight Page Object where sensible. " +
          "Output ONLY the code, no prose, no markdown fences.",
        messages: [
          {
            role: "user",
            content: `Test case title: ${testCase.title}\nSteps:\n${testCase.steps
              .map((s) => `- ${s}`)
              .join("\n")}\nExpected result: ${testCase.expected_result}\n\nTarget URL should come from process.env.TARGET_URL.`,
          },
        ],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      return text.replace(/```typescript|```ts|```/g, "").trim();
    },
  };
}
