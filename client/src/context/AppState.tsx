import React, { createContext, useContext, useEffect, useState } from "react";
import {
  api,
  InputRow,
  TestCaseRow,
  AutomationScriptRow,
  ExecutionRunRow,
  ExecutionProfileRow,
  EnvironmentRow,
  DocumentUploadResult,
  getCurrentUserId,
  setCurrentUserId,
} from "../api.js";

export type Mode = "single" | "enterprise";
export type View = "home" | "run" | "library" | "reports" | "settings";

const PROFILE_DEFAULT = {
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
  default_speed_mode: "fast" as "ultrafast" | "fast",
};

interface HealDraft {
  uiBefore: string;
  uiAfter: string;
  beforeLocator: string;
  afterLocator: string;
  confidence: number;
}

interface AppCtx {
  // view / mode
  view: View;
  setView: (v: View) => void;
  mode: Mode;
  setMode: (m: Mode) => void;

  // data
  inputs: InputRow[];
  testCases: TestCaseRow[];
  scripts: AutomationScriptRow[];
  runs: ExecutionRunRow[];
  profiles: ExecutionProfileRow[];
  // FR-4.28: Environments list, needed for the Fast Mode run trigger's explicit
  // profile+environment confirmation (Execution Settings Panel gate).
  environments: EnvironmentRow[];
  queueEntries: ExecutionRunRow[];
  dashboard: any;
  flakyTests: any[];
  coverage: any;
  hoursSaved: any;
  // FR-4.14: a computed profile suggestion the user hasn't acted on yet -- shown as a
  // dismissible banner (see Execution.tsx) instead of being silently auto-selected.
  suggestedProfile: any | null;
  acceptSuggestedProfile: () => void;
  dismissSuggestedProfile: () => void;
  integrations: any[];
  users: any[];
  auditLog: any[];
  flaggedForReReview: any[];
  agreementRate: number | null;
  gitHistory: Record<string, any[]>;
  setGitHistory: React.Dispatch<React.SetStateAction<Record<string, any[]>>>;

  // FR-4.24/FR-4.25/FR-4.26/FR-4.27: Execution Speed Modes (Ultrafast vs. Fast)
  speedMode: "ultrafast" | "fast";
  setSpeedMode: (m: "ultrafast" | "fast") => void;
  needsReviewLaterCases: TestCaseRow[];
  lastUltrafastResult: any | null;
  runUltrafast: (ref: { scriptId?: string; testCaseId?: string }) => Promise<void>;
  clearUltrafastResult: () => void;

  // profile editor
  selectedProfileId: string;
  setSelectedProfileId: (id: string) => void;
  // FR-4.28: Fast Mode run trigger's explicitly-confirmed Environment selection
  selectedEnvironmentId: string;
  setSelectedEnvironmentId: (id: string) => void;
  editingProfileId: string | null;
  setEditingProfileId: (id: string | null) => void;
  profileDraft: typeof PROFILE_DEFAULT;
  setProfileDraft: React.Dispatch<React.SetStateAction<typeof PROFILE_DEFAULT>>;
  saveProfile: () => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  resetProfileDraft: () => void;

  // ingestion drafts
  draftInput: string;
  setDraftInput: (v: string) => void;
  batchUrl: string;
  setBatchUrl: (v: string) => void;
  crawlUsername: string;
  setCrawlUsername: (v: string) => void;
  crawlPassword: string;
  setCrawlPassword: (v: string) => void;
  crawlSessionToken: string;
  setCrawlSessionToken: (v: string) => void;
  screenshots: File[];
  setScreenshots: (v: File[]) => void;
  videos: File[];
  setVideos: (v: File[]) => void;
  uploadedFiles: Array<{ kind: string; originalName: string; url: string }>;
  setUploadedFiles: (v: Array<{ kind: string; originalName: string; url: string }>) => void;
  // FR-1.7/FR-1.9: PDF/Word/Excel document upload -- selected files awaiting upload,
  // plus per-file upload/parse/generation status shown in the docs tab's ingestion queue.
  documents: File[];
  setDocuments: (v: File[]) => void;
  documentResults: Array<DocumentUploadResult & { generation?: "queued" | "generating" | "generated" | "failed" }>;
  setDocumentResults: React.Dispatch<React.SetStateAction<Array<DocumentUploadResult & { generation?: "queued" | "generating" | "generated" | "failed" }>>>;
  openApiText: string;
  setOpenApiText: (v: string) => void;
  postmanText: string;
  setPostmanText: (v: string) => void;
  businessRules: string;
  setBusinessRules: (v: string) => void;
  externalProvider: "jira" | "azure";
  setExternalProvider: (v: "jira" | "azure") => void;
  externalBaseUrl: string;
  setExternalBaseUrl: (v: string) => void;
  externalToken: string;
  setExternalToken: (v: string) => void;
  externalIssueIds: string;
  setExternalIssueIds: (v: string) => void;

