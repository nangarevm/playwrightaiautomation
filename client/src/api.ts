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
  created_at: string;
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
  crawlUrl: (url: string, maxPages = 2) =>
    req("/inputs/url-crawl", { method: "POST", body: JSON.stringify({ url, maxPages }) }),
  importOpenApi: (content: string) =>
    req("/inputs/import-openapi", { method: "POST", body: JSON.stringify({ content }) }),
  importPostman: (content: string) =>
    req("/inputs/import-postman", { method: "POST", body: JSON.stringify({ content }) }),
  importExternal: (provider: "jira" | "azure", baseUrl: string, token: string, issueIds: string[] | string) =>
    req("/inputs/import-external", { method: "POST", body: JSON.stringify({ provider, baseUrl, token, issueIds }) }),
  generateTestCases: (inputId: string): Promise<TestCaseRow[]> =>
    req(`/inputs/${inputId}/generate`, { method: "POST" }),

  listTestCases: (): Promise<TestCaseRow[]> => req("/test-cases"),
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
  getAgreementRate: () => req("/test-cases/meta/agreement-rate"),
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

  // Module 6: reporting & analytics (FR-6.x)
  getDashboard: () => req("/reporting/dashboard"),
  getFlakyTests: () => req("/reporting/flaky"),
  getCoverage: () => req("/reporting/coverage"),
  getHoursSaved: () => req("/reporting/time-saved"),
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

  // Module 8: admin & governance (FR-8.x)
  listUsers: () => req("/admin/users"),
  createUser: (payload: { name: string; role: string; email?: string; owned_modules?: string }) =>
    req("/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  listAuditLog: (params?: { entityType?: string; entityId?: string }) =>
    req(`/admin/audit-log${params ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : ""}`),
  routeTestCaseToOwner: (testCaseId: string) => req(`/admin/test-cases/${testCaseId}/route-owner`, { method: "POST" }),
  setCriticalPath: (testCaseId: string, critical: boolean) =>
    req(`/admin/test-cases/${testCaseId}/critical-path`, { method: "POST", body: JSON.stringify({ critical }) }),
  secondReviewerSignOff: (testCaseId: string, decision: "approved" | "rejected") =>
    req(`/admin/test-cases/${testCaseId}/second-reviewer-signoff`, { method: "POST", body: JSON.stringify({ decision }) }),
  sampleForReReview: (count?: number) => req("/admin/re-review/sample", { method: "POST", body: JSON.stringify({ count }) }),
  listFlaggedForReReview: () => req("/admin/re-review/flagged"),
  createHumanTestCase: (payload: { input_id: string; title: string; category: string; steps: string[]; expected_result: string; priority?: string }) =>
    req("/test-cases", { method: "POST", body: JSON.stringify(payload) }),
};
