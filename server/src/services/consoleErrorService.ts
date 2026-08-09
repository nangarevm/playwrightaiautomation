// Console error deep-dive analysis service
// Parses, categorizes, and analyzes console errors from browser sessions

export interface ConsoleError {
  type: "error" | "warning" | "log" | "info" | "debug";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  url?: string;
}

export interface ParsedError {
  errorType: "ReferenceError" | "TypeError" | "SyntaxError" | "RangeError" | "AssertionError" | "NetworkError" | "SecurityError" | "Unknown";
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  category: "functional" | "security" | "performance" | "deprecation" | "other";
  source?: string;
  line?: number;
  originFunction?: string;
  stackTrace?: string[];
  suggestedFix?: string;
}

/**
 * Parses console error message and extracts error type
 */
export function parseErrorType(message: string): string {
  const errorPatterns = [
    /^ReferenceError:/,
    /^TypeError:/,
    /^SyntaxError:/,
    /^RangeError:/,
    /^AssertionError:/,
    /^NetworkError:/,
    /^SecurityError:/,
    /^URIError:/,
    /^EvalError:/,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(message)) {
      return message.split(":")[0];
    }
  }

  return "Unknown";
}

/**
 * Categorizes error based on content
 */
export function categorizeError(message: string, type: string): string {
  const lowerMsg = message.toLowerCase();

  // Security issues
  if (
    lowerMsg.includes("cors") ||
    lowerMsg.includes("cross-origin") ||
    lowerMsg.includes("security") ||
    lowerMsg.includes("csrf")
  ) {
    return "security";
  }

  // Performance issues
  if (
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("slow") ||
    lowerMsg.includes("performance") ||
    lowerMsg.includes("memory leak")
  ) {
    return "performance";
  }

  // Deprecation warnings
  if (
    lowerMsg.includes("deprecated") ||
    lowerMsg.includes("no longer supported") ||
    lowerMsg.includes("obsolete")
  ) {
    return "deprecation";
  }

  // Functional errors
  if (
    type.includes("Error") ||
    lowerMsg.includes("undefined") ||
    lowerMsg.includes("null") ||
    lowerMsg.includes("not a function")
  ) {
    return "functional";
  }

  return "other";
}

/**
 * Determines severity based on error type and message
 */
export function calculateSeverity(errorType: string, message: string): string {
  const lowerMsg = message.toLowerCase();

  // Critical: Security, crashes, hard errors
  if (
    errorType === "SecurityError" ||
    lowerMsg.includes("fatal") ||
    lowerMsg.includes("crash") ||
    lowerMsg.includes("exception")
  ) {
    return "critical";
  }

  // High: Functional errors
  if (
    errorType === "ReferenceError" ||
    errorType === "TypeError" ||
    errorType === "SyntaxError" ||
    lowerMsg.includes("undefined is not") ||
    lowerMsg.includes("cannot read property")
  ) {
    return "high";
  }

  // Medium: Warnings and deprecations
  if (
    errorType === "Unknown" ||
    lowerMsg.includes("warning") ||
    lowerMsg.includes("deprecated")
  ) {
    return "medium";
  }

  // Low: Info and debug
  return "low";
}

/**
 * Extracts function name from stack trace
 */
