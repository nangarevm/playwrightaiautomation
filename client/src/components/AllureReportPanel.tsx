import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Pill } from "./Pill.js";

interface AllureStatus {
  exists: boolean;
  fileCount: number;
  generatedAt: string | null;
}

// Shared Allure report panel: generate/view/download/email-to-a-user. Used from
// both Execution (every run lands there) and the AI Crawler / Ultrafast crawl tab
// (so "generate + run" can be followed by a report without switching tabs).
// `sinceMs`: when set, generation is scoped to result files recorded at/after
// this epoch-ms timestamp -- e.g. the Crawler tab passes the moment its
// "Generate + Run" batch started, so "from this crawl's runs" is actually true
// instead of aggregating the platform's entire accumulated allure-results/
// history (which never gets cleared between runs).
// `autoGenerateKey`: bump this (e.g. Date.now()) to trigger generation
// automatically without the user clicking the button -- the Crawler tab uses
// this so the Allure report is built as the last step of "Generate + Run"
// instead of requiring a separate manual click afterward.
export function AllureReportPanel({ title = "Allure report", sinceMs, autoGenerateKey }: { title?: string; sinceMs?: number; autoGenerateKey?: number }) {
  const [status, setStatus] = useState<AllureStatus | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [emailResult, setEmailResult] = useState<string | null>(null);
  const [showEmailForm, setShowEmailForm] = useState(false);

  useEffect(() => {
    api.allureStatus().then(setStatus).catch(() => undefined);
    api.allureEmailStatus().then((s) => setEmailConfigured(s.configured)).catch(() => setEmailConfigured(false));
  }, []);

  const [generateSeconds, setGenerateSeconds] = useState(0);

  // Auto-trigger on mount and whenever the parent bumps autoGenerateKey (e.g.
  // right after a "Generate + Run" batch finishes) -- skips the very first
  // render's "undefined -> undefined" no-op via the ref guard below.
  const lastAutoKey = useState<{ current: number | undefined }>(() => ({ current: undefined }))[0];
  useEffect(() => {
    if (autoGenerateKey === undefined) return;
    if (lastAutoKey.current === autoGenerateKey) return;
    lastAutoKey.current = autoGenerateKey;
    buildReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateKey]);

  // The Allure commandline tool is a Java CLI -- npx resolution + JVM start +
  // report build genuinely takes ~10-15s (confirmed by timing it directly), not
  // a hang. Without this, the button just says "Generating..." with no sense of
  // progress for that whole stretch, which reads as stuck/broken. A ticking
  // elapsed-time counter is enough to reassure it's still working.
  async function buildReport() {
    setBusy("generate");
    setError(null);
    setGenerateSeconds(0);
    const tick = setInterval(() => setGenerateSeconds((s) => s + 1), 1000);
    try {
      // api.allureGenerate() resolves POST /allure/generate, which returns an
      // AllureGenerateResult ({ok, fileCount, indexExists, message}) -- a
      // different shape than AllureStatus ({exists, fileCount, generatedAt})
      // that `status` holds. Setting it directly left `status.exists`
      // undefined after every successful generate, so the panel fell back to
      // "not generated" and hid View/Download/Email right after a real
      // success -- indistinguishable from the click doing nothing. Re-fetch
      // the actual status instead of reusing the generate response.
      await api.allureGenerate(sinceMs);
      const fresh = await api.allureStatus();
      setStatus(fresh);
    } catch (e: any) {
      setError(e.message);
    } finally {
      clearInterval(tick);
      setBusy(null);
    }
  }

  async function sendEmail() {
    if (!email.trim()) return;
    setBusy("email");
    setEmailResult(null);
    setError(null);
    try {
      await api.allureSendEmail(email.trim());
      setEmailResult(`Report sent to ${email.trim()}.`);
      setEmail("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{title}</p>
        <Pill tone={status?.exists ? "good" : "neutral"}>{status?.exists ? `${status.fileCount} file(s)` : "not generated"}</Pill>
      </div>
      <p className="text-xs text-ink/60">
        {sinceMs
          ? "Scoped to runs completed during this crawl -- earlier/unrelated runs are excluded."
          : "Builds from every run recorded so far (allure-playwright records results automatically as scripts run)."}
      </p>
      {error && <p className="text-xs text-alert">{error}</p>}

      <div className="flex gap-2 flex-wrap items-center">
        <button className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40" disabled={busy === "generate"} onClick={buildReport}>
          {busy === "generate" ? `Generating… (${generateSeconds}s — this starts a Java-based report builder and usually takes ~10-15s)` : "Generate Allure report"}
        </button>
        {status?.exists && (
          <>
            <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs" onClick={() => setShowReport((v) => !v)}>
              {showReport ? "Hide report" : "View report"}
            </button>
            <a className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs" href={api.allureDownloadUrl}>
              Download zip
            </a>
            <button
              className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs"
              onClick={() => setShowEmailForm((v) => !v)}
              title={emailConfigured === false ? "Server SMTP is not configured (see server/.env.example)" : undefined}
            >
              Email report
            </button>
          </>
        )}
      </div>

      {showEmailForm && status?.exists && (
        <div className="flex items-center gap-2 pt-1">
          <input
            type="email"
            className="rounded-md border border-line px-2 py-1.5 text-xs w-64"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            className="rounded-md bg-signal text-white px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            disabled={busy === "email" || !email.trim() || emailConfigured === false}
            onClick={sendEmail}
          >
            {busy === "email" ? "Sending…" : "Send"}
          </button>
          {emailConfigured === false && <span className="text-[11px] text-alert">SMTP not configured on the server.</span>}
        </div>
      )}
      {emailResult && <p className="text-xs text-signal">{emailResult}</p>}

      {showReport && status?.exists && (
        <iframe title="Allure report" src="/allure-report/index.html" className="w-full h-[600px] rounded-md border border-line" />
      )}
    </div>
  );
}
