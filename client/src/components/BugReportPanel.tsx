import { useState } from "react";
import { api } from "../api.js";
import { Pill } from "./Pill.js";

export interface CrawlBugEntry {
  testCaseId: string;
  title: string;
  errorMessage: string | null;
  reportUrl?: string | null;
  runId: string;
  failureClass: "automation_issue" | "environment_issue" | "possible_bug" | "unknown" | null;
  failureLabel: string | null;
}

const CLASS_META: Record<string, { badge: string; tone: "bad" | "warn" | "neutral"; blurb: string }> = {
  possible_bug: { badge: "Product bug", tone: "bad", blurb: "The page/API returned something different from what was expected -- worth investigating as a real defect." },
  automation_issue: { badge: "Automation script issue", tone: "warn", blurb: "The generated test's own locator/timing didn't match this page -- not necessarily a problem with your product." },
  environment_issue: { badge: "Environment issue", tone: "warn", blurb: "The target wasn't reachable (network/DNS/connection) -- check the URL and that the target is up, not a product defect." },
  unknown: { badge: "Uncategorized", tone: "neutral", blurb: "Couldn't confidently categorize this one -- read the error detail below." },
};

function downloadBugReportCsv(failures: CrawlBugEntry[]) {
  const header = ["Title", "Category", "Cause", "Error detail", "Failure report URL"];
  const escapeCsv = (v: string) => `"${v.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const rows = failures.map((f) => {
    const meta = CLASS_META[f.failureClass ?? "unknown"] ?? CLASS_META.unknown;
    return [f.title, meta.badge, f.failureLabel || meta.blurb, f.errorMessage || "", f.reportUrl || ""].map(escapeCsv).join(",");
  });
  const csv = [header.map(escapeCsv).join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bug-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Customer-facing bug list for a single crawl/batch. Failures are split into
// "genuine product bugs" (shown expanded, front and center) and "automation/
// environment issues" (collapsed by default) so a customer isn't left
// guessing whether a red pill means their product is broken or the AI-written
// script itself needs fixing.
export function BugReportPanel({ failures }: { failures: CrawlBugEntry[] }) {
  const [showScriptIssues, setShowScriptIssues] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  if (failures.length === 0) return null;

  const genuineBugs = failures.filter((f) => f.failureClass === "possible_bug" || f.failureClass === "unknown");
  const scriptIssues = failures.filter((f) => f.failureClass === "automation_issue" || f.failureClass === "environment_issue");

  async function downloadPdf() {
    setPdfBusy(true);
    setPdfError(null);
    try {
      const entries = failures.map((f) => ({
        title: f.title,
        failureClass: f.failureClass,
        failureLabel: f.failureLabel,
        errorMessage: f.errorMessage,
        reportUrl: f.reportUrl,
      }));
      await api.downloadBugReportPdf(entries, `bug-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.pdf`);
    } catch (e: any) {
      setPdfError(e.message);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Bug report (this crawl's failures)</p>
        <div className="flex items-center gap-1.5">
          {genuineBugs.length > 0 && <Pill tone="bad">{genuineBugs.length} product bug{genuineBugs.length === 1 ? "" : "s"}</Pill>}
          {scriptIssues.length > 0 && <Pill tone="warn">{scriptIssues.length} script/env issue{scriptIssues.length === 1 ? "" : "s"}</Pill>}
        </div>
      </div>
      <p className="text-xs text-ink/60">
        Failures are split by likely cause: a <strong>product bug</strong> means the page/API behaved unexpectedly and is
        worth a look; an <strong>automation script issue</strong> means the AI-generated test itself needs fixing (bad
        locator, target unreachable), not necessarily a defect in your product.
      </p>
      {pdfError && <p className="text-xs text-alert">{pdfError}</p>}
      <div className="flex gap-2 flex-wrap">
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs"
          onClick={() => downloadBugReportCsv(failures)}
        >
          Download bug report ({failures.length}) as CSV
        </button>
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs disabled:opacity-40"
          disabled={pdfBusy}
          onClick={downloadPdf}
        >
          {pdfBusy ? "Generating PDF…" : `Download bug report (${failures.length}) as PDF`}
        </button>
      </div>

      {genuineBugs.length > 0 ? (
        <div className="space-y-2">
          {genuineBugs.map((f) => (
            <FailureCard key={f.testCaseId} f={f} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink/50 italic">No genuine product bugs found in this crawl's failures.</p>
      )}

      {scriptIssues.length > 0 && (
        <div className="pt-1 border-t border-line/70">
          <button
            className="text-xs underline text-ink/60 pt-2"
            onClick={() => setShowScriptIssues((v) => !v)}
          >
            {showScriptIssues ? "Hide" : "Show"} {scriptIssues.length} automation/environment issue{scriptIssues.length === 1 ? "" : "s"} (not product bugs)
          </button>
          {showScriptIssues && (
            <div className="space-y-2 pt-2">
              {scriptIssues.map((f) => (
                <FailureCard key={f.testCaseId} f={f} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FailureCard({ f }: { f: CrawlBugEntry }) {
  const meta = CLASS_META[f.failureClass ?? "unknown"] ?? CLASS_META.unknown;
  return (
    <div className="rounded-md border border-alert/30 bg-alert/5 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Pill tone={meta.tone}>{meta.badge}</Pill>
          </div>
          <p className="text-sm font-medium text-ink mt-1">{f.title}</p>
        </div>
        {f.reportUrl && (
          <a className="text-xs underline text-signal shrink-0" href={f.reportUrl} target="_blank" rel="noreferrer">
            View failure report
          </a>
        )}
      </div>
      <p className="text-xs text-ink/50">{f.failureLabel || meta.blurb}</p>
      {f.errorMessage ? (
        <pre className="text-xs text-alert whitespace-pre-wrap font-mono bg-white/70 rounded p-2">{f.errorMessage}</pre>
      ) : (
        <p className="text-xs text-ink/50 italic">No detailed error message was captured for this failure.</p>
      )}
    </div>
  );
}
