// Recrawl cockpit helpers — ETA + baseline age for the Crawler UI.

export function daysSinceIsoHint(iso?: string | null): { days: number; label: string } {
  if (!iso) return { days: 999, label: "no baseline yet" };
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { days: 999, label: "unknown" };
  const days = Math.floor(ms / 86400000);
  if (days === 0) return { days: 0, label: "today" };
  if (days === 1) return { days: 1, label: "1 day ago" };
  return { days, label: `${days} days ago` };
}

export function estimateRecrawlEta(input: {
  pageCount: number;
  mode: "incremental" | "full";
  lastSummary?: {
    skippedHttp?: number;
    scannedBrowser?: number;
    deepScans?: number;
    reusedBaselines?: number;
    unchangedPages?: number;
    changedPages?: number;
    elapsedMs?: number;
  } | null;
}): {
  estimatedSeconds: number;
  estimatedLabel: string;
  assumedSkipRate: number;
  notes: string;
} {
  const n = Math.max(1, input.pageCount);
  let skipRate = 0.55;
  if (input.lastSummary) {
    const total =
      (input.lastSummary.skippedHttp || 0) +
      (input.lastSummary.scannedBrowser || 0) ||
      (input.lastSummary.unchangedPages || 0) + (input.lastSummary.changedPages || 0) ||
      n;
    if (total > 0 && input.lastSummary.skippedHttp != null) {
      skipRate = Math.min(0.95, (input.lastSummary.skippedHttp || 0) / total);
    } else if (input.lastSummary.unchangedPages != null) {
      skipRate = Math.min(
        0.9,
        (input.lastSummary.unchangedPages || 0) /
          Math.max(1, (input.lastSummary.unchangedPages || 0) + (input.lastSummary.changedPages || 0))
      );
    }
  }
  if (input.mode === "full") skipRate = 0;

  // Heuristic: HTTP skip ~0.15s, shallow ~2.5s, deep ~8s
  const skipped = Math.round(n * skipRate);
  const remaining = n - skipped;
  const deep = Math.round(remaining * (input.mode === "full" ? 1 : 0.25));
  const shallow = remaining - deep;
  const estimatedSeconds = Math.round(skipped * 0.15 + shallow * 2.5 + deep * 8);

  let estimatedLabel = `${estimatedSeconds}s`;
  if (estimatedSeconds >= 60) {
    const m = Math.floor(estimatedSeconds / 60);
    const s = estimatedSeconds % 60;
    estimatedLabel = `${m}m ${s}s`;
  }

  return {
    estimatedSeconds,
    estimatedLabel,
    assumedSkipRate: Number(skipRate.toFixed(2)),
    notes:
      input.mode === "incremental"
        ? `Assumes ~${Math.round(skipRate * 100)}% HTTP/sitemap skips, deep-scan only when structure drifts.`
        : "Full mode deep-scans every page (no HTTP skip).",
  };
}