  // review drafts
  reviewDrafts: Record<string, Partial<TestCaseRow>>;
  setReviewDrafts: React.Dispatch<React.SetStateAction<Record<string, Partial<TestCaseRow>>>>;
  reviewNotes: Record<string, string>;
  setReviewNotes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  reviewDetails: Record<string, any>;
  setReviewDetails: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  frameworkChoice: Record<string, "playwright" | "selenium" | "cypress">;
  setFrameworkChoice: React.Dispatch<React.SetStateAction<Record<string, "playwright" | "selenium" | "cypress">>>;

  // healing
  healDrafts: Record<string, HealDraft>;
  setHealDrafts: React.Dispatch<React.SetStateAction<Record<string, HealDraft>>>;
  healState: Record<string, { detection?: any; healResult?: any; actions?: any[] }>;
  setHealState: React.Dispatch<React.SetStateAction<Record<string, { detection?: any; healResult?: any; actions?: any[] }>>>;

  // integrations
  integrationDraft: any;
  setIntegrationDraft: React.Dispatch<React.SetStateAction<any>>;

  // users
  currentUser: string;
  switchUser: (id: string) => void;

  // busy / error
  busy: string | null;
  error: string | null;
  setError: (e: string | null) => void;
  withBusy: (key: string, fn: () => Promise<any>) => Promise<void>;

