import { useEffect, useState } from "react";
import {
  api,
  InputRow,
  TestCaseRow,
  AutomationScriptRow,
  ExecutionRunRow,
  ExecutionProfileRow,
  getCurrentUserId,
  setCurrentUserId,
} from "./api.js";

const CATEGORY_COLOR: Record<string, string> = {
  Smoke: "bg-signal/10 text-signal border-signal/30",
  Regression: "bg-ink/10 text-ink border-ink/30",
  Functional: "bg-signal/10 text-signal border-signal/30",
  "Edge Case": "bg-amber-100 text-amber-800 border-amber-300",
  Negative: "bg-alert/10 text-alert border-alert/30",
  API: "bg-indigo-100 text-indigo-800 border-indigo-300",
};

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "bad" | "warn" }) {
  const toneClass = {
    neutral: "bg-ink/5 text-ink/70 border-ink/15",
    good: "bg-signal/10 text-signal border-signal/30",
    bad: "bg-alert/10 text-alert border-alert/30",
    warn: "bg-amber-100 text-amber-800 border-amber-300",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function StageHeader({ n, title, subtitle }: { n: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-line pb-3 mb-4">
      <span className="font-display text-sm text-signal">{String(n).padStart(2, "0")}</span>
      <div>
        <h2 className="font-display text-lg tracking-tight">{title}</h2>
        <p className="text-sm text-ink/60">{subtitle}</p>
      </div>
    </div>
  );
}

export default function App() {
  const [inputs, setInputs] = useState<InputRow[]>([]);
  const [testCases, setTestCases] = useState<TestCaseRow[]>([]);
  const [scripts, setScripts] = useState<AutomationScriptRow[]>([]);
  const [runs, setRuns] = useState<ExecutionRunRow[]>([]);
  const [profiles, setProfiles] = useState<ExecutionProfileRow[]>([]);
  const [queueEntries, setQueueEntries] = useState<ExecutionRunRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState({
    name: "",
    description: "",
    browser_set: "chromium",
    concurrency: 1,
    artifact_capture_mode: "logs-only",
    retention_days: 30,
    selection_mode: "full-suite",
    retry_strategy: "no-retry",
    provider: "local",
    runner_pool_name: "",
    reserved_runner_count: 0,
    headless_mode: 1,
    reuse_browser_instances: 0,
    is_default_for_team: 0,
    is_default_for_suite: 0,
  });

  const [draftInput, setDraftInput] = useState(
    "The application has a login page with a Username field, a Password field, and a Log in button. Valid credentials should reach a Welcome dashboard; invalid credentials should show an inline error."
  );
  const [batchUrl, setBatchUrl] = useState("");
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [videos, setVideos] = useState<File[]>([]);
  const [openApiText, setOpenApiText] = useState("");
  const [postmanText, setPostmanText] = useState("");
  const [businessRules, setBusinessRules] = useState("");
  const [externalProvider, setExternalProvider] = useState<"jira" | "azure">("jira");
  const [externalBaseUrl, setExternalBaseUrl] = useState("");
  const [externalToken, setExternalToken] = useState("");
  const [externalIssueIds, setExternalIssueIds] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agreementRate, setAgreementRate] = useState<number | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, Partial<TestCaseRow>>>({});
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [reviewDetails, setReviewDetails] = useState<Record<string, any>>({});
  const [healDrafts, setHealDrafts] = useState<Record<string, { uiBefore: string; uiAfter: string; beforeLocator: string; afterLocator: string; confidence: number }>>({});
  const [healState, setHealState] = useState<Record<string, { detection?: any; healResult?: any; actions?: any[] }>>({});
  const [dashboard, setDashboard] = useState<any>(null);
  const [flakyTests, setFlakyTests] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<any>(null);
  const [hoursSaved, setHoursSaved] = useState<any>(null);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [integrationDraft, setIntegrationDraft] = useState({ type: "jira", base_url: "", webhook_url: "", token: "", org_id: "", notify_on_run: false });
  const [gitHistory, setGitHistory] = useState<Record<string, any[]>>({});
  const [users, setUsers] = useState<any[]>([]);
  const [currentUser, setCurrentUser] = useState(getCurrentUserId());
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [flaggedForReReview, setFlaggedForReReview] = useState<any[]>([]);
  const [frameworkChoice, setFrameworkChoice] = useState<Record<string, "playwright" | "selenium" | "cypress">>({});

  async function refreshAll() {
    const [i, t, s, r, p, q] = await Promise.all([
      api.listInputs(),
      api.listTestCases(),
      api.listScripts(),
      api.listRuns(),
      api.listExecutionProfiles(),
      api.listExecutionQueue(),
    ]);
    setInputs(i);
    setTestCases(t);
    setScripts(s);
    setRuns(r);
    setProfiles(p);
    setQueueEntries(q);
    if (!selectedProfileId && p.length > 0) {
      const suggestion = await api.suggestExecutionProfile({ trigger_source: "ui" });
      setSelectedProfileId(suggestion?.profile?.id || p[0].id);
    }
    await refreshReporting();
  }

  async function refreshReporting() {
    const [d, f, c, h] = await Promise.all([
      api.getDashboard(),
      api.getFlakyTests(),
      api.getCoverage(),
      api.getHoursSaved(),
    ]);
    setDashboard(d);
    setFlakyTests(f.filter((row: any) => row.isFlaky));
    setCoverage(c);
    setHoursSaved(h);
    setIntegrations(await api.listIntegrations());
    setUsers(await api.listUsers().catch(() => []));
    setAuditLog(await api.listAuditLog().catch(() => []));
    setFlaggedForReReview(await api.listFlaggedForReReview().catch(() => []));
  }

  function switchUser(id: string) {
    setCurrentUserId(id);
    setCurrentUser(id);
    refreshAll().catch((e) => setError(e.message));
  }

  useEffect(() => {
    refreshAll().catch((e) => setError(e.message));
    api.getAgreementRate().then((data) => setAgreementRate(data.agreementRate)).catch(() => undefined);
  }, []);

  async function withBusy(key: string, fn: () => Promise<any>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refreshAll();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile() {
    const payload = {
      ...profileDraft,
      concurrency: Number(profileDraft.concurrency),
      retention_days: Number(profileDraft.retention_days),
      reserved_runner_count: Number(profileDraft.reserved_runner_count),
      headless_mode: profileDraft.headless_mode ? 1 : 0,
      reuse_browser_instances: profileDraft.reuse_browser_instances ? 1 : 0,
      is_default_for_team: profileDraft.is_default_for_team ? 1 : 0,
      is_default_for_suite: profileDraft.is_default_for_suite ? 1 : 0,
    };
    if (editingProfileId) {
      await api.updateExecutionProfile(editingProfileId, payload);
    } else {
      await api.createExecutionProfile(payload);
    }
    setEditingProfileId(null);
    setProfileDraft({
      name: "",
      description: "",
      browser_set: "chromium",
      concurrency: 1,
      artifact_capture_mode: "logs-only",
      retention_days: 30,
      selection_mode: "full-suite",
      retry_strategy: "no-retry",
      provider: "local",
      runner_pool_name: "",
      reserved_runner_count: 0,
      headless_mode: 1,
      reuse_browser_instances: 0,
      is_default_for_team: 0,
      is_default_for_suite: 0,
    });
    await refreshAll();
  }

  async function deleteProfile(id: string) {
    await api.deleteExecutionProfile(id);
    if (selectedProfileId === id) setSelectedProfileId("");
    await refreshAll();
  }

  const scriptByTestCase = Object.fromEntries(scripts.map((s) => [s.test_case_id, s]));
  const runsByScript: Record<string, ExecutionRunRow[]> = {};
  for (const r of runs) (runsByScript[r.script_id] ??= []).push(r);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-paper/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <p className="font-display text-xs text-signal tracking-widest uppercase">MVP Core Pipeline</p>
            <h1 className="font-display text-xl tracking-tight">AI Test Automation Platform</h1>
          </div>
          <div className="flex items-center gap-2">
            {users.length > 0 && (
              <select
                className="rounded-md border border-line bg-white/60 p-1.5 text-xs"
                value={currentUser}
                onChange={(e) => switchUser(e.target.value)}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            )}
            {error && <Pill tone="bad">⚠ {error}</Pill>}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        {agreementRate !== null && (
          <div className="rounded-lg border border-line bg-white/70 p-3 text-sm text-ink/70">
            Review agreement rate: <span className="font-semibold text-ink">{agreementRate}%</span>
          </div>
        )}
        {/* Stage 1: Ingestion */}
        <section>
          <StageHeader n={1} title="Ingest" subtitle="Free-text scenario or ticket description (FR-1.7)" />
          <textarea
            className="w-full rounded-md border border-line bg-white/60 p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-signal"
            rows={4}
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-md bg-ink text-paper px-4 py-2 text-sm font-medium hover:bg-ink/90 disabled:opacity-50"
              disabled={busy === "ingest"}
              onClick={() =>
                withBusy("ingest", async () => {
                  const text = draftInput.trim();
                  const input = await api.createInput(text || "Upload context from screenshots/videos or free text.", "free_text", businessRules.trim());
                  if (screenshots.length > 0 || videos.length > 0) {
                    await api.uploadFiles(screenshots, videos);
                  }
                  await api.generateTestCases(input.id);
                })
              }
            >
              {busy === "ingest" ? "Generating test cases…" : "Submit & generate test cases"}
            </button>
            <p className="text-xs text-ink/60">This runs before the review stage.</p>
          </div>

          <div className="mt-6 rounded-lg border border-line bg-white/60 p-4 space-y-3">
            <p className="text-sm font-medium">Batch inputs</p>
            <p className="text-xs text-ink/60">Upload screenshots/videos together, crawl a URL, or import Swagger/Postman/OpenAPI data.</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border border-line bg-white/50 p-3">
                <p className="text-sm font-medium">Screenshots</p>
                <p className="text-xs text-ink/60 mt-1">Add one or multiple screenshots at a time.</p>
                <input
                  className="mt-2 block w-full text-sm"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg"
                  multiple
                  onChange={(e) => setScreenshots(Array.from(e.target.files ?? []))}
                />
                {screenshots.length > 0 && (
                  <p className="mt-2 text-xs text-ink/60">Selected: {screenshots.map((f) => f.name).join(", ")}</p>
                )}
                <button
                  className="mt-3 rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium"
                  onClick={() => withBusy("screenshots", async () => {
                    if (screenshots.length === 0) {
                      setError("No screenshots selected. You can skip this step if you do not want to upload screenshots.");
                      return;
                    }
                    await api.uploadFiles(screenshots, []);
                  })}
                >
                  Upload screenshots
                </button>
              </div>
              <div className="rounded-md border border-line bg-white/50 p-3">
                <p className="text-sm font-medium">Videos</p>
                <p className="text-xs text-ink/60 mt-1">Add one or multiple videos at a time.</p>
                <input
                  className="mt-2 block w-full text-sm"
                  type="file"
                  accept="video/mp4,video/webm,video/avi,video/mov"
                  multiple
                  onChange={(e) => setVideos(Array.from(e.target.files ?? []))}
                />
                {videos.length > 0 && (
                  <p className="mt-2 text-xs text-ink/60">Selected: {videos.map((f) => f.name).join(", ")}</p>
                )}
                <button
                  className="mt-3 rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium"
                  onClick={() => withBusy("videos", async () => {
                    if (videos.length === 0) {
                      setError("No videos selected. You can skip this step if you do not want to upload videos.");
                      return;
                    }
                    await api.uploadFiles([], videos);
                  })}
                >
                  Upload videos
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium"
                onClick={() => withBusy("crawl", async () => {
                  if (!batchUrl.trim()) throw new Error("Enter a URL first.");
                  await api.crawlUrl(batchUrl.trim());
                })}
              >
                Crawl URL
              </button>
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium"
                onClick={() => withBusy("openapi", async () => {
                  if (!openApiText.trim()) throw new Error("Paste OpenAPI/Swagger content first.");
                  await api.importOpenApi(openApiText.trim());
                })}
              >
                Import OpenAPI
              </button>
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium"
                onClick={() => withBusy("postman", async () => {
                  if (!postmanText.trim()) throw new Error("Paste a Postman collection first.");
                  await api.importPostman(postmanText.trim());
                })}
              >
                Import Postman
              </button>
            </div>
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
              rows={3}
              placeholder="Business rules / approval thresholds"
              value={businessRules}
              onChange={(e) => setBusinessRules(e.target.value)}
            />
            <input
              className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
              placeholder="https://example.com"
              value={batchUrl}
              onChange={(e) => setBatchUrl(e.target.value)}
            />
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
              rows={4}
              placeholder="Paste Swagger/OpenAPI JSON/YAML here"
              value={openApiText}
              onChange={(e) => setOpenApiText(e.target.value)}
            />
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
              rows={4}
              placeholder="Paste a Postman collection JSON here"
              value={postmanText}
              onChange={(e) => setPostmanText(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={externalProvider} onChange={(e) => setExternalProvider(e.target.value as "jira" | "azure") }>
                <option value="jira">Jira</option>
                <option value="azure">Azure DevOps</option>
              </select>
              <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="https://company.atlassian.net" value={externalBaseUrl} onChange={(e) => setExternalBaseUrl(e.target.value)} />
              <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="token" value={externalToken} onChange={(e) => setExternalToken(e.target.value)} />
              <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="ABC-123, DEF-456" value={externalIssueIds} onChange={(e) => setExternalIssueIds(e.target.value)} />
            </div>
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium"
              onClick={() => withBusy("external", async () => {
                if (!externalBaseUrl.trim() || !externalToken.trim() || !externalIssueIds.trim()) throw new Error("Provide base URL, token, and issue IDs.");
                await api.importExternal(externalProvider, externalBaseUrl.trim(), externalToken.trim(), externalIssueIds.trim());
              })}
            >
              Import external work items
            </button>
          </div>

          {inputs.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm text-ink/70">
              {inputs.map((i) => (
                <li key={i.id} className="flex gap-2">
                  <span className="font-mono text-xs text-ink/40">{i.id}</span>
                  <span className="truncate">{i.content}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Stage 2: Review */}
        <section>
          <StageHeader n={2} title="Review & approve" subtitle="Accept, edit, or reject each generated test case (FR-2.4 / FR-2.8)" />
          {testCases.length === 0 && <p className="text-sm text-ink/50">No test cases yet — submit an input above.</p>}
          <div className="space-y-3">
            {testCases.map((tc) => (
              <div key={tc.id} className="rounded-lg border border-line bg-white/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs rounded-full border px-2 py-0.5 ${CATEGORY_COLOR[tc.category] ?? "bg-ink/5"}`}>
                        {tc.category}
                      </span>
                      <Pill tone={tc.status === "accepted" || tc.status === "edited" ? "good" : tc.status === "rejected" ? "bad" : "neutral"}>
                        {tc.status}
                      </Pill>
                      <Pill>conf {Math.round(tc.confidence_score * 100)}%</Pill>
                      <Pill tone={tc.authorship_type === "human" ? "good" : tc.authorship_type === "edited" ? "warn" : "neutral"}>
                        {tc.authorship_type === "human" ? "human-authored" : tc.authorship_type === "edited" ? "human-edited" : "AI-generated"}
                      </Pill>
                      {(tc as any).critical_path ? <Pill tone="warn">critical path</Pill> : null}
                      {(tc as any).flagged_for_re_review ? <Pill tone="warn">flagged for re-review</Pill> : null}
                    </div>
                    <h3 className="font-medium mt-1">{tc.title}</h3>
                    <p className="mt-1 text-xs text-ink/50">Priority: {tc.priority ?? "Medium"} • Version {tc.version}</p>
                    {tc.traceability_context && <p className="mt-2 text-xs text-ink/50">Traceability: {JSON.stringify(tc.traceability_context)}</p>}
                    {tc.explanation && <p className="mt-2 text-sm text-ink/70">{tc.explanation}</p>}
                    <ol className="mt-2 text-sm text-ink/70 list-decimal list-inside space-y-0.5">
                      {tc.steps.map((s, idx) => (
                        <li key={idx} className="step-count">{s}</li>
                      ))}
                    </ol>
                    <p className="text-sm mt-2"><span className="text-ink/50">Expected: </span>{tc.expected_result}</p>
                    <p className="text-xs text-ink/40 mt-2 italic">{tc.source_rationale}</p>
                  </div>
                </div>

                <div className="mt-3 space-y-2 rounded-md border border-line bg-white/60 p-3">
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="rounded-md border border-line bg-white/60 p-2 text-sm"
                      placeholder="Edit title"
                      value={reviewDrafts[tc.id]?.title ?? tc.title}
                      onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [tc.id]: { ...prev[tc.id], title: e.target.value } }))}
                    />
                    <select
                      className="rounded-md border border-line bg-white/60 p-2 text-sm"
                      value={reviewDrafts[tc.id]?.category ?? tc.category}
                      onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [tc.id]: { ...prev[tc.id], category: e.target.value } }))}
                    >
                      <option value="Smoke">Smoke</option>
                      <option value="Regression">Regression</option>
                      <option value="Functional">Functional/UserStory</option>
                      <option value="Edge Case">EdgeCase</option>
                      <option value="Negative">Negative</option>
                      <option value="API">API-specific</option>
                    </select>
                    <select
                      className="rounded-md border border-line bg-white/60 p-2 text-sm"
                      value={reviewDrafts[tc.id]?.priority ?? tc.priority ?? "Medium"}
                      onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [tc.id]: { ...prev[tc.id], priority: e.target.value } }))}
                    >
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                    </select>
                  </div>
                  <textarea
                    className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                    rows={2}
                    placeholder="Reviewer notes"
                    value={reviewNotes[tc.id] ?? ""}
                    onChange={(e) => setReviewNotes((prev) => ({ ...prev, [tc.id]: e.target.value }))}
                  />
                  <textarea
                    className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                    rows={2}
                    placeholder="Edit steps (one per line)"
                    value={(reviewDrafts[tc.id]?.steps ?? tc.steps).join("\n")}
                    onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [tc.id]: { ...prev[tc.id], steps: e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean) } }))}
                  />
                  <textarea
                    className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
                    rows={2}
                    placeholder="Edit expected result"
                    value={reviewDrafts[tc.id]?.expected_result ?? tc.expected_result}
                    onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [tc.id]: { ...prev[tc.id], expected_result: e.target.value } }))}
                  />
                </div>

                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal/10 disabled:opacity-40"
                    disabled={tc.status === "accepted"}
                    onClick={() => withBusy(`accept-${tc.id}`, async () => {
                      const result = await api.reviewTestCase(tc.id, "accept", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
                      setReviewDetails((prev) => ({ ...prev, [tc.id]: result.diff }));
                      return result;
                    })}
                  >
                    Accept
                  </button>
                  <button
                    className="rounded-md border border-alert text-alert px-3 py-1.5 text-xs font-medium hover:bg-alert/10 disabled:opacity-40"
                    disabled={tc.status === "rejected"}
                    onClick={() => withBusy(`reject-${tc.id}`, async () => {
                      const result = await api.reviewTestCase(tc.id, "reject", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
                      setReviewDetails((prev) => ({ ...prev, [tc.id]: result.diff }));
                      return result;
                    })}
                  >
                    Reject
                  </button>
                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={() => withBusy(`discuss-${tc.id}`, async () => {
                      const result = await api.reviewTestCase(tc.id, "needs_discussion", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
                      setReviewDetails((prev) => ({ ...prev, [tc.id]: result.diff }));
                      return result;
                    })}
                  >
                    Needs discussion
                  </button>

                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={async () => {
                      const text = await api.exportTestCaseCsv(tc.id);
                      const blob = new Blob([text], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = `${tc.id}.csv`;
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Export CSV
                  </button>

                  <button
                    className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal/10"
                    onClick={() => withBusy(`excel-${tc.id}`, () => api.exportTestCaseXlsx(tc.id))}
                  >
                    Export XLSX
                  </button>

                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={() => withBusy(`explain-${tc.id}`, async () => {
                      const explanation = `This ${tc.category.toLowerCase()} case focuses on ${tc.title.toLowerCase()} because the steps and expected result validate the core workflow from the source input.`;
                      const result = await api.reviewTestCase(tc.id, "edit", { ...reviewDrafts[tc.id], title: reviewDrafts[tc.id]?.title ?? tc.title, category: reviewDrafts[tc.id]?.category ?? tc.category, steps: reviewDrafts[tc.id]?.steps ?? tc.steps, expected_result: reviewDrafts[tc.id]?.expected_result ?? tc.expected_result, priority: reviewDrafts[tc.id]?.priority ?? tc.priority ?? "Medium" }, reviewNotes[tc.id], tc.version);
                      setReviewDetails((prev) => ({ ...prev, [tc.id]: result.diff }));
                      return result;
                    })}
                  >
                    Explain this test case
                  </button>

                  <button
                    className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal/10"
                    onClick={() => withBusy(`sync-${tc.id}`, async () => {
                      const provider = externalProvider;
                      await api.syncTestCase(tc.id, provider, externalBaseUrl.trim(), externalToken.trim());
                    })}
                  >
                    Sync to {externalProvider === "jira" ? "Jira" : "Azure DevOps"}
                  </button>

                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={() => withBusy(`critical-${tc.id}`, () => api.setCriticalPath(tc.id, !(tc as any).critical_path))}
                  >
                    {(tc as any).critical_path ? "Unmark critical path" : "Mark critical path (FR-8.6)"}
                  </button>

                  {(tc as any).second_reviewer_required ? (
                    <>
                      <Pill tone={(tc as any).second_reviewer_status === "approved" ? "good" : (tc as any).second_reviewer_status === "rejected" ? "bad" : "warn"}>
                        2nd reviewer: {(tc as any).second_reviewer_status ?? "pending"}
                      </Pill>
                      <button
                        className="rounded-md border border-signal text-signal px-2 py-1.5 text-xs font-medium hover:bg-signal/10"
                        onClick={() => withBusy(`signoff-approve-${tc.id}`, () => api.secondReviewerSignOff(tc.id, "approved"))}
                      >
                        Sign off (approve)
                      </button>
                      <button
                        className="rounded-md border border-alert text-alert px-2 py-1.5 text-xs font-medium hover:bg-alert/10"
                        onClick={() => withBusy(`signoff-reject-${tc.id}`, () => api.secondReviewerSignOff(tc.id, "rejected"))}
                      >
                        Sign off (reject)
                      </button>
                    </>
                  ) : null}

                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={() => withBusy(`route-${tc.id}`, () => api.routeTestCaseToOwner(tc.id))}
                  >
                    Route to owner (FR-8.5)
                  </button>

                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    onClick={() => withBusy(`regen-${tc.id}`, async () => {
                      const result = await api.regenerateTestCase(tc.id);
                      setReviewDetails((prev) => ({ ...prev, [tc.id]: result.diff }));
                    })}
                  >
                    Regenerate (FR-2.6)
                  </button>

                  {(tc.status === "accepted" || tc.status === "edited") && !scriptByTestCase[tc.id] && (
                    <>
                      <select
                        className="rounded-md border border-line bg-white/60 p-1.5 text-xs"
                        value={frameworkChoice[tc.id] ?? "playwright"}
                        onChange={(e) => setFrameworkChoice((prev) => ({ ...prev, [tc.id]: e.target.value as any }))}
                      >
                        <option value="playwright">Playwright (TS/JS/Python)</option>
                        <option value="selenium">Selenium</option>
                        <option value="cypress">Cypress</option>
                      </select>
                      <button
                        className="ml-auto rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90 disabled:opacity-50"
                        disabled={busy === `codegen-${tc.id}`}
                        onClick={() => withBusy(`codegen-${tc.id}`, () => api.generateScript(tc.id, frameworkChoice[tc.id]))}
                      >
                        {busy === `codegen-${tc.id}` ? "Generating script…" : "Generate script →"}
                      </button>
                    </>
                  )}
                </div>

                {reviewDetails[tc.id] && (
                  <div className="mt-3 rounded-md border border-line bg-white/60 p-3 text-xs text-ink/70">
                    <p className="font-medium">Review diff</p>
                    <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(reviewDetails[tc.id], null, 2)}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Stage 3: Automation + Execution */}
        <section>
          <StageHeader n={3} title="Automate & run" subtitle="Generated Playwright scripts, static scan status, and execution results" />

          <div className="rounded-lg border border-line bg-white/60 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Execution profiles</p>
                <p className="text-xs text-ink/60">Create reusable run profiles for browser sets, retries, artifacts, and CI/CD usage.</p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-md border border-line bg-white/50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Profile editor</p>
                <input className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Profile name" value={profileDraft.name} onChange={(e) => setProfileDraft((prev) => ({ ...prev, name: e.target.value }))} />
                <textarea className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" rows={2} placeholder="Description" value={profileDraft.description} onChange={(e) => setProfileDraft((prev) => ({ ...prev, description: e.target.value }))} />
                <select className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.browser_set} onChange={(e) => setProfileDraft((prev) => ({ ...prev, browser_set: e.target.value }))}>
                  <option value="chromium">Chromium only</option>
                  <option value="chromium+firefox">Chromium + Firefox</option>
                  <option value="all">All three engines</option>
                  <option value="headless">Headless</option>
                </select>
                <div className="grid gap-2 sm:grid-cols-2">
                  <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.artifact_capture_mode} onChange={(e) => setProfileDraft((prev) => ({ ...prev, artifact_capture_mode: e.target.value }))}>
                    <option value="logs-only">Logs only</option>
                    <option value="failures-only">Failures only</option>
                    <option value="all-screenshots">All screenshots</option>
                    <option value="video-failures">Video failures</option>
                    <option value="video-all">Video all</option>
                    <option value="full-debug">Full debug</option>
                  </select>
                  <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.selection_mode} onChange={(e) => setProfileDraft((prev) => ({ ...prev, selection_mode: e.target.value }))}>
                    <option value="full-suite">Full suite</option>
                    <option value="smart-selection">Smart selection</option>
                    <option value="custom-selection">Custom selection</option>
                    <option value="flaky-tests-only">Flaky tests only</option>
                    <option value="scheduled-regression">Scheduled regression</option>
                  </select>
                  <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.retry_strategy} onChange={(e) => setProfileDraft((prev) => ({ ...prev, retry_strategy: e.target.value }))}>
                    <option value="no-retry">No retry</option>
                    <option value="retry-flaky">Retry flaky</option>
                    <option value="retry-all">Retry all</option>
                    <option value="smart-retry">Smart retry</option>
                  </select>
                  <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.provider} onChange={(e) => setProfileDraft((prev) => ({ ...prev, provider: e.target.value }))}>
                    <option value="local">Local</option>
                    <option value="ci">CI</option>
                    <option value="cloud">Cloud</option>
                  </select>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="1" max="20" value={profileDraft.concurrency} onChange={(e) => setProfileDraft((prev) => ({ ...prev, concurrency: Number(e.target.value) }))} />
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="1" max="365" value={profileDraft.retention_days} onChange={(e) => setProfileDraft((prev) => ({ ...prev, retention_days: Number(e.target.value) }))} />
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="0" value={profileDraft.reserved_runner_count} onChange={(e) => setProfileDraft((prev) => ({ ...prev, reserved_runner_count: Number(e.target.value) }))} />
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Runner pool" value={profileDraft.runner_pool_name} onChange={(e) => setProfileDraft((prev) => ({ ...prev, runner_pool_name: e.target.value }))} />
                </div>
                <label className="flex items-center gap-2 text-sm text-ink/70">
                  <input type="checkbox" checked={profileDraft.headless_mode === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, headless_mode: e.target.checked ? 1 : 0 }))} />
                  Headless mode
                </label>
                <label className="flex items-center gap-2 text-sm text-ink/70">
                  <input type="checkbox" checked={profileDraft.reuse_browser_instances === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, reuse_browser_instances: e.target.checked ? 1 : 0 }))} />
                  Reuse browser instances
                </label>
                <label className="flex items-center gap-2 text-sm text-ink/70">
                  <input type="checkbox" checked={profileDraft.is_default_for_team === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, is_default_for_team: e.target.checked ? 1 : 0 }))} />
                  Default for team
                </label>
                <div className="flex gap-2">
                  <button className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium" onClick={() => withBusy("profile-save", saveProfile)}>{editingProfileId ? "Save profile" : "Create profile"}</button>
                  {editingProfileId && <button className="rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => { setEditingProfileId(null); setProfileDraft({ name: "", description: "", browser_set: "chromium", concurrency: 1, artifact_capture_mode: "logs-only", retention_days: 30, selection_mode: "full-suite", retry_strategy: "no-retry", provider: "local", runner_pool_name: "", reserved_runner_count: 0, headless_mode: 1, reuse_browser_instances: 0, is_default_for_team: 0, is_default_for_suite: 0 }); }}>Cancel</button>}
                </div>
              </div>
              <div className="space-y-2 rounded-md border border-line bg-white/50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Active run profile</p>
                <select className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                <p className="text-xs text-ink/60">Select a profile before queueing or running a generated script.</p>
                <div className="space-y-2">
                  {profiles.map((profile) => (
                    <div key={profile.id} className="rounded-md border border-line bg-white/60 p-2 text-xs text-ink/70">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{profile.name}</span>
                        <span className="text-ink/40">{profile.browser_set}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button className="rounded border border-line px-2 py-1" onClick={() => { setEditingProfileId(profile.id); setProfileDraft({ name: profile.name, description: profile.description || "", browser_set: profile.browser_set, concurrency: profile.concurrency, artifact_capture_mode: profile.artifact_capture_mode, retention_days: profile.retention_days, selection_mode: profile.selection_mode, retry_strategy: profile.retry_strategy, provider: profile.provider, runner_pool_name: profile.runner_pool_name || "", reserved_runner_count: profile.reserved_runner_count, headless_mode: profile.headless_mode, reuse_browser_instances: profile.reuse_browser_instances, is_default_for_team: profile.is_default_for_team, is_default_for_suite: profile.is_default_for_suite }); }}>Edit</button>
                        <button className="rounded border border-line px-2 py-1" onClick={() => deleteProfile(profile.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {queueEntries.length > 0 && (
              <div className="rounded-md border border-line bg-white/50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Queue</p>
                <ul className="mt-2 space-y-1 text-xs text-ink/70">
                  {queueEntries.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-2">
                      <span>#{entry.queue_position ?? 0} • {entry.id}</span>
                      <span>{entry.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {scripts.length === 0 && <p className="text-sm text-ink/50">No automation scripts yet — accept a test case above and generate a script.</p>}
          <div className="space-y-4">
            {scripts.map((s) => {
              const tc = testCases.find((t) => t.id === s.test_case_id);
              const scriptRuns = runsByScript[s.id] ?? [];
              const latest = scriptRuns[0];
              return (
                <div key={s.id} className="rounded-lg border border-line bg-white/50 p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="font-medium">{tc?.title ?? s.test_case_id}</p>
                      <p className="text-xs text-ink/40 font-mono">{s.file_path.split("/").slice(-2).join("/")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={s.security_scan_status === "passed" ? "good" : "bad"}>
                        scan: {s.security_scan_status}
                      </Pill>
                      {latest && (
                        <Pill tone={latest.status === "passed" ? "good" : latest.status === "blocked" ? "warn" : "bad"}>
                          last run: {latest.status}
                        </Pill>
                      )}
                    </div>
                  </div>

                  <details className="mt-2">
                    <summary className="text-xs text-signal cursor-pointer select-none">View generated code</summary>
                    <pre className="mt-2 text-xs bg-ink text-paper rounded-md p-3 overflow-x-auto">{s.code}</pre>
                  </details>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded-md bg-signal text-white px-3 py-1.5 text-xs font-medium hover:bg-signal/90 disabled:opacity-50"
                      disabled={busy === `run-${s.id}` || s.security_scan_status === "flagged"}
                      onClick={() => withBusy(`run-${s.id}`, () => api.runScript(s.id, undefined, { profile_id: selectedProfileId || undefined, trigger_source: "ui" }))}
                    >
                      {busy === `run-${s.id}` ? "Running…" : "Run test"}
                    </button>
                    <button
                      className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                      disabled={busy === `queue-${s.id}` || s.security_scan_status === "flagged"}
                      onClick={() => withBusy(`queue-${s.id}`, () => api.queueScript(s.id, undefined, { profile_id: selectedProfileId || undefined, trigger_source: "ui" }))}
                    >
                      {busy === `queue-${s.id}` ? "Queueing…" : "Queue run"}
                    </button>
                  </div>

                  {scriptRuns.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {scriptRuns.slice(0, 3).map((r) => (
                        <div key={r.id} className="text-xs text-ink/60 flex gap-2 items-center">
                          <Pill tone={r.status === "passed" ? "good" : r.status === "blocked" ? "warn" : "bad"}>{r.status}</Pill>
                          <span>{r.duration_ms ?? 0}ms</span>
                          <span className="text-ink/30">{new Date(r.created_at).toLocaleTimeString()}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <details className="mt-3 rounded-md border border-line bg-white/50 p-3">
                    <summary className="text-xs font-medium text-signal cursor-pointer select-none">
                      Change detection &amp; self-healing (FR-5.x)
                    </summary>
                    {(() => {
                      const draft = healDrafts[s.test_case_id] ?? { uiBefore: "", uiAfter: "", beforeLocator: "", afterLocator: "", confidence: 0.9 };
                      const state = healState[s.test_case_id] ?? {};
                      const setDraft = (patch: Partial<typeof draft>) =>
                        setHealDrafts((prev) => ({ ...prev, [s.test_case_id]: { ...draft, ...patch } }));
                      return (
                        <div className="mt-2 space-y-2 text-xs">
                          <p className="text-ink/50">Paste the before/after DOM snippet for the element this test targets, then run detection.</p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <textarea
                              className="w-full rounded-md border border-line bg-white/60 p-2"
                              rows={2}
                              placeholder='UI before, e.g. <input id="username" />'
                              value={draft.uiBefore}
                              onChange={(e) => setDraft({ uiBefore: e.target.value })}
                            />
                            <textarea
                              className="w-full rounded-md border border-line bg-white/60 p-2"
                              rows={2}
                              placeholder='UI after, e.g. <input id="user-name" />'
                              value={draft.uiAfter}
                              onChange={(e) => setDraft({ uiAfter: e.target.value })}
                            />
                          </div>
                          <button
                            className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 font-medium hover:bg-ink/5"
                            onClick={() => withBusy(`detect-${s.test_case_id}`, async () => {
                              const detection = await api.detectChanges(s.test_case_id, { uiBeforeHtml: draft.uiBefore, uiAfterHtml: draft.uiAfter, source: "manual" });
                              setHealState((prev) => ({ ...prev, [s.test_case_id]: { ...prev[s.test_case_id], detection } }));
                            })}
                          >
                            Run change detection
                          </button>

                          {state.detection && (
                            <div className="rounded-md border border-line bg-white/60 p-2">
                              <p>
                                Detected: <span className="font-medium">{String(state.detection.detected)}</span> • types: {state.detection.changeTypes?.join(", ") || "none"} •
                                confidence <span className="font-medium">{Math.round(state.detection.confidenceScore * 100)}%</span>
                              </p>
                            </div>
                          )}

                          {state.detection && (
                            <div className="grid gap-2 sm:grid-cols-3 items-end">
                              <input
                                className="rounded-md border border-line bg-white/60 p-2"
                                placeholder="Before locator, e.g. getByLabel('Username')"
                                value={draft.beforeLocator}
                                onChange={(e) => setDraft({ beforeLocator: e.target.value })}
                              />
                              <input
                                className="rounded-md border border-line bg-white/60 p-2"
                                placeholder="After locator, e.g. getByTestId('username-input')"
                                value={draft.afterLocator}
                                onChange={(e) => setDraft({ afterLocator: e.target.value })}
                              />
                              <input
                                className="rounded-md border border-line bg-white/60 p-2"
                                type="number"
                                min={0}
                                max={1}
                                step={0.01}
                                value={draft.confidence}
                                onChange={(e) => setDraft({ confidence: Number(e.target.value) })}
                              />
                            </div>
                          )}

                          {state.detection && (
                            <button
                              className="rounded-md bg-ink text-paper px-3 py-1.5 font-medium hover:bg-ink/90 disabled:opacity-50"
                              disabled={!draft.beforeLocator || !draft.afterLocator}
                              onClick={() => withBusy(`heal-${s.test_case_id}`, async () => {
                                const healResult = await api.healTestCase(s.test_case_id, {
                                  detectionId: state.detection.id,
                                  beforeLocator: draft.beforeLocator,
                                  afterLocator: draft.afterLocator,
                                  confidence: draft.confidence,
                                  reason: "manual locator update",
                                });
                                const actions = await api.listHealActions(s.test_case_id);
                                setHealState((prev) => ({ ...prev, [s.test_case_id]: { ...prev[s.test_case_id], healResult, actions } }));
                              })}
                            >
                              {draft.confidence >= 0.8 ? "Apply auto-heal" : "Flag for regeneration (below threshold)"}
                            </button>
                          )}

                          {state.healResult && (
                            <div className={`rounded-md border p-2 ${state.healResult.applied ? "border-signal/30 bg-signal/5" : "border-amber-300 bg-amber-50"}`}>
                              {state.healResult.applied
                                ? "Locator healed automatically and the script + test case were updated together (FR-5.5)."
                                : "Confidence below threshold — flagged for regeneration instead of auto-applying (FR-5.4)."}
                            </div>
                          )}

                          {(state.actions ?? []).length > 0 && (
                            <div className="space-y-1">
                              <p className="font-medium text-ink/60">Heal history</p>
                              {(state.actions ?? []).map((action: any) => (
                                <div key={action.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/60 p-2">
                                  <span>
                                    {action.applied ? "applied" : "flagged"} • conf {Math.round(action.confidence_score * 100)}% • {new Date(action.created_at).toLocaleTimeString()}
                                    {action.rolled_back ? " • rolled back" : ""}
                                  </span>
                                  {!action.rolled_back && action.applied === 1 && (
                                    <button
                                      className="rounded border border-alert text-alert px-2 py-1"
                                      onClick={() => withBusy(`rollback-${action.id}`, async () => {
                                        await api.rollbackHeal(action.id);
                                        const actions = await api.listHealActions(s.test_case_id);
                                        setHealState((prev) => ({ ...prev, [s.test_case_id]: { ...prev[s.test_case_id], actions } }));
                                      })}
                                    >
                                      Rollback
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </details>
                </div>
              );
            })}
          </div>
        </section>

        {/* Stage 4: Reporting & analytics */}
        <section>
          <StageHeader n={4} title="Reporting & analytics" subtitle="Dashboards, flaky tests, requirement coverage, hours saved (Module 6)" />

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-white/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Execution summary (FR-6.1)</p>
              {dashboard ? (
                <>
                  <p className="mt-2 text-2xl font-display">{dashboard.passRate}%</p>
                  <p className="text-xs text-ink/50">pass rate across {dashboard.totalRuns} run(s)</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <Pill tone="good">passed {dashboard.totals.passed}</Pill>
                    <Pill tone="bad">failed {dashboard.totals.failed}</Pill>
                    <Pill tone="warn">blocked {dashboard.totals.blocked}</Pill>
                    <Pill>error {dashboard.totals.error}</Pill>
                  </div>
                  {dashboard.executionTimeTrend.length > 0 && (
                    <div className="mt-3 space-y-1 text-xs text-ink/60">
                      {dashboard.executionTimeTrend.map((t: any) => (
                        <div key={t.day} className="flex items-center justify-between">
                          <span>{t.day}</span>
                          <span>{t.runs} run(s) • avg {t.avgDurationMs}ms</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm text-ink/50">No runs yet.</p>
              )}
            </div>

            <div className="rounded-lg border border-line bg-white/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Hours saved this sprint (FR-6.6)</p>
              {hoursSaved ? (
                <>
                  <p className="mt-2 text-2xl font-display">{hoursSaved.hoursSaved}h</p>
                  <p className="text-xs text-ink/50">
                    estimated manual {hoursSaved.estimatedManualHours}h vs. actual automated {hoursSaved.actualAutomatedHours}h across {hoursSaved.testCaseCount} approved test case(s)
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-ink/50">No approved test cases yet.</p>
              )}
            </div>

            <div className="rounded-lg border border-line bg-white/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Flaky tests (FR-6.2)</p>
              {flakyTests.length === 0 ? (
                <p className="mt-2 text-sm text-ink/50">None detected.</p>
              ) : (
                <div className="mt-2 space-y-1 text-xs text-ink/70">
                  {flakyTests.map((f) => (
                    <div key={f.scriptId} className="flex items-center justify-between">
                      <span className="font-mono text-ink/40">{f.scriptId}</span>
                      <Pill tone="warn">{f.passCount} pass / {f.failCount} fail</Pill>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-line bg-white/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Requirement coverage (FR-6.3)</p>
              {coverage ? (
                <>
                  <p className="mt-2 text-2xl font-display">{coverage.coveragePercent}%</p>
                  <p className="text-xs text-ink/50">
                    {coverage.coveredByApprovedTestCase} of {coverage.totalTicketsReferenced} referenced ticket(s) have an approved test case
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-ink/50">No tickets referenced yet.</p>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5" onClick={() => withBusy("refresh-reporting", refreshReporting)}>
              Refresh
            </button>
            <button className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal/10" onClick={() => withBusy("export-pdf", api.exportReleaseReportPdf)}>
              Export release report (PDF)
            </button>
            <button className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal/10" onClick={() => withBusy("export-report-xlsx", api.exportReleaseReportXlsx)}>
              Export release report (XLSX)
            </button>
          </div>
        </section>

        {/* Stage 5: Integrations hub */}
        <section>
          <StageHeader n={5} title="Integrations hub" subtitle="Jira/Azure sync, Slack/Teams notifications, Git-versioned scripts (Module 7)" />

          <div className="rounded-lg border border-line bg-white/60 p-4 space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={integrationDraft.type} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, type: e.target.value }))}>
                <option value="jira">Jira</option>
                <option value="azure">Azure DevOps</option>
                <option value="slack">Slack</option>
                <option value="teams">Teams</option>
              </select>
              {(integrationDraft.type === "jira" || integrationDraft.type === "azure") && (
                <>
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Base URL" value={integrationDraft.base_url} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, base_url: e.target.value }))} />
                  <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Project key / org" value={integrationDraft.org_id} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, org_id: e.target.value }))} />
                </>
              )}
              {(integrationDraft.type === "slack" || integrationDraft.type === "teams") && (
                <input className="rounded-md border border-line bg-white/60 p-2 text-sm sm:col-span-2" placeholder="Webhook URL" value={integrationDraft.webhook_url} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, webhook_url: e.target.value }))} />
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-3 items-center">
              {(integrationDraft.type === "jira" || integrationDraft.type === "azure") && (
                <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="API token" value={integrationDraft.token} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, token: e.target.value }))} />
              )}
              {(integrationDraft.type === "slack" || integrationDraft.type === "teams") && (
                <label className="flex items-center gap-2 text-sm text-ink/70">
                  <input type="checkbox" checked={integrationDraft.notify_on_run} onChange={(e) => setIntegrationDraft((prev) => ({ ...prev, notify_on_run: e.target.checked }))} />
                  Notify on every run (FR-7.3)
                </label>
              )}
              <button
                className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90"
                onClick={() => withBusy("create-integration", async () => {
                  await api.createIntegration(integrationDraft);
                  setIntegrationDraft({ type: "jira", base_url: "", webhook_url: "", token: "", org_id: "", notify_on_run: false });
                })}
              >
                Save integration
              </button>
            </div>

            {integrations.length === 0 ? (
              <p className="text-sm text-ink/50">No integrations configured yet.</p>
            ) : (
              <div className="space-y-1">
                {integrations.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/50 p-2 text-xs">
                    <span>
                      <span className="font-medium uppercase">{i.type}</span>{" "}
                      {i.base_url || i.webhook_url}{" "}
                      {i.token_masked && <span className="text-ink/40 font-mono">token {i.token_masked}</span>}
                      {i.notify_on_run ? <Pill tone="good">notify on run</Pill> : null}
                    </span>
                    <div className="flex gap-2">
                      {(i.type === "slack" || i.type === "teams") && (
                        <button className="rounded border border-line px-2 py-1" onClick={() => withBusy(`test-notify-${i.id}`, () => api.notifyIntegration(i.id, "Test notification from AI Test Automation Platform"))}>
                          Send test notification
                        </button>
                      )}
                      <button className="rounded border border-alert text-alert px-2 py-1" onClick={() => withBusy(`delete-integration-${i.id}`, () => api.deleteIntegration(i.id))}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {scripts.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Per-script sync &amp; version history (FR-7.1/7.2/7.4)</p>
              {scripts.map((s) => {
                const tc = testCases.find((t) => t.id === s.test_case_id);
                const fileName = s.file_path.split(/[\\/]/).slice(-1)[0];
                return (
                  <div key={s.id} className="rounded-md border border-line bg-white/50 p-3 text-xs flex flex-wrap items-center gap-2 justify-between">
                    <span className="font-medium">{tc?.title ?? s.test_case_id}</span>
                    <div className="flex flex-wrap gap-2">
                      {integrations.filter((i) => i.type === "jira" || i.type === "azure").map((i) => (
                        <button
                          key={i.id}
                          className="rounded border border-signal text-signal px-2 py-1"
                          onClick={() => withBusy(`push-${i.id}-${s.test_case_id}`, () => api.pushTestCaseToIntegration(i.id, s.test_case_id))}
                        >
                          Push to {i.type}
                        </button>
                      ))}
                      <button
                        className="rounded border border-ink/20 text-ink/70 px-2 py-1"
                        onClick={() => withBusy(`git-history-${s.id}`, async () => {
                          const history = await api.gitHistoryForScript(fileName);
                          setGitHistory((prev) => ({ ...prev, [s.id]: history }));
                        })}
                      >
                        View git history
                      </button>
                    </div>
                    {gitHistory[s.id] && (
                      <div className="w-full mt-1 space-y-0.5 text-ink/50">
                        {gitHistory[s.id].length === 0 ? (
                          <p>No commits found for {fileName}.</p>
                        ) : (
                          gitHistory[s.id].map((c: any) => (
                            <div key={c.hash} className="font-mono">
                              {c.hash.slice(0, 7)} • {c.date} • {c.message}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Stage 6: Admin & governance */}
        <section>
          <StageHeader n={6} title="Admin & governance" subtitle="RBAC, audit log, and AI-drift re-review sampling (Module 8)" />

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-white/60 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Re-review sampling (FR-8.8)</p>
                <button
                  className="rounded-md border border-ink/20 text-ink/70 px-2 py-1 text-xs font-medium hover:bg-ink/5"
                  onClick={() => withBusy("sample-re-review", () => api.sampleForReReview(3))}
                >
                  Sample 3 for re-review
                </button>
              </div>
              {flaggedForReReview.length === 0 ? (
                <p className="mt-2 text-sm text-ink/50">Nothing currently flagged.</p>
              ) : (
                <div className="mt-2 space-y-1 text-xs text-ink/70">
                  {flaggedForReReview.map((tc: any) => (
                    <div key={tc.id} className="flex items-center justify-between">
                      <span>{tc.title}</span>
                      <Pill tone="warn">flagged</Pill>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-line bg-white/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Users (FR-8.1)</p>
              <div className="mt-2 space-y-1 text-xs text-ink/70">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between">
                    <span>{u.name}</span>
                    <Pill>{u.role}</Pill>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-line bg-white/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Audit log (FR-8.3)</p>
            {auditLog.length === 0 ? (
              <p className="mt-2 text-sm text-ink/50">No governance events recorded yet.</p>
            ) : (
              <div className="mt-2 space-y-1 text-xs text-ink/70 max-h-64 overflow-y-auto">
                {auditLog.map((entry: any) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 border-b border-line/50 pb-1">
                    <span className="font-mono">{entry.action}</span>
                    <span className="text-ink/40">{entry.entity_type}{entry.entity_id ? `:${entry.entity_id}` : ""}</span>
                    <span className="text-ink/40">{entry.actor_role ?? "system"}</span>
                    <span className="text-ink/30">{new Date(entry.created_at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
