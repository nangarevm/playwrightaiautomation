// Phase 4a -- Authorization testing (master prompt #11). The highest-risk
// module in this whole plan: unlike every other check added this session
// (all single-identity, read-only observation), this one sends requests as a
// SECOND identity against a real target to check whether access control
// actually denies it what it shouldn't have. Per the master prompt's own
// instruction ("never perform destructive/security testing outside
// explicitly authorized test environments"), this refuses to run unless BOTH:
//   1. org_settings.authz_testing_enabled is explicitly turned on (org-wide
//      opt-in, defaults OFF -- see adminService.getAuthzTestingEnabled), AND
//   2. the specific target `environments` row has a secondary (deliberately
//      lower-privilege) identity configured (environmentsService.
//      hasSecondaryCredentials) -- an org enabling the feature doesn't
//      authorize probing every environment, only ones a human has also
//      explicitly given a second identity to.
// Enforcement lives HERE, in the service itself, not just a route/UI guard --
// mirrors adminService.requireRole()'s "server-side-always" pattern, so a
// caller can't route around the check by hitting the service directly.
//
// SCOPE: every probe in this file is a plain GET request replaying a URL a
// caller supplies -- there is no code path here that issues a POST/PUT/
// PATCH/DELETE, so it cannot be used to mutate data even if misused. This is
// "never mutates data as part of a probe" enforced structurally, not just by
// convention.
//
// FALSE-POSITIVE RISK: a 200 on a resource the secondary identity "shouldn't"
// see is only as reliable as the caller's own claim about what that identity
// is allowed to access -- this service has no independent way to know your
// app's authorization model. A resource that's intentionally public (or
// shared across the two identities) will read as a false positive. Review
// findings against your own access-control intent before treating them as
// confirmed; there is no per-environment suppression list for this (unlike
// every other check) because a wrong finding here is a security-relevant
// claim that deserves a human look, not silent auto-suppression.

import { getAuthzTestingEnabled } from "./adminService.js";
import { getEnvironment, getDecryptedSecondaryCredentials, hasSecondaryCredentials } from "./environmentsService.js";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const AUTHZ_TESTING_CONFIG = {
  // Caps findings-per-probe-call, same reasoning as every other capped check this session.
  maxFindingsPerRun: 20,
  requestTimeoutMs: 10000,
};

export class AuthzTestingNotAuthorizedError extends Error {}

/**
 * Throws AuthzTestingNotAuthorizedError unless BOTH the org-wide opt-in and
 * this specific environment's secondary identity are configured. Every
 * exported probe function calls this before doing anything else.
 */