export function extractFunctionName(stackTrace: string): string | undefined {
  const lines = stackTrace.split("\n");
  for (const line of lines) {
    const match = line.match(/at\s+(\w+|\w+\.\w+)/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Parses stack trace into array of call frames
 */
export function parseStackTrace(stackTrace: string): string[] {
  if (!stackTrace) return [];

  return stackTrace
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, 10); // First 10 frames
}

/**
 * Generates suggested fix based on error analysis
 */
export function generateSuggestedFix(
  errorType: string,
  message: string,
  category: string
): string {
  if (errorType === "ReferenceError") {
    return "Check that the variable is defined before use. Look for typos in variable names.";
  }

  if (errorType === "TypeError" && message.includes("not a function")) {
    return "Verify the function is properly imported and the call syntax is correct.";
  }

  if (errorType === "TypeError" && message.includes("cannot read property")) {
    return "Add null/undefined checks before accessing object properties.";
  }

  if (errorType === "SyntaxError") {
    return "Check for missing braces, brackets, or semicolons. Validate JSON if parsing.";
  }

  if (category === "security") {
    return "Enable CORS headers on server if intentional. Review security headers configuration.";
  }

  if (category === "performance") {
    return "Profile the operation. Consider caching, lazy loading, or optimizing algorithms.";
  }

  if (category === "deprecation") {
    return "Update to use the recommended replacement API. Check docs for migration guide.";
  }

  return "Review error message and stack trace. Check browser console for more details.";
}

/**
 * Analyzes console error and returns detailed information
 */
export function analyzeConsoleError(error: ConsoleError): ParsedError {
  const errorType = parseErrorType(error.message);
  const category = categorizeError(error.message, errorType);
  const severity = calculateSeverity(errorType, error.message);
  const originFunction = error.stack ? extractFunctionName(error.stack) : undefined;
  const stackTrace = error.stack ? parseStackTrace(error.stack) : undefined;
  const suggestedFix = generateSuggestedFix(errorType, error.message, category);

  return {
    errorType: (errorType || "Unknown") as any,
    severity: severity as any,
    message: error.message,
    category: category as any,
    source: error.source,
    line: error.line,
    originFunction,
    stackTrace,
    suggestedFix,
  };
}

/**
 * Filters and groups console errors by category
 */
export function groupErrorsByCategory(errors: ConsoleError[]): Record<string, ParsedError[]> {
  const grouped: Record<string, ParsedError[]> = {
    security: [],
    performance: [],
    deprecation: [],
    functional: [],
    other: [],
  };

  for (const error of errors) {
    const parsed = analyzeConsoleError(error);
    grouped[parsed.category].push(parsed);
  }

  return grouped;
}

/**
 * Detects related errors (same type/origin, different times)
 */
export function detectRelatedErrors(errors: ParsedError[]): ParsedError[][] {
  const related: Map<string, ParsedError[]> = new Map();

  for (const error of errors) {
    const key = `${error.errorType}:${error.originFunction}`;
    if (!related.has(key)) {
      related.set(key, []);
    }
    related.get(key)!.push(error);
  }

  return Array.from(related.values()).filter((group) => group.length > 1);
}

/**
 * FEATURE 6 ENHANCEMENT: Detects error patterns and recurring issues
 */
export function detectErrorPatterns(errors: ParsedError[]): {
  recurring: { error: string; count: number }[];
  errorChains: string[];
  criticalFirst: boolean;
} {
  const errorCounts: Record<string, number> = {};
  let criticalFound = false;

  for (const error of errors) {
    const key = `${error.errorType}: ${error.message}`;
    errorCounts[key] = (errorCounts[key] || 0) + 1;

    if (error.severity === "critical") {
      criticalFound = true;
    }
  }

  // Find recurring errors
  const recurring = Object.entries(errorCounts)
    .filter(([, count]) => count > 1)
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count);

  // Detect error chains (sequence of related errors)
  const errorChains: string[] = [];
  let currentChain: string[] = [];

  for (const error of errors) {
    const errorStr = `${error.errorType}`;
    if (currentChain.length === 0 || currentChain[currentChain.length - 1] === errorStr) {
      currentChain.push(errorStr);
    } else {
      if (currentChain.length > 2) {
        errorChains.push(currentChain.join(" → "));
      }
      currentChain = [errorStr];
    }
  }

  return {
    recurring: recurring.slice(0, 5),
    errorChains,
    criticalFirst: criticalFound,
  };
}

/**
 * FEATURE 6 ENHANCEMENT: Generates detailed error report with context
 */
export function generateDetailedErrorReport(errors: ConsoleError[]): {
  summary: string;
  critical: ParsedError[];
  byCategory: Record<string, { count: number; examples: ParsedError[] }>;
  patterns: ReturnType<typeof detectErrorPatterns>;
  recommendations: string[];
} {
  const parsed = errors.map(analyzeConsoleError);
  const summary = summarizeErrors(errors);
  const patterns = detectErrorPatterns(parsed);

  // Critical errors
  const critical = parsed.filter((e) => e.severity === "critical");

  // Group by category with examples
  const byCategory: Record<string, { count: number; examples: ParsedError[] }> = {};
  const categoryNames = ["security", "performance", "deprecation", "functional", "other"];

  for (const category of categoryNames) {
    const categoryErrors = parsed.filter((e) => e.category === category);
    if (categoryErrors.length > 0) {
      byCategory[category] = {
        count: categoryErrors.length,
        examples: categoryErrors.slice(0, 3),
      };
    }
  }

  // Generate recommendations
  const recommendations: string[] = [];

  if (summary.bySeverity.critical) {
    recommendations.push(`⚠️ ${summary.bySeverity.critical} critical error(s) found - requires immediate action`);
  }

  if (summary.byCategory.security > 0) {
    recommendations.push(`🔒 Security issues detected - review CORS, CSP, and authentication`);
  }

  if (summary.byCategory.performance > 0) {
    recommendations.push(`⚡ Performance issues found - check for memory leaks and slow operations`);
  }

  if (summary.byCategory.deprecation > 0) {
    recommendations.push(`📅 Deprecated APIs found - update to current standards`);
  }

  if (patterns.recurring.length > 0) {
    recommendations.push(`🔁 ${patterns.recurring.length} recurring error pattern(s) - indicates systemic issue`);
  }

  return {
    summary: `${errors.length} console errors detected: ${summary.bySeverity.critical || 0} critical, ${summary.bySeverity.high || 0} high`,
    critical,
    byCategory,
    patterns,
    recommendations,
  };
}

/**
 * FEATURE 6 ENHANCEMENT: Compares error signatures across runs
 */
export function compareErrorSignatures(
  previousErrors: ConsoleError[],
  currentErrors: ConsoleError[]
): {
  new: ParsedError[];
  resolved: ParsedError[];
  recurring: ParsedError[];
  improved: boolean;
} {
  const prevParsed = previousErrors.map(analyzeConsoleError);
  const currParsed = currentErrors.map(analyzeConsoleError);

  const prevSignatures = new Set(
    prevParsed.map((e) => `${e.errorType}:${e.message}`)
  );
  const currSignatures = new Set(
    currParsed.map((e) => `${e.errorType}:${e.message}`)
  );

  // New errors
  const newErrors = currParsed.filter(
    (e) => !prevSignatures.has(`${e.errorType}:${e.message}`)
  );

  // Resolved errors
  const resolved = prevParsed.filter(
    (e) => !currSignatures.has(`${e.errorType}:${e.message}`)
  );

  // Recurring errors
  const recurring = currParsed.filter(
    (e) => prevSignatures.has(`${e.errorType}:${e.message}`)
  );

  const improved =
    newErrors.length < prevParsed.length / 2 &&
    resolved.length > newErrors.length;

  return {
    new: newErrors,
    resolved,
    recurring,
    improved,
  };
}

/**
 * FEATURE 6 ENHANCEMENT: Identifies error root causes
 */
export function analyzeErrorRootCauses(errors: ParsedError[]): {
  likely: string[];
  context: string;
} {
  const causes: Map<string, number> = new Map();

  for (const error of errors) {
    const lowerMsg = error.message.toLowerCase();

    // Map common error patterns to root causes
    if (lowerMsg.includes("undefined") && lowerMsg.includes("property")) {
      causes.set("Null/undefined dereference", (causes.get("Null/undefined dereference") || 0) + 1);
    }
    if (error.errorType === "ReferenceError") {
      causes.set("Variable not defined", (causes.get("Variable not defined") || 0) + 1);
    }
    if (error.errorType === "TypeError" && lowerMsg.includes("not a function")) {
      causes.set("Calling non-function as function", (causes.get("Calling non-function as function") || 0) + 1);
    }
    if (lowerMsg.includes("cors")) {
      causes.set("CORS policy violation", (causes.get("CORS policy violation") || 0) + 1);
    }
    if (error.category === "performance") {
      causes.set("Performance degradation", (causes.get("Performance degradation") || 0) + 1);
    }
  }

  const likely = Array.from(causes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cause]) => cause);

  const criticalCount = errors.filter((e) => e.severity === "critical").length;
  const context =
    criticalCount > 0
      ? `${criticalCount} critical error(s) detected - blocking issue`
      : errors.length > 10
        ? `Multiple errors (${errors.length}) - systemic issue`
        : `${errors.length} error(s) found`;

  return { likely, context };
}

/**
 * Generates summary of console errors for report
 */
export function summarizeErrors(errors: ConsoleError[]): {
  total: number;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  topErrors: ParsedError[];
} {
  const parsed = errors.map(analyzeConsoleError);

  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const error of parsed) {
    byType[error.errorType] = (byType[error.errorType] || 0) + 1;
    byCategory[error.category] = (byCategory[error.category] || 0) + 1;
    bySeverity[error.severity] = (bySeverity[error.severity] || 0) + 1;
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const topErrors = parsed
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, 5);

  return {
    total: errors.length,
    byType,
    byCategory,
    bySeverity,
    topErrors,
  };
}
