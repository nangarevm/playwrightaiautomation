// Interaction validation service
// Monitors and validates user interactions during test execution

export interface InteractionEvent {
  type: "click" | "input" | "submit" | "navigate" | "scroll" | "hover" | "focus" | "blur";
  elementType: string;
  elementSelector?: string;
  elementText?: string;
  timestamp: number;
  resultValue?: any;
  errorMessage?: string;
  duration?: number;
}

export interface InteractionValidation {
  event: InteractionEvent;
  isValid: boolean;
  violations: ValidationViolation[];
  warnings: ValidationWarning[];
  suggestions: string[];
}

export interface ValidationViolation {
  type: "error" | "accessibility" | "performance" | "behavior";
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  code?: string;
}

export interface ValidationWarning {
  type: string;
  message: string;
}

/**
 * Validates a click interaction
 */
export function validateClick(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "critical",
      message: `Click failed: ${interaction.errorMessage}`,
      code: "CLICK_FAILED",
    });
  }

  // Check if element is visible/enabled
  if (!interaction.elementSelector) {
    violations.push({
      type: "behavior",
      severity: "high",
      message: "Click element selector not captured",
      code: "MISSING_SELECTOR",
    });
  }

  // Check performance
  if (interaction.duration && interaction.duration > 5000) {
    violations.push({
      type: "performance",
      severity: "medium",
      message: `Click took ${interaction.duration}ms - longer than expected`,
      code: "SLOW_CLICK",
    });
  }

  return violations;
}

/**
 * Validates a form input interaction
 */
export function validateInput(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "high",
      message: `Input failed: ${interaction.errorMessage}`,
      code: "INPUT_FAILED",
    });
  }

  // Check if input has proper label
  if (!interaction.elementText && interaction.elementType === "input") {
    violations.push({
      type: "accessibility",
      severity: "medium",
      message: "Input field lacks associated label",
      code: "MISSING_LABEL",
    });
  }

  // Check if value was actually set
  if (!interaction.resultValue && interaction.elementType === "input") {
    violations.push({
      type: "behavior",
      severity: "high",
      message: "Input value was not set successfully",
      code: "VALUE_NOT_SET",
    });
  }

  return violations;
}

/**
 * Validates a form submission
 */
export function validateSubmit(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "critical",
      message: `Form submission failed: ${interaction.errorMessage}`,
      code: "SUBMIT_FAILED",
    });
  }

  // Check for submit button
  if (!interaction.elementSelector) {
    violations.push({
      type: "behavior",
      severity: "high",
      message: "Submit button not found",
      code: "SUBMIT_NOT_FOUND",
    });
  }

  // Check response time
  if (interaction.duration && interaction.duration > 10000) {
    violations.push({
      type: "performance",
      severity: "high",
      message: `Form submission took ${interaction.duration}ms - server may be slow`,
      code: "SLOW_SUBMISSION",
    });
  }

  return violations;
}

/**
 * Validates a navigation interaction
 */
export function validateNavigation(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "critical",
      message: `Navigation failed: ${interaction.errorMessage}`,
      code: "NAVIGATION_FAILED",
    });
  }

  // Check navigation time
  if (interaction.duration && interaction.duration > 30000) {
    violations.push({
      type: "performance",
      severity: "high",
      message: `Page navigation took ${interaction.duration}ms - page may be slow to load`,
      code: "SLOW_NAVIGATION",
    });
  }

  if (interaction.duration && interaction.duration > 5000 && interaction.duration <= 30000) {
    violations.push({
      type: "performance",
      severity: "medium",
      message: `Page navigation took ${interaction.duration}ms - consider optimization`,
      code: "SLOW_NAVIGATION_WARN",
    });
  }

  return violations;
}

/**
 * Validates a scroll interaction
 */
export function validateScroll(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "medium",
      message: `Scroll failed: ${interaction.errorMessage}`,
      code: "SCROLL_FAILED",
    });
  }

  // Check if element became visible after scroll
  if (interaction.resultValue === false) {
    violations.push({
      type: "behavior",
      severity: "medium",
      message: "Element was not visible after scrolling",
      code: "ELEMENT_NOT_VISIBLE",
    });
  }

  return violations;
}

/**
 * Validates a hover/focus interaction
 */
export function validateHoverFocus(interaction: InteractionEvent): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (interaction.errorMessage) {
    violations.push({
      type: "error",
      severity: "low",
      message: `Hover/focus action failed: ${interaction.errorMessage}`,
      code: "HOVER_FOCUS_FAILED",
    });
  }

  // Check for tooltip or popover appearance
  if (!interaction.resultValue) {
    violations.push({
      type: "behavior",
      severity: "low",
      message: "Expected UI change did not occur after interaction",
      code: "NO_UI_CHANGE",
    });
  }

  return violations;
}

/**
 * Main validation function - routes to specific validators
 */
