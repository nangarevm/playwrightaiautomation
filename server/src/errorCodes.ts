// Dev TDD §6.5: stable error_code catalog. Every HTTP error response in this
// codebase should include a machine-stable `error_code` alongside the
// human-readable `error` message, so a client can branch on the code without
// parsing prose. This does not change status codes or existing response
// shapes -- it only adds `error_code` (and, where noted, any extra fields
// the situation already carries, e.g. the FR-9.1 conflict payload).
export const ERROR_CODE_BY_STATUS: Record<number, string> = {
  400: "INVALID_SCHEMA", // malformed/invalid input (FR-1.9)
  401: "AUTH_REQUIRED", // missing/invalid identity
  403: "FORBIDDEN_ROLE", // RBAC denied (FR-8.1)
  409: "CONCURRENT_EDIT_CONFLICT", // optimistic-lock conflict (FR-9.1)
  422: "SECURITY_SCAN_FAILED", // generated script failed static scan (FR-3.6)
  429: "RATE_LIMITED", // rate limit exceeded
  501: "SERVICE_NOT_CONFIGURED", // optional integration has no credentials set (e.g. SMTP for email export)
  503: "LLM_PROVIDER_DEGRADED", // both LLM providers unavailable, request queued (FR-9.3/9.4)
};

/**
 * Build a JSON error body carrying the stable `error_code` for this status,
 * alongside the existing `error` message and any extra fields the route
 * already attaches (e.g. `conflict`, `current`, `queued`, `secondReviewerStatus`).
 */
export function errBody(status: number, message: string, extra?: Record<string, any>) {
  const error_code = ERROR_CODE_BY_STATUS[status];
  return { error: message, ...(error_code ? { error_code } : {}), ...(extra || {}) };
}
