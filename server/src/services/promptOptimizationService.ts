import crypto from "crypto";

export interface OptimizationConfig {
  maxPromptLength: number;
  compressionRatio: number;
  templateBased: boolean;
  fewShotExamples: number;
}

export interface PromptMetadata {
  originalLength: number;
  compressedLength: number;
  ratio: number;
  tokensEstimated: number;
  savedTokens: number;
  strategy: string;
}

const DEFAULT_CONFIG: OptimizationConfig = {
  maxPromptLength: 2000,
  compressionRatio: 0.4,
  templateBased: true,
  fewShotExamples: 3,
};

const PROMPT_TEMPLATES = {
  smoke: `Verify basic page functionality:
- Page loads correctly
- No console errors
- Navigation works`,

  regression: `Check for regressions:
- Element visibility unchanged
- Functionality preserved
- Performance acceptable`,

  api: `Validate API endpoint:
- Correct status code
- Response schema valid
- Data consistency`,

  flow: `Test user flow:
- Steps complete in order
- State changes correct
- No errors occur`,

  performance: `Measure performance:
- Load time acceptable
- Memory usage normal
- No memory leaks`,

  security: `Check security:
- No sensitive data exposed
- CORS headers correct
- XSS protections active`,
};

const FEW_SHOT_EXAMPLES = {
  smoke: [
    {
      input: "E-commerce homepage",
      output: "Test: Page loads, hero image visible, navigation menu clickable, search bar functional, add-to-cart button present",
    },
    {
      input: "SaaS login form",
      output: "Test: Form renders, email input focusable, password field masks input, submit button clickable, forgot-password link present",
    },
    {
      input: "Blog post page",
      output: "Test: Post content visible, author info present, comments section loads, social share buttons functional",
    },
  ],

  regression: [
    {
      input: "Homepage after CSS update",
      output: "Verify: Header unchanged, hero section layout preserved, button styles match, footer spacing correct",
    },
    {
      input: "API response format change",
      output: "Check: Response keys present, data types match, null handling consistent, error format unchanged",
    },
  ],

  api: [
    {
      input: "GET /users/:id endpoint",
      output: "Validate: Response 200, user object present, id/name/email fields exist, timestamps valid",
    },
    {
      input: "POST /users endpoint",
      output: "Verify: Response 201, new user id present, created_at timestamp set, returns full user object",
    },
  ],
};

export function generateOptimizedPrompt(
  pageType: "smoke" | "regression" | "api" | "flow" | "performance" | "security" = "smoke",
  scenario: string = ""
): string {
  const template = PROMPT_TEMPLATES[pageType] || PROMPT_TEMPLATES.smoke;
  const compressed = compressPrompt(`${template}\n\nContext: ${scenario}`);
  return compressed;
}

export function compressPrompt(longPrompt: string): string {
  const lines = longPrompt.split("\n");
  const filtered = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("#"));

  const compressed = filtered.join(" ");
  return compressed.substring(0, DEFAULT_CONFIG.maxPromptLength);
}

export function injectFewShotExamples(
  prompt: string,
  examples?: Array<{ input: string; output: string }>
): string {
  if (!examples || examples.length === 0) {
    return prompt;
  }

  const exampleText = examples
    .slice(0, DEFAULT_CONFIG.fewShotExamples)
    .map((ex) => `Input: ${ex.input}\nOutput: ${ex.output}`)
    .join("\n\n");

  return `${prompt}\n\nExamples:\n${exampleText}`;
}

export function validatePrompt(prompt: string): boolean {
  return (
    prompt.length > 10 &&
    prompt.length <= 32000 &&
    prompt.split(" ").length > 2
  );
}

export function tokenCountEstimate(prompt: string): number {
  return Math.ceil(prompt.split(/\s+/).length * 1.3);
}

export function optimizePromptWithTemplate(
  pageType: string,
  context: string
): { optimized: string; metadata: PromptMetadata } {
  const original = `Generate comprehensive test cases for ${pageType} page: ${context}`;
  const template = PROMPT_TEMPLATES[pageType as keyof typeof PROMPT_TEMPLATES] || PROMPT_TEMPLATES.smoke;
  
  let optimized = template;
  if (context.length > 0) {
    optimized += `\n\nSpecific context: ${context.substring(0, 200)}`;
  }

  const originalTokens = tokenCountEstimate(original);
  const compressedTokens = tokenCountEstimate(optimized);

  const metadata: PromptMetadata = {
    originalLength: original.length,
    compressedLength: optimized.length,
    ratio: optimized.length / original.length,
    tokensEstimated: compressedTokens,
    savedTokens: Math.max(0, originalTokens - compressedTokens),
    strategy: "template-based",
  };

  return { optimized, metadata };
}

export function optimizePromptWithCompression(
  prompt: string
): { optimized: string; metadata: PromptMetadata } {
  const compressed = compressPrompt(prompt);
  const originalTokens = tokenCountEstimate(prompt);
  const compressedTokens = tokenCountEstimate(compressed);

  const metadata: PromptMetadata = {
    originalLength: prompt.length,
    compressedLength: compressed.length,
    ratio: compressed.length / prompt.length,
    tokensEstimated: compressedTokens,
    savedTokens: Math.max(0, originalTokens - compressedTokens),
    strategy: "compression",
  };

  return { optimized: compressed, metadata };
}

export function optimizePromptWithExamples(
  prompt: string,
  pageType: "smoke" | "regression" | "api" | "flow" | "performance" | "security" = "smoke"
): { optimized: string; metadata: PromptMetadata } {
  const examples = FEW_SHOT_EXAMPLES[pageType as keyof typeof FEW_SHOT_EXAMPLES] || [];
  const enhanced = injectFewShotExamples(prompt, examples);
  const originalTokens = tokenCountEstimate(prompt);
  const enhancedTokens = tokenCountEstimate(enhanced);

  const metadata: PromptMetadata = {
    originalLength: prompt.length,
    compressedLength: enhanced.length,
    ratio: enhanced.length / prompt.length,
    tokensEstimated: enhancedTokens,
    savedTokens: 0,
    strategy: "few-shot-examples",
  };

  return { optimized: enhanced, metadata };
}

export function selectOptimizationStrategy(
  prompt: string
): "template" | "compression" | "examples" | "hybrid" {
  if (prompt.length > 3000) {
    return "compression";
  }
  if (prompt.includes("examples") || prompt.includes("like")) {
    return "examples";
  }
  if (prompt.includes("generate") || prompt.includes("test")) {
    return "template";
  }
  return "hybrid";
}

export function getOptimizationConfig(): OptimizationConfig {
  return DEFAULT_CONFIG;
}

export function setOptimizationConfig(config: Partial<OptimizationConfig>): void {
  Object.assign(DEFAULT_CONFIG, config);
}

export function setPromptOptimizationFeatureFlag(enabled: boolean): void {
  process.env.PROMPT_OPTIMIZATION_ENABLED = String(enabled);
}

export function isPromptOptimizationEnabled(): boolean {
  return process.env.PROMPT_OPTIMIZATION_ENABLED !== "false";
}
