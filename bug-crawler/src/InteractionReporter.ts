// Playwright reporter for capturing interaction events
// Hooks into Playwright's test execution to record all user interactions

import { Reporter, FullResult, TestCase, TestResult } from "@playwright/test/reporter";

export interface InteractionRecord {
  testId: string;
  interactions: Array<{
    type: string;
    selector?: string;
    text?: string;
    timestamp: number;
    duration?: number;
    error?: string;
    success: boolean;
  }>;
}

class InteractionReporter implements Reporter {
  private recordings = new Map<string, InteractionRecord>();
  private currentTest?: { id: string; startTime: number };

  onBegin(config: any, suite: any) {
    // Test run started
  }

  onTestBegin(test: TestCase, result: TestResult) {
    this.currentTest = { id: test.id, startTime: Date.now() };
    this.recordings.set(test.id, { testId: test.id, interactions: [] });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // Test ended
  }

  onEnd(result: FullResult) {
    // All tests ended - would need to write to a file or send to server
  }

  getRecordings(): Map<string, InteractionRecord> {
    return this.recordings;
  }
}

export { InteractionReporter };