  // refresh
  refreshAll: () => Promise<void>;
  refreshReporting: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppStateProvider");
  return ctx;
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<View>("home");
  const [mode, setModeState] = useState<Mode>(() => {
    const stored = localStorage.getItem("qa-app-mode");
    return stored === "enterprise" ? "enterprise" : "single";
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    localStorage.setItem("qa-app-mode", m);
  };

  const [inputs, setInputs] = useState<InputRow[]>([]);
  const [testCases, setTestCases] = useState<TestCaseRow[]>([]);
  const [scripts, setScripts] = useState<AutomationScriptRow[]>([]);
  const [runs, setRuns] = useState<ExecutionRunRow[]>([]);
  const [profiles, setProfiles] = useState<ExecutionProfileRow[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([]);
  const [queueEntries, setQueueEntries] = useState<ExecutionRunRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState({ ...PROFILE_DEFAULT });

  const [draftInput, setDraftInput] = useState(
    "The application has a login page with a Username field, a Password field, and a Log in button. Valid credentials should reach a Welcome dashboard; invalid credentials should show an inline error."
  );
  const [batchUrl, setBatchUrl] = useState("");
  const [crawlUsername, setCrawlUsername] = useState("");
  const [crawlPassword, setCrawlPassword] = useState("");
  const [crawlSessionToken, setCrawlSessionToken] = useState("");
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [videos, setVideos] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ kind: string; originalName: string; url: string }>>([]);
  const [documents, setDocuments] = useState<File[]>([]);
  const [documentResults, setDocumentResults] = useState<Array<DocumentUploadResult & { generation?: "queued" | "generating" | "generated" | "failed" }>>([]);
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
  const [healDrafts, setHealDrafts] = useState<Record<string, HealDraft>>({});
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
  const [suggestedProfile, setSuggestedProfile] = useState<any | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  // FR-4.24: persisted speed-mode preference -- when "ultrafast", the client's quick-trigger
  // flow (Execution.tsx) skips the Execution Settings Panel entirely on subsequent runs.
  const [speedMode, setSpeedModeState] = useState<"ultrafast" | "fast">(() => {
    const stored = localStorage.getItem("qa-app-speed-mode");
    return stored === "ultrafast" ? "ultrafast" : "fast";
  });
  function setSpeedMode(m: "ultrafast" | "fast") {
    setSpeedModeState(m);
    localStorage.setItem("qa-app-speed-mode", m);
  }
  const [lastUltrafastResult, setLastUltrafastResult] = useState<any | null>(null);

  async function refreshAll() {
    const [i, t, s, r, p, q, env] = await Promise.all([
      api.listInputs(),
      api.listTestCases(),
      api.listScripts(),
      api.listRuns(),
      api.listExecutionProfiles(),
      api.listExecutionQueue(),
      api.listEnvironments().catch(() => []),
    ]);
    setInputs(i);
    setTestCases(t);
    setScripts(s);
    setRuns(r);
    setProfiles(p);
    setEnvironments(env);
    setQueueEntries(q);
    // FR-4.14: compute a suggestion and surface it for the user to accept/override --
    // no longer silently calling setSelectedProfileId. See Execution.tsx for the banner.
    if (!selectedProfileId && !suggestionDismissed && p.length > 0) {
      const suggestion = await api.suggestExecutionProfile({ trigger_source: "ui" });
      if (suggestion?.profile) setSuggestedProfile({ ...suggestion.profile, _reason: suggestion.reason });
    }
    await refreshReporting();
  }

  function acceptSuggestedProfile() {
    if (suggestedProfile) setSelectedProfileId(suggestedProfile.id);
    setSuggestedProfile(null);
  }

  function dismissSuggestedProfile() {
    setSuggestedProfile(null);
    setSuggestionDismissed(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function resetProfileDraft() {
    setProfileDraft({ ...PROFILE_DEFAULT });
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
    resetProfileDraft();
    await refreshAll();
  }

  async function deleteProfile(id: string) {
    await api.deleteExecutionProfile(id);
    if (selectedProfileId === id) setSelectedProfileId("");
    await refreshAll();
  }

  // FR-4.25/FR-4.27: Ultrafast Mode's "quick trigger" -- zero intermediate screens between
  // trigger and "run started" status. Result (incl. the FR-6.11 report link) is kept in state
  // so Execution.tsx can surface it directly instead of requiring a separate export click.
  async function runUltrafast(ref: { scriptId?: string; testCaseId?: string }) {
    await withBusy("ultrafast-trigger", async () => {
      const result = await api.triggerUltrafast(ref);
      setLastUltrafastResult(result);
    });
  }

  function clearUltrafastResult() {
    setLastUltrafastResult(null);
  }

  // FR-4.26: test cases Ultrafast routed below-threshold, non-blocking, still awaiting review
  const needsReviewLaterCases = testCases.filter((tc: any) => Number(tc.needs_review_later) === 1);

  const value: AppCtx = {
    view,
    setView,
    mode,
    setMode,
    inputs,
    testCases,
    scripts,
    runs,
    profiles,
    environments,
    queueEntries,
    dashboard,
    flakyTests,
    coverage,
    hoursSaved,
    suggestedProfile,
    acceptSuggestedProfile,
    dismissSuggestedProfile,
    integrations,
    users,
    auditLog,
    flaggedForReReview,
    agreementRate,
    gitHistory,
    setGitHistory,
    speedMode,
    setSpeedMode,
    needsReviewLaterCases,
    lastUltrafastResult,
    runUltrafast,
    clearUltrafastResult,
    selectedProfileId,
    setSelectedProfileId,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    editingProfileId,
    setEditingProfileId,
    profileDraft,
    setProfileDraft,
    saveProfile,
    deleteProfile,
    resetProfileDraft,
    draftInput,
    setDraftInput,
    batchUrl,
    setBatchUrl,
    crawlUsername,
    setCrawlUsername,
    crawlPassword,
    setCrawlPassword,
    crawlSessionToken,
    setCrawlSessionToken,
    screenshots,
    setScreenshots,
    videos,
    setVideos,
    uploadedFiles,
    setUploadedFiles,
    documents,
    setDocuments,
    documentResults,
    setDocumentResults,
    openApiText,
    setOpenApiText,
    postmanText,
    setPostmanText,
    businessRules,
    setBusinessRules,
    externalProvider,
    setExternalProvider,
    externalBaseUrl,
    setExternalBaseUrl,
    externalToken,
    setExternalToken,
    externalIssueIds,
    setExternalIssueIds,
    reviewDrafts,
    setReviewDrafts,
    reviewNotes,
    setReviewNotes,
    reviewDetails,
    setReviewDetails,
    frameworkChoice,
    setFrameworkChoice,
    healDrafts,
    setHealDrafts,
    healState,
    setHealState,
    integrationDraft,
    setIntegrationDraft,
    currentUser,
    switchUser,
    busy,
    error,
    setError,
    withBusy,
    refreshAll,
    refreshReporting,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
