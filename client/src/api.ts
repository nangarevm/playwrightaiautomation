const BASE = "/api";

// FR-8.1: the acting user for RBAC purposes (local-dev stand-in for a real login/session system)
let currentUserId = "user-qa-lead";
export function setCurrentUserId(id: string) {
  currentUserId = id;
}
export function getCurrentUserId() {
  return currentUserId;
}

async function req(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", "X-User-Id": currentUserId },
    ...opts,
  });

  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const err = new Error(data.error || `Request failed: ${res.status}`) as Error & { conflict?: boolean; current?: any };
    if (res.status === 409) {
      err.conflict = true;
      err.current = data.current;
    }
    throw err;
  }

  return data;
}

export interface InputRow {
  id: string;
  type: string;
  content: string;
  // FR-9.3: generation lifecycle for this input -- none/pending/queued/retrying/completed/failed
  generation_status?: string;
  generation_attempts?: number;
  generation_last_error?: string;
  created_at: string;
}

// FR-1.7/FR-1.9: per-document result from a PDF/Word/Excel batch upload -- each
// file gets its own parsed/failed outcome instead of the whole request succeeding
// or failing as one unit.
export interface DocumentUploadResult {
  originalName: string;
  size: number;
  status: "parsed" | "failed";
  kind?: string;
  error?: string;
  inputId?: string;
}