function assertAuthzTestingAllowed(environmentId: string): void {
  if (!getAuthzTestingEnabled()) {
    throw new AuthzTestingNotAuthorizedError(
      "Authorization testing is disabled for this org (org_settings.authz_testing_enabled). Enable it explicitly before running an authz probe."
    );
  }
  const env = getEnvironment(environmentId) as any;
  if (!env) throw new AuthzTestingNotAuthorizedError("Environment not found.");
  if (!hasSecondaryCredentials(environmentId)) {
    throw new AuthzTestingNotAuthorizedError(
      `Environment "${env.name}" has no secondary (lower-privilege) identity configured. Authz probes refuse to run against an environment that hasn't explicitly opted in.`
    );
  }
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export interface AuthzProbeResult {
  url: string;
  status: number;
  finding?: BugFindingRow;
}

/**
 * IDOR probe: replay a URL captured during the primary crawl (which returned
 * a successful response for the PRIMARY identity) as the environment's
 * SECONDARY identity instead. A 200 here -- where the secondary identity
 * should have gotten a 403/404 for a resource it doesn't own -- is the
 * finding. GET only; never mutates data (see the file-level SCOPE note).
 */
export async function runIdorProbe(environmentId: string, candidateUrls: string[], runId?: string): Promise<AuthzProbeResult[]> {
  assertAuthzTestingAllowed(environmentId);
  const creds = getDecryptedSecondaryCredentials(environmentId);
  if (!creds) throw new AuthzTestingNotAuthorizedError("Secondary credentials could not be decrypted (revoked/rotated?).");

  const results: AuthzProbeResult[] = [];
  let findingCount = 0;
  for (const url of candidateUrls) {
    let status: number;
    try {
      const res = await fetch(url, { method: "GET", headers: { Authorization: basicAuthHeader(creds.username, creds.password) }, signal: AbortSignal.timeout(AUTHZ_TESTING_CONFIG.requestTimeoutMs) });
      status = res.status;
    } catch {
      results.push({ url, status: 0 });
      continue;
    }

    let finding: BugFindingRow | undefined;
    if (status >= 200 && status < 300 && findingCount < AUTHZ_TESTING_CONFIG.maxFindingsPerRun) {
      findingCount++;
      finding = recordBugFinding({
        source: "api_fuzz",
        category: "security",
        severity: "critical",
        title: `Possible IDOR: ${url} accessible to a secondary identity`,
        detail: `GET ${url} returned HTTP ${status} when authenticated as the environment's secondary (lower-privilege) identity. If this resource should be scoped to its owner, this is an insecure direct object reference.`,
        evidence: { url, status, probeType: "idor" },
        runId,
        stepsToReproduce: [
          `Authenticate as a lower-privilege / different-owner identity.`,
          `Send: GET ${url}`,
          `Observe: HTTP ${status} (success) instead of an expected 403/404.`,
        ],
      });
    }
    results.push({ url, status, finding });
  }
  return results;
}

/**
 * Vertical escalation probe: replay a URL believed to require the PRIMARY
 * (higher-privilege) identity as the SECONDARY (lower-privilege) identity
 * instead. A 200 here is the finding -- the lower-privilege identity reached
 * an action it shouldn't be able to perform. Same GET-only, read-only-probe
 * scope as runIdorProbe.
 */
export async function runVerticalEscalationProbe(environmentId: string, primaryOnlyUrls: string[], runId?: string): Promise<AuthzProbeResult[]> {
  assertAuthzTestingAllowed(environmentId);
  const creds = getDecryptedSecondaryCredentials(environmentId);
  if (!creds) throw new AuthzTestingNotAuthorizedError("Secondary credentials could not be decrypted (revoked/rotated?).");

  const results: AuthzProbeResult[] = [];
  let findingCount = 0;
  for (const url of primaryOnlyUrls) {
    let status: number;
    try {
      const res = await fetch(url, { method: "GET", headers: { Authorization: basicAuthHeader(creds.username, creds.password) }, signal: AbortSignal.timeout(AUTHZ_TESTING_CONFIG.requestTimeoutMs) });
      status = res.status;
    } catch {
      results.push({ url, status: 0 });
      continue;
    }

    let finding: BugFindingRow | undefined;
    if (status >= 200 && status < 300 && findingCount < AUTHZ_TESTING_CONFIG.maxFindingsPerRun) {
      findingCount++;
      finding = recordBugFinding({
        source: "api_fuzz",
        category: "security",
        severity: "critical",
        title: `Possible vertical privilege escalation: ${url} accessible to a lower-privilege identity`,
        detail: `GET ${url} (believed to require a higher-privilege identity) returned HTTP ${status} when authenticated as the environment's secondary, lower-privilege identity.`,
        evidence: { url, status, probeType: "vertical-escalation" },
        runId,
        stepsToReproduce: [
          `Authenticate as the lower-privilege identity.`,
          `Send: GET ${url}`,
          `Observe: HTTP ${status} (success) instead of an expected 403.`,
        ],
      });
    }
    results.push({ url, status, finding });
  }
  return results;
}

export function isAuthzTestingConfigured(environmentId: string): { orgEnabled: boolean; environmentConfigured: boolean; allowed: boolean } {
  const orgEnabled = getAuthzTestingEnabled();
  const environmentConfigured = hasSecondaryCredentials(environmentId);
  return { orgEnabled, environmentConfigured, allowed: orgEnabled && environmentConfigured };
}
