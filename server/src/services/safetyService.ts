// FR-9.2 (MVP gate): sanitize/validate all ticket/spec/free-text content before it is
// submitted to any LLM provider, to reduce prompt-injection risk from crafted or malicious
// input. This sits between Ingestion/Generation and the LLM API (SRS section 8), so it must
// run for every provider -- not just the real Anthropic one -- which is why it lives here
// rather than inside anthropicProvider.ts.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all|any|previous|prior|the above)\s+instructions?/gi,
  /disregard\s+(all|any|previous|prior)\s+instructions?/gi,
  /you are now/gi,
  /new\s+instructions?\s*:/gi,
  /system\s*prompt/gi,
  /<\s*\/?\s*(system|assistant|user)\s*>/gi,
  /\[\s*(system|assistant|inst)\s*\]/gi,
  /```(system|assistant)/gi,
  /act as (an?|the)/gi,
  /reveal (your|the) (system )?prompt/gi,
];

const MAX_INPUT_LENGTH = 12000;

export interface SanitizationResult {
  sanitized: string;
  flagged: boolean;
  matchedPatterns: string[];
  truncated: boolean;
}

export function sanitizeForLlm(rawInput: string): SanitizationResult {
  const input = rawInput ?? "";
  const matchedPatterns: string[] = [];

  let sanitized = input;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      matchedPatterns.push(pattern.source);
    }
    // reset lastIndex for global regexes reused across iterations
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED_INSTRUCTION]");
  }

  const truncated = sanitized.length > MAX_INPUT_LENGTH;
  if (truncated) {
    sanitized = sanitized.slice(0, MAX_INPUT_LENGTH);
  }

  return {
    sanitized,
    flagged: matchedPatterns.length > 0,
    matchedPatterns,
    truncated,
  };
}