export function validateInteraction(interaction: InteractionEvent): InteractionValidation {
  let violations: ValidationViolation[] = [];
  const warnings: ValidationWarning[] = [];
  const suggestions: string[] = [];

  switch (interaction.type) {
    case "click":
      violations = validateClick(interaction);
      break;
    case "input":
      violations = validateInput(interaction);
      break;
    case "submit":
      violations = validateSubmit(interaction);
      break;
    case "navigate":
      violations = validateNavigation(interaction);
      break;
    case "scroll":
      violations = validateScroll(interaction);
      break;
    case "hover":
    case "focus":
    case "blur":
      violations = validateHoverFocus(interaction);
      break;
  }

  // Generate suggestions based on violations
  violations.forEach((v) => {
    if (v.code === "SLOW_NAVIGATION") {
      suggestions.push("Consider optimizing server response time or using lazy loading for assets");
    }
    if (v.code === "SLOW_SUBMISSION") {
      suggestions.push("Check server-side processing time. Consider async operations or queuing");
    }
    if (v.code === "MISSING_LABEL") {
      suggestions.push("Add proper form labels for accessibility and better UX");
    }
    if (v.code === "MISSING_SELECTOR") {
      suggestions.push("Ensure the element has a unique, stable selector");
    }
  });

  const isValid = violations.filter((v) => v.severity === "critical" || v.severity === "high").length === 0;

  return {
    event: interaction,
    isValid,
    violations,
    warnings,
    suggestions,
  };
}

/**
 * Validates a sequence of interactions
 */
export function validateInteractionSequence(interactions: InteractionEvent[]): {
  validations: InteractionValidation[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    avgDuration: number;
    slowestInteraction?: InteractionEvent;
  };
} {
  const validations = interactions.map(validateInteraction);

  const durations = interactions.filter((i) => i.duration).map((i) => i.duration || 0);
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const slowest = interactions.reduce((a, b) => ((a.duration || 0) > (b.duration || 0) ? a : b), interactions[0]);

  return {
    validations,
    summary: {
      total: interactions.length,
      passed: validations.filter((v) => v.isValid).length,
      failed: validations.filter((v) => !v.isValid).length,
      warnings: validations.reduce((sum, v) => sum + v.warnings.length, 0),
      avgDuration,
      slowestInteraction: slowest,
    },
  };
}

/**
 * Identifies problematic interaction patterns
 */
export function detectInteractionPatterns(
  interactions: InteractionEvent[]
): {
  repeatedFailures: Array<{ type: string; count: number; selector?: string }>;
  performanceBottlenecks: InteractionEvent[];
  accessibilityIssues: InteractionEvent[];
  unexpectedBehaviors: InteractionEvent[];
} {
  const repeatedFailures: Map<string, number> = new Map();
  const performanceBottlenecks: InteractionEvent[] = [];
  const accessibilityIssues: InteractionEvent[] = [];
  const unexpectedBehaviors: InteractionEvent[] = [];

  for (const interaction of interactions) {
    // Track failures
    if (interaction.errorMessage) {
      const key = `${interaction.type}:${interaction.elementSelector || "unknown"}`;
      repeatedFailures.set(key, (repeatedFailures.get(key) || 0) + 1);
    }

    // Track performance issues
    if (
      (interaction.type === "navigate" && interaction.duration && interaction.duration > 5000) ||
      (interaction.type === "submit" && interaction.duration && interaction.duration > 3000) ||
      (interaction.type === "click" && interaction.duration && interaction.duration > 2000)
    ) {
      performanceBottlenecks.push(interaction);
    }

    // Track accessibility issues
    if (
      interaction.type === "input" &&
      !interaction.elementText &&
      !interaction.elementSelector?.includes("aria-label")
    ) {
      accessibilityIssues.push(interaction);
    }

    // Track unexpected behaviors
    if (interaction.type === "click" && interaction.resultValue === false) {
      unexpectedBehaviors.push(interaction);
    }
    if (interaction.type === "submit" && interaction.errorMessage?.includes("validation")) {
      unexpectedBehaviors.push(interaction);
    }
  }

  return {
    repeatedFailures: Array.from(repeatedFailures.entries())
      .map(([key, count]) => {
        const [type, selector] = key.split(":");
        return { type, count, selector: selector === "unknown" ? undefined : selector };
      })
      .filter((f) => f.count > 1),
    performanceBottlenecks,
    accessibilityIssues,
    unexpectedBehaviors,
  };
}

/**
 * Generates human-readable report of interaction validation
 */
export function generateInteractionReport(validations: InteractionValidation[]): string {
  const passed = validations.filter((v) => v.isValid).length;
  const failed = validations.filter((v) => !v.isValid).length;

  let report = `# Interaction Validation Report\n\n`;
  report += `## Summary\n`;
  report += `- Total Interactions: ${validations.length}\n`;
  report += `- Passed: ${passed}\n`;
  report += `- Failed: ${failed}\n\n`;

  if (failed > 0) {
    report += `## Failed Interactions\n\n`;
    validations.filter((v) => !v.isValid).forEach((v, idx) => {
      report += `### ${idx + 1}. ${v.event.type.toUpperCase()} - ${v.event.elementText || v.event.elementSelector || "unknown"}\n`;
      v.violations.forEach((violation) => {
        report += `- [${violation.severity.toUpperCase()}] ${violation.message}\n`;
      });
      if (v.suggestions.length > 0) {
        report += `**Suggestions:**\n`;
        v.suggestions.forEach((s) => {
          report += `- ${s}\n`;
        });
      }
      report += `\n`;
    });
  }

  return report;
}
