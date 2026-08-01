import { LlmProvider } from "./types.js";
import { mockProvider } from "./mockProvider.js";
import { makeAnthropicProvider } from "./anthropicProvider.js";

const useMock = process.env.USE_MOCK_LLM !== "false"; // default true
const apiKey = process.env.ANTHROPIC_API_KEY;

export const llm: LlmProvider =
  !useMock && apiKey ? makeAnthropicProvider(apiKey) : mockProvider;

console.log(`[llm] using provider: ${llm.name}${!useMock && !apiKey ? " (fell back to mock: no ANTHROPIC_API_KEY set)" : ""}`);