export interface TestCaseRow {
  id: string;
  input_id: string;
  title: string;
  category: string;
  steps: string[];
  expected_result: string;
  confidence_score: number;
  source_rationale: string;
  status: string;
  authorship_type: string;
  version: number;
  reviewer_notes?: string;
  priority?: string;
  explanation?: string;
  traceability_context?: any;
  // FR-4.26: below-threshold during an Ultrafast run -- auto-queued, non-blocking
  needs_review_later?: number;
  screen_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationScriptRow {
  id: string;
  test_case_id: string;
  language: string;
  framework: string;
  code: string;
  file_path: string;
  security_scan_status: string;
  security_scan_notes: string;
  last_run_status?: string;
  created_at: string;
}

export interface ExecutionRunRow {
  id: string;
  script_id: string;
  profile_id?: string;
  status: string;
  duration_ms: number;
  stdout: string;
  stderr: string;
  evidence_path?: string;
  browser_set?: string;
  concurrency?: number;
  artifact_capture_mode?: string;
  retention_days?: number;
  selection_mode?: string;
  retry_strategy?: string;
  queue_position?: number;
  provider?: string;
  execution_context?: string;
  trigger_source?: string;
  // FR-4.24: which speed mode this run was executed under
  speed_mode?: "ultrafast" | "fast";
  environment_id?: string;
  created_at: string;
}

export interface ExecutionProfileRow {
  id: string;
  name: string;
  description?: string;
  browser_set: string;
  concurrency: number;
  artifact_capture_mode: string;
  retention_days: number;
  selection_mode: string;
  retry_strategy: string;
  provider: string;
  runner_pool_name?: string;
  reserved_runner_count: number;
  headless_mode: number;
  reuse_browser_instances: number;
  is_default_for_team: number;
  is_default_for_suite: number;
  rules_json?: string;
  schedule_json?: string;
  default_environment_id?: string;
  // FR-4.24: this profile's default speed mode -- "ultrafast" enables the client's
  // quick-trigger flow that skips the Execution Settings Panel entirely.
  default_speed_mode?: "ultrafast" | "fast";
  created_at: string;
  updated_at: string;
}

export const api = {
  listInputs: (): Promise<InputRow[]> => req("/inputs"),
  createInput: (content: string, type = "free_text", businessRules?: string): Promise<InputRow> =>
    req("/inputs", { method: "POST", body: JSON.stringify({ content, type, businessRules }) }),
  batchUpload: (files: Array<{ originalName: string; mimeType: string; size: number; savedPath?: string; content?: string; disableRedaction?: boolean }>) =>
    req("/inputs/batch-upload", { method: "POST", body: JSON.stringify({ files }) }),
  uploadFiles: (screenshots: File[], videos: File[]) => {
    const form = new FormData();
    screenshots.forEach((file) => form.append("screenshots", file));
    videos.forEach((file) => form.append("videos", file));
    return fetch("/api/inputs/upload", { method: "POST", body: form }).then(async (res) => {
      const text = await res.text();
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }
      if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
      return data;
    });
  },
  // FR-1.7/FR-1.9: multi-file PDF/Word/Excel document upload -- mirrors uploadFiles's
  // FormData pattern, but hits the document-parsing endpoint. Each file's parse
  // outcome (parsed/failed) is reported independently in the response.
  uploadDocuments: (documents: File[]): Promise<{ documents: DocumentUploadResult[] }> => {
    const form = new FormData();
    documents.forEach((file) => form.append("documents", file));
    return fetch("/api/inputs/upload-documents", { method: "POST", body: form }).then(async (res) => {
      const text = await res.text();
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }
      if (!res.ok) throw new Error(data.error || `Upload failed: ${res.status}`);
      return data;
    });
  },
  // FR-1.3a/1.3b: optional username/password (basic auth) or a session token authenticates
  // into the target app before crawling -- only sent when the caller actually filled them in.
  crawlUrl: (url: string, maxPages = 2, auth?: { username?: string; password?: string; sessionToken?: string }) =>
    req("/inputs/url-crawl", {
      method: "POST",
      body: JSON.stringify({
        url,
        maxPages,
        ...(auth?.username ? { username: auth.username } : {}),
        ...(auth?.password ? { password: auth.password } : {}),
        ...(auth?.sessionToken ? { sessionToken: auth.sessionToken } : {}),
      }),
    }),
  importOpenApi: (content: string) =>
    req("/inputs/import-openapi", { method: "POST", body: JSON.stringify({ content }) }),
  importPostman: (content: string) =>
    req("/inputs/import-postman", { method: "POST", body: JSON.stringify({ content }) }),
  importExternal: (provider: "jira" | "azure", baseUrl: string, token: string, issueIds: string[] | string) =>
    req("/inputs/import-external", { method: "POST", body: JSON.stringify({ provider, baseUrl, token, issueIds }) }),
  generateTestCases: (inputId: string): Promise<TestCaseRow[]> =>
    req(`/inputs/${inputId}/generate`, { method: "POST" }),

  listTestCases: (): Promise<TestCaseRow[]> => req("/test-cases"),
  // FR-2.9: a real, non-mutating explanation fetch -- does not accept/edit/reject the case
  explainTestCase: (id: string): Promise<{ explanation: string }> => req(`/test-cases/${id}/explain`),
  // FR-2.17: data-driven/parameterized test cases
  listDataRows: (testCaseId: string): Promise<any[]> => req(`/test-cases/${testCaseId}/data-rows`),
  addDataRow: (testCaseId: string, input_values: Record<string, any>): Promise<any> =>
    req(`/test-cases/${testCaseId}/data-rows`, { method: "POST", body: JSON.stringify({ input_values }) }),
  runAllDataRows: (testCaseId: string, targetUrl: string): Promise<any> =>
    req(`/test-cases/${testCaseId}/data-rows/run-all`, { method: "POST", body: JSON.stringify({ targetUrl }) }),
  // FR-2.16: duplicate/near-duplicate detection within a screen
  detectDuplicates: (screenId: string): Promise<any> => req(`/test-cases/meta/detect-duplicates/${screenId}`),
  listDuplicateFlags: (): Promise<any[]> => req(`/test-cases/meta/duplicates`),
  resolveDuplicateFlag: (flagId: string, resolution: "merged" | "discarded" | "kept-both"): Promise<any> =>
    req(`/test-cases/meta/duplicates/${flagId}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) }),
  reviewTestCase: (
    id: string,
    action: "accept" | "edit" | "reject" | "needs_discussion",
    edited_fields?: Partial<TestCaseRow>,
    reviewer_notes?: string,
    base_version?: number
  ): Promise<TestCaseRow & { diff?: any; explanation?: string }> =>
    req(`/test-cases/${id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ action, edited_fields, reviewer_notes, base_version }),
    }),

  listScripts: (): Promise<AutomationScriptRow[]> => req("/automation-scripts"),
  generateScript: (testCaseId: string, framework?: "playwright" | "selenium" | "cypress") =>
    req(`/automation-scripts/${testCaseId}/generate`, { method: "POST", body: JSON.stringify({ framework }) }),
  regenerateTestCase: (testCaseId: string) => req(`/test-cases/${testCaseId}/regenerate`, { method: "POST" }),

  listRuns: (): Promise<ExecutionRunRow[]> => req("/execution-runs"),
  listExecutionProfiles: (): Promise<ExecutionProfileRow[]> => req("/execution-runs/profiles"),
  createExecutionProfile: (profile: Partial<ExecutionProfileRow>) => req("/execution-runs/profiles", { method: "POST", body: JSON.stringify(profile) }),
  updateExecutionProfile: (id: string, profile: Partial<ExecutionProfileRow>) => req(`/execution-runs/profiles/${id}`, { method: "PATCH", body: JSON.stringify(profile) }),
  deleteExecutionProfile: (id: string) => req(`/execution-runs/profiles/${id}`, { method: "DELETE" }),
  suggestExecutionProfile: (context?: Record<string, string>) => req(`/execution-runs/profiles/suggest${context ? `?${new URLSearchParams(context).toString()}` : ""}`),
  listExecutionQueue: (): Promise<ExecutionRunRow[]> => req("/execution-runs/queue"),
  queueScript: (scriptId: string, targetUrl?: string, options?: any) =>
    req(`/execution-runs/${scriptId}/queue`, {
      method: "POST",
      body: JSON.stringify({ target_url: targetUrl, ...options }),
    }),
  triggerScheduler: () => req("/execution-runs/scheduler/tick", { method: "POST" }),
  // FR-4.24/FR-4.25/FR-4.26/FR-4.27/FR-4.30: Ultrafast Mode -- given just a script or test
  // case reference, auto-resolves profile/environment, auto-accepts/queues review, and starts
  // the run immediately with no confirmation dialog.
  triggerUltrafast: (ref: { scriptId?: string; testCaseId?: string }, targetUrl?: string) =>
    req("/execution-runs/ultrafast", {
      method: "POST",
      body: JSON.stringify({ script_id: ref.scriptId, test_case_id: ref.testCaseId, target_url: targetUrl }),
    }),
  // FR-6.5 per-failed-test evidence for a single run, including the real
  // Playwright error message captured when the run completed.
  getExecutionEvidence: (runId: string): Promise<ExecutionEvidenceRow[]> => req(`/execution-runs/${runId}/evidence`),
  // Stop execution: kill a single run in flight (running or still queued).
  stopExecutionRun: (runId: string) => req(`/execution-runs/${runId}/stop`, { method: "POST" }),
  // Stop everything currently running or queued -- "abandon this batch".
  stopAllExecutions: () => req("/execution-runs/stop-all", { method: "POST" }),
  // FR-4.26: QA-Lead-editable Ultrafast Mode auto-accept confidence threshold
  getUltrafastThreshold: () => req("/execution-runs/ultrafast-threshold"),
  setUltrafastThreshold: (threshold: number) =>
    req("/execution-runs/ultrafast-threshold", { method: "PUT", body: JSON.stringify({ threshold }) }),
  getReviewAudit: (testCaseId: string) => req(`/test-cases/${testCaseId}/audit`),
  syncTestCase: (testCaseId: string, provider: "jira" | "azure", baseUrl: string, token: string) =>
    req(`/test-cases/${testCaseId}/sync`, { method: "POST", body: JSON.stringify({ provider, baseUrl, token }) }),
  exportTestCaseCsv: (testCaseId: string) => fetch(`/api/test-cases/${testCaseId}/export.csv`).then((res) => res.text()),
  exportTestCaseXlsx: (testCaseId: string) => fetch(`/api/test-cases/${testCaseId}/export.xlsx`).then(async (res) => {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${testCaseId}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }),
  // Bulk/multi-select export -- "all selected" or "some selected" test cases in one
  // file. `ids.length === 1` covers the single-item case too, so the AI Studio export
  // button can always call this regardless of how many rows are checked.
  exportTestCases: async (ids: string[], format: "csv" | "xlsx" | "pdf" | "docx") => {
    const res = await fetch("/api/test-cases/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": getCurrentUserId() },
      body: JSON.stringify({ ids, format }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error((() => { try { return JSON.parse(text).error; } catch { return text || `Export failed: ${res.status}`; } })());
    }
    const disposition = res.headers.get("Content-Disposition") || "";
    const fileName = disposition.match(/filename="?([^"]+)"?/)?.[1] || `test-cases.${format}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  },
  deleteTestCase: (testCaseId: string) => req(`/test-cases/${testCaseId}`, { method: "DELETE" }),
  getAgreementRate: () => req("/test-cases/meta/agreement-rate"),
  // FR-9.6: reviewer agreement rate broken down by compressed-vs-uncompressed generation origin
  getAgreementRateByCompression: () => req("/test-cases/meta/agreement-rate?byCompression=true"),
  runScript: (scriptId: string, targetUrl?: string, options?: any) =>
    req(`/execution-runs/${scriptId}/run`, {
      method: "POST",
      body: JSON.stringify({ target_url: targetUrl, ...options }),
    }),

  // Module 5: change detection & self-healing (FR-5.x)
  detectChanges: (
    testCaseId: string,
    payload: { uiBeforeHtml?: string; uiAfterHtml?: string; apiBeforeSpec?: string; apiAfterSpec?: string; source?: string }
  ) => req(`/self-healing/${testCaseId}/detect`, { method: "POST", body: JSON.stringify(payload) }),
  healTestCase: (
    testCaseId: string,
    payload: { detectionId: string; beforeLocator: string; afterLocator: string; confidence: number; reason?: string }
  ) => req(`/self-healing/${testCaseId}/heal`, { method: "POST", body: JSON.stringify(payload) }),
  rollbackHeal: (healActionId: string) => req(`/self-healing/heal-actions/${healActionId}/rollback`, { method: "POST" }),
  listHealActions: (testCaseId: string) => req(`/self-healing/${testCaseId}/heal-actions`),
  listDetections: (testCaseId: string) => req(`/self-healing/${testCaseId}/detections`),
  // FR-5.4: QA-Lead-editable self-heal high-confidence threshold
  getSelfHealThreshold: () => req("/self-healing/confidence-threshold"),
  setSelfHealThreshold: (threshold: number) =>
    req("/self-healing/confidence-threshold", { method: "PUT", body: JSON.stringify({ threshold }) }),

  // Module 6: reporting & analytics (FR-6.x)
  // FR-6.1/FR-6.6: optional {startDate, endDate} (YYYY-MM-DD) scopes the dashboard/hours-saved
  // to a date range instead of the platform's entire run history.
  getDashboard: (range?: { startDate?: string; endDate?: string }) =>
    req(`/reporting/dashboard${range ? `?${new URLSearchParams(Object.fromEntries(Object.entries(range).filter(([, v]) => v))).toString()}` : ""}`),
  getFlakyTests: () => req("/reporting/flaky"),
  getCoverage: () => req("/reporting/coverage"),
  getHoursSaved: (range?: { startDate?: string; endDate?: string }) =>
    req(`/reporting/time-saved${range ? `?${new URLSearchParams(Object.fromEntries(Object.entries(range).filter(([, v]) => v))).toString()}` : ""}`),
  exportReleaseReportPdf: () =>
    fetch("/api/reporting/export.pdf").then(async (res) => {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "release-report.pdf";
      link.click();
      URL.revokeObjectURL(url);
    }),
  exportReleaseReportXlsx: () =>
    fetch("/api/reporting/export.xlsx").then(async (res) => {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "release-report.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    }),

  // Module 7: integrations hub (FR-7.x / FR-8.4 token storage)
  listIntegrations: (type?: string) => req(`/integrations${type ? `?type=${type}` : ""}`),
  createIntegration: (payload: { type: string; base_url?: string; webhook_url?: string; token?: string; org_id?: string; notify_on_run?: boolean }) =>
    req("/integrations", { method: "POST", body: JSON.stringify(payload) }),
  deleteIntegration: (id: string) => req(`/integrations/${id}`, { method: "DELETE" }),
  rotateIntegrationToken: (id: string, token: string) => req(`/integrations/${id}/rotate-token`, { method: "POST", body: JSON.stringify({ token }) }),
  pushTestCaseToIntegration: (integrationId: string, testCaseId: string) =>
    req(`/integrations/${integrationId}/push-test-case/${testCaseId}`, { method: "POST" }),
  notifyIntegration: (integrationId: string, message: string) =>
    req(`/integrations/${integrationId}/notify`, { method: "POST", body: JSON.stringify({ message }) }),
  gitHistoryForScript: (fileName: string) => req(`/integrations/git/history/${encodeURIComponent(fileName)}`),
  // FR-7.5: push a test case to a connected TestRail/Zephyr/qTest integration
  pushTestCaseAdditional: (integrationId: string, testCaseId: string) =>
    req(`/integrations/${integrationId}/push-test-case-additional/${testCaseId}`, { method: "POST" }),

  // Module 8: admin & governance (FR-8.x)
  listUsers: () => req("/admin/users"),
  createUser: (payload: { name: string; role: string; email?: string; owned_modules?: string }) =>
    req("/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  listAuditLog: (params?: { entityType?: string; entityId?: string }) =>
    req(`/admin/audit-log${params ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : ""}`),
  getUserActivity: () => req("/admin/user-activity"),
  routeTestCaseToOwner: (testCaseId: string) => req(`/admin/test-cases/${testCaseId}/route-owner`, { method: "POST" }),
  setCriticalPath: (testCaseId: string, critical: boolean) =>
    req(`/admin/test-cases/${testCaseId}/critical-path`, { method: "POST", body: JSON.stringify({ critical }) }),
  secondReviewerSignOff: (testCaseId: string, decision: "approved" | "rejected") =>
    req(`/admin/test-cases/${testCaseId}/second-reviewer-signoff`, { method: "POST", body: JSON.stringify({ decision }) }),
  sampleForReReview: (count?: number) => req("/admin/re-review/sample", { method: "POST", body: JSON.stringify({ count }) }),
  listFlaggedForReReview: () => req("/admin/re-review/flagged"),
  createHumanTestCase: (payload: { input_id: string; title: string; category: string; steps: string[]; expected_result: string; priority?: string }) =>
    req("/test-cases", { method: "POST", body: JSON.stringify(payload) }),

  // Screen Explorer (FR-1.10/FR-2.14/FR-4.18/FR-5.7/FR-5.8/FR-5.9/FR-5.10/FR-6.8)
  listScreens: () => req("/screens"),
  getScreenChangeSummary: (id: string) => req(`/screens/${id}/change-summary`),
  runScreensScoped: (screenIds: string[], changedOnly: boolean) =>
    req("/screens/run", { method: "POST", body: JSON.stringify({ screen_ids: screenIds, changed_only: changedOnly }) }),
  getCoverageGaps: () => req("/reporting/coverage-gaps"),

  // LLM usage/cost dashboard (FR-6.10/FR-9.5/FR-9.7)
  getLlmUsage: () => req("/reporting/llm-usage"),

  // Per-user notification preferences (FR-6.12)
  getNotificationPref: (userId: string) => req(`/reporting/notification-prefs/${userId}`),
  setNotificationPref: (userId: string, channel: string, frequency: string) =>
    req(`/reporting/notification-prefs/${userId}`, { method: "PUT", body: JSON.stringify({ channel, frequency }) }),

  // Test case search/filter (FR-2.18) and bulk actions (FR-2.15)
  searchTestCases: (params: { keyword?: string; screenId?: string; priority?: string; category?: string; authorshipType?: string }) =>
    req(`/test-cases/meta/search?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString()}`),
  bulkTestCaseAction: (ids: string[], action: string, extra?: { screenId?: string; priority?: string }) =>
    req("/test-cases/bulk", { method: "POST", body: JSON.stringify({ ids, action, ...extra }) }),

  // FR-1.8 org-level PII redaction toggle
  getRedactionSetting: () => req("/admin/org-settings/redaction"),
  setRedactionSetting: (disabled: boolean) => req("/admin/org-settings/redaction", { method: "PUT", body: JSON.stringify({ disabled }) }),

  // Single-QA cost-saving mode: routes more generation calls to the cheap model tier
  getCostSavingSetting: (): Promise<{ cost_saving_mode: number; economy_tier_length_threshold: number }> =>
    req("/admin/org-settings/cost-saving"),
  setCostSavingMode: (enabled: boolean) => req("/admin/org-settings/cost-saving", { method: "PUT", body: JSON.stringify({ enabled }) }),

  // FR-2.11 business rules
  listBusinessRules: () => req("/admin/business-rules"),
  createBusinessRule: (name: string, description: string) =>
    req("/admin/business-rules", { method: "POST", body: JSON.stringify({ name, description }) }),

  // FR-4.19/FR-4.20/FR-1.3c: Environments (target URL + credentials + default profile)
  listEnvironments: (): Promise<EnvironmentRow[]> => req("/environments"),
  createEnvironment: (payload: { name: string; target_url: string; username?: string; password?: string; default_profile_id?: string }) =>
    req("/environments", { method: "POST", body: JSON.stringify(payload) }),
  deleteEnvironment: (id: string) => req(`/environments/${id}`, { method: "DELETE" }),
  revokeEnvironmentCredentials: (id: string) => req(`/environments/${id}/credentials/revoke`, { method: "POST" }),
  rotateEnvironmentCredentials: (id: string, username: string, password: string) =>
    req(`/environments/${id}/credentials/rotate`, { method: "POST", body: JSON.stringify({ username, password }) }),
  runEnvironmentHealthCheck: (id: string) => req(`/environments/${id}/health-check`, { method: "POST" }),

  // FR-4.21: named platform secrets registry (never re-displays the value after creation)
  listSecrets: () => req("/execution-runs/secrets"),
  createSecret: (name: string, value: string) =>
    req("/execution-runs/secrets", { method: "POST", body: JSON.stringify({ name, value }) }),
  deleteSecret: (name: string) => req(`/execution-runs/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // FR-4.23: Execution Profile version history
  listProfileVersions: (profileId: string) => req(`/execution-runs/profiles/${profileId}/versions`),

  // FR-8.9: SSO config status + stub IdP-callback linkage/revocation model
  getSsoConfig: () => req("/admin/sso/config"),
  ssoCallback: (payload: { subjectId: string; email: string; name: string; provider: string }) =>
    req("/admin/sso/callback", { method: "POST", body: JSON.stringify(payload) }),
  disableSsoUser: (userId: string) => req(`/admin/sso/users/${userId}/disable`, { method: "POST" }),

  // FR-8.10: full project export/import
  exportProject: () =>
    fetch("/api/admin/project/export", { headers: { "X-User-Id": getCurrentUserId() } }).then(async (res) => {
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "project-export.json";
      link.click();
      URL.revokeObjectURL(url);
    }),
  importProject: (payload: any) => req("/admin/project/import", { method: "POST", body: JSON.stringify(payload) }),

  // AI Crawler (Phases 1-8 of the crawler build brief)
  crawlerRun: (payload: { url: string; username?: string; password?: string; maxPages?: number; captureApi?: boolean; concurrency?: number }) =>
    req("/crawler/run", { method: "POST", body: JSON.stringify(payload) }),
  crawlerKnownSite: (url: string) => req(`/crawler/known-site?url=${encodeURIComponent(url)}`),
  crawlerListSites: (): Promise<CrawlSite[]> => req("/crawler/sites"),
  crawlerGetSite: (siteId: string): Promise<CrawlSite> => req(`/crawler/sites/${siteId}`),
  crawlerGetSiteDetail: (siteId: string): Promise<CrawlSiteDetail> => req(`/crawler/sites/${siteId}/detail`),
  crawlerDeleteScenario: (id: string) => req(`/crawler/scenarios/${id}`, { method: "DELETE" }),
  crawlerBulkDeleteScenarios: (ids: string[]) => req("/crawler/scenarios/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),
  crawlerRestoreScenario: (id: string) => req(`/crawler/scenarios/${id}/restore`, { method: "POST" }),
  crawlerGenerateTests: (scenarioIds: string[]) => req("/crawler/scenarios/generate-tests", { method: "POST", body: JSON.stringify({ scenarioIds }) }),

  // Bug Detection Engine: proactive UI-exploratory + API-fuzz findings, distinct
  // from FR-7.6's reactive regression auto-filing.
  listBugFindings: (params?: { status?: string; severity?: string; screenId?: string }): Promise<BugFindingRow[]> =>
    req(`/bugs${params ? `?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString()}` : ""}`),
  scanScreenForBugs: (screenId: string): Promise<{ findings: BugFindingRow[]; count: number }> =>
    req("/bugs/scan", { method: "POST", body: JSON.stringify({ screenId }) }),
  fuzzApiForBugs: (apiBaseUrl: string, endpoints: string[]): Promise<{ findings: BugFindingRow[]; count: number }> =>
    req("/bugs/scan", { method: "POST", body: JSON.stringify({ apiBaseUrl, endpoints }) }),
  updateBugFindingStatus: (id: string, status: BugFindingRow["status"]): Promise<BugFindingRow> =>
    req(`/bugs/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  fileBugFinding: (id: string): Promise<BugFindingRow> => req(`/bugs/${id}/file`, { method: "POST" }),

  // Customer-facing bug report PDF for a crawl/batch's failures -- the entries
  // themselves are assembled client-side (see BugReportPanel), posted here for
  // pdfkit rendering since this platform's PDF generation is server-side only.
  downloadBugReportPdf: async (entries: Array<Record<string, unknown>>, filename = "bug-report.pdf") => {
    const res = await fetch("/api/reporting/bug-report.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `PDF generation failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // Allure reporting (Phase 6). sinceMs scopes generation to result files recorded
  // at/after that epoch-ms timestamp (e.g. "this crawl's runs" instead of the
  // platform's entire accumulated history) -- omit for the full-history report.
  allureGenerate: (sinceMs?: number) => req("/allure/generate", { method: "POST", body: JSON.stringify({ sinceMs }) }),
  allureStatus: () => req("/allure/status"),
  allureDownloadUrl: "/api/allure/download",
  allureEmailStatus: (): Promise<{ configured: boolean }> => req("/allure/email-status"),
  allureSendEmail: (email: string): Promise<{ ok: true; messageId: string }> =>
    req("/allure/send-email", { method: "POST", body: JSON.stringify({ email }) }),
};

export interface CrawlSite {
  id: string;
  url: string;
  status: "running" | "completed" | "failed" | "paused";
  pages_discovered: number;
  forms_discovered: number;
  scenarios_discovered: number;
  spelling_issues_found: number;
  current_page?: string;
  error?: string;
  is_rerun: number;
  capture_api: number;
  created_at: string;
  last_crawled_at?: string;
}

export interface CrawlSpellingIssue {
  word: string;
  suggestions: string[];
  context: string;
}

export interface CrawlScenario {
  id: string;
  site_id: string;
  page_id: string;
  title: string;
  type: "positive" | "negative" | "edge" | "flow" | "api";
  // Which of the three test suites this belongs to -- see server's
  // crawler/types.ts ScenarioRecord.tier for the smoke/functional/regression
  // definitions. Nullable only for pre-migration rows the backfill hasn't
  // reached yet (shouldn't happen in practice; ensureColumn's backfill runs
  // on every server start).
  tier: "smoke" | "functional" | "regression" | null;
  flow_group: string;
  steps: string[];
  locators: string[];
  status: string;
  generated_test_case_id?: string;
  created_at: string;
}

export interface CrawlComponentInventoryItem {
  kind: string;
  label: string;
  count: number;
  samples: string[];
}

export interface CrawlPage {
  id: string;
  site_id: string;
  url: string;
  title: string;
  dom_hash: string;
  change_status: "new" | "changed" | "unchanged";
  diff: { added: string[]; removed: string[]; changed: string[] } | null;
  elements: Array<{ type: string; label: string; locators: string[]; component: string }>;
  apis: Array<{ trigger: string; method: string; endpoint: string; schema: any }>;
  scenarios: CrawlScenario[];
  spellingIssues: CrawlSpellingIssue[];
  componentInventory: CrawlComponentInventoryItem[];
}

export interface CrawlSiteDetail {
  site: CrawlSite;
  pages: CrawlPage[];
}

export interface ExecutionEvidenceRow {
  id: string;
  run_id: string;
  test_title: string | null;
  test_file: string | null;
  status: string | null;
  evidence_path: string | null;
  error_message: string | null;
  // Heuristic "why did this fail" bucket: 'automation_issue' (the script's own
  // locator/timeout), 'environment_issue' (target unreachable), 'possible_bug'
  // (a real content/behavior mismatch), or 'unknown'.
  failure_class: "automation_issue" | "environment_issue" | "possible_bug" | "unknown" | null;
  failure_label: string | null;
  created_at: string;
}

export interface BugFindingRow {
  id: string;
  source: "ui_exploratory" | "api_fuzz" | "regression";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  screen_id: string | null;
  run_id: string | null;
  evidence: string;
  steps_to_reproduce: string | null;
  screenshot_url: string | null;
  video_url: string | null;
  status: "open" | "acknowledged" | "resolved" | "ignored";
  filed_provider: string | null;
  filed_external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnvironmentRow {
  id: string;
  name: string;
  target_url: string;
  has_credentials: boolean;
  default_profile_id?: string;
  last_health_check_status?: string;
  last_health_check_at?: string;
  created_at: string;
  updated_at: string;
}
