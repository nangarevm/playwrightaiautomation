import { useEffect, useState } from "react";
import { api, BugFindingRow } from "../api.js";
import { Pill } from "../components/Pill.js";

const SEVERITY_TONE: Record<BugFindingRow["severity"], "neutral" | "good" | "bad" | "warn"> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "neutral",
};

const SOURCE_LABEL: Record<BugFindingRow["source"], string> = {
  ui_exploratory: "UI exploratory scan",
  api_fuzz: "API fuzz",
  regression: "Regression",
};

// Bug Detection Engine UI: surfaces findings from the exploratory UI scan
// (runs automatically after every execution run whose test case is tagged to
// a screen with a known URL) and the on-demand API fuzz pass. Distinct from
// FR-7.6's reactive "previously-passing test now fails" bug filing -- these
// are proactively discovered defects, not just regressions.
export default function Bugs() {
  const [findings, setFindings] = useState<BugFindingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [endpointsText, setEndpointsText] = useState("");
  const [fuzzing, setFuzzing] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await api.listBugFindings({
        status: statusFilter || undefined,
        severity: severityFilter || undefined,
      });
      setFindings(rows);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, severityFilter]);

  async function setStatus(id: string, status: BugFindingRow["status"]) {
    try {
      const updated = await api.updateBugFindingStatus(id, status);
      setFindings((prev) => prev.map((f) => (f.id === id ? updated : f)));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function fileFinding(id: string) {
    try {
      const updated = await api.fileBugFinding(id);
      setFindings((prev) => prev.map((f) => (f.id === id ? updated : f)));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function runApiFuzz() {
    const endpoints = endpointsText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!apiBaseUrl || endpoints.length === 0) return;
    setFuzzing(true);
    try {
      await api.fuzzApiForBugs(apiBaseUrl, endpoints);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setFuzzing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Bug Findings</h2>
        <p className="text-sm text-ink/60">
          Proactively discovered defects — an exploratory UI scan runs automatically after every
          execution run (broken images, JS/console errors, server errors, stuck loading states),
          and an API fuzz pass checks endpoints never crash with a 5xx on boundary/malformed input.
        </p>
      </div>

      {error && <div className="rounded-md border border-alert bg-alert/5 p-3 text-sm text-alert">{error}</div>}

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <p className="text-sm font-medium">Run an API fuzz pass</p>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            className="rounded-md border border-line px-2 py-1.5 text-sm"
            placeholder="API base URL, e.g. http://localhost:4100"
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
          />
          <textarea
            className="rounded-md border border-line px-2 py-1.5 text-sm font-mono"
            placeholder={"One endpoint per line, e.g.\n/api/orders/:id\n/api/users/:id"}
            rows={3}
            value={endpointsText}
            onChange={(e) => setEndpointsText(e.target.value)}
          />
        </div>
        <button
          className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          disabled={fuzzing || !apiBaseUrl || !endpointsText.trim()}
          onClick={runApiFuzz}
        >
          {fuzzing ? "Fuzzing…" : "Run fuzz pass"}
        </button>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <select className="rounded-md border border-line px-2 py-1 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
        </select>
        <select className="rounded-md border border-line px-2 py-1 text-xs" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <span className="text-ink/50">{findings.length} finding(s)</span>
      </div>

      {loading ? (
        <p className="text-sm text-ink/50">Loading findings…</p>
      ) : findings.length === 0 ? (
        <p className="text-sm text-ink/50">
          No bug findings yet — run a script tagged to a screen, or run an API fuzz pass above.
        </p>
      ) : (
        <div className="space-y-2">
          {findings.map((f) => (
            <div key={f.id} className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-sm">{f.title}</p>
                  <p className="text-xs text-ink/50">{SOURCE_LABEL[f.source]} · {new Date(f.created_at).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Pill tone={SEVERITY_TONE[f.severity]}>{f.severity}</Pill>
                  <Pill tone={f.status === "open" ? "bad" : f.status === "resolved" ? "good" : "neutral"}>{f.status}</Pill>
                </div>
              </div>
              <p className="text-xs text-ink/70 whitespace-pre-wrap font-mono bg-ink/5 rounded p-2">{f.detail}</p>

              {(() => {
                let steps: string[] = [];
                try {
                  steps = f.steps_to_reproduce ? JSON.parse(f.steps_to_reproduce) : [];
                } catch {
                  steps = [];
                }
                return steps.length > 0 ? (
                  <div className="text-xs">
                    <p className="font-medium text-ink/70 mb-1">Steps to reproduce</p>
                    <ol className="list-decimal list-inside space-y-0.5 text-ink/60">
                      {steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                ) : null;
              })()}

              {(f.screenshot_url || f.video_url) && (
                <div className="flex flex-wrap gap-3 pt-1">
                  {f.screenshot_url && (
                    <a href={f.screenshot_url} target="_blank" rel="noreferrer" className="block">
                      <img
                        src={f.screenshot_url}
                        alt={`Screenshot evidence for ${f.title}`}
                        className="h-24 w-auto rounded border border-line object-cover object-top"
                      />
                    </a>
                  )}
                  {f.video_url && (
                    <a href={f.video_url} target="_blank" rel="noreferrer" className="text-xs underline text-signal self-center">
                      View screen recording
                    </a>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1 text-xs">
                {f.filed_provider ? (
                  <span className="text-ink/50">Filed to {f.filed_provider}: {f.filed_external_id}</span>
                ) : (
                  <button className="underline text-signal" onClick={() => fileFinding(f.id)}>
                    File to Jira/Azure
                  </button>
                )}
                <div className="ml-auto flex gap-1.5">
                  {(["acknowledged", "resolved", "ignored"] as const)
                    .filter((s) => s !== f.status)
                    .map((s) => (
                      <button
                        key={s}
                        className="rounded border border-ink/20 px-2 py-0.5 text-ink/70 hover:bg-ink/5"
                        onClick={() => setStatus(f.id, s)}
                      >
                        Mark {s}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
