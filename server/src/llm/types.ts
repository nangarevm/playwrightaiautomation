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

export interface LlmProvider {
  name: string;
  generateTestCases(inputText: string): Promise<GeneratedTestCase[]>;
  generatePlaywrightScript(testCase: {
    title: string;
    steps: string[];
    expected_result: string;
    category?: string;
  }, options?: { language?: "typescript" | "javascript" | "python"; framework?: "playwright" | "selenium" | "cypress"; apiSpecHint?: string }): Promise<string>;
  generateAutomationArtifacts?(testCase: {
    title: string;
    steps: string[];
    expected_result: string;
    category?: string;
  }, options?: { apiSpecHint?: string }): Promise<AutomationArtifacts[]>;
}
