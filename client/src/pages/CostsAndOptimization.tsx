import { useEffect, useState } from "react";
import { TabBar } from "../components/TabBar.js";
import {
  CostTransparencyDashboard,
  IncrementalCrawlIndicator,
  FastModeSelector,
  SmartPresetsPanel,
  type CostTransparencyData,
  type IncrementalCrawlData,
} from "../components/Feature9-12-index.js";
import { api } from "../api.js";
import { useApp } from "../context/AppState.js";

type Tab = "costs" | "incremental" | "fastmode" | "presets" | "phases";

/**
 * Feature 9-12 + optimization phases — live wiring to /api/optimization
 */
export default function CostsAndOptimization() {
  const { withBusy, setError, refreshAll } = useApp();
  const [tab, setTab] = useState<Tab>("costs");
  const [selectedFastMode, setSelectedFastMode] = useState<"critical" | "balanced" | "full">("balanced");
  const [selectedPreset, setSelectedPreset] = useState<string>("quick");
  const [costData, setCostData] = useState<CostTransparencyData | undefined>();
  const [incrementalData, setIncrementalData] = useState<IncrementalCrawlData | undefined>();
  const [phases, setPhases] = useState<any>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function refreshLive() {
    try {
      const [costs, incr, allPhases, fast] = await Promise.all([
        api.getFeatureCosts().catch(() => null),
        api.getFeatureIncremental().catch(() => null),
        api.getOptimizationAllPhases().catch(() => null),
        api.getFeatureFastMode().catch(() => null),
      ]);
      if (costs?.data) setCostData(costs.data);
      if (incr?.data) setIncrementalData(incr.data);
      if (allPhases?.phases) setPhases(allPhases);
      if (fast?.active) setSelectedFastMode(fast.active);
    } catch (e: any) {
      setError?.(e?.message || "Failed to load optimization data");
    }
  }

  useEffect(() => {
    refreshLive();
    const id = window.setInterval(refreshLive, 8000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-lg tracking-tight">Costs & Optimization</h2>
        <p className="text-xs text-ink/60">
          Live cost tracking, incremental crawl, fast mode, presets, and phases 1–4 (workers capped at 5)
        </p>
      </div>

      {statusMsg && (
        <div className="rounded-md border border-signal/30 bg-signal/5 px-3 py-2 text-xs text-ink">
          {statusMsg}
        </div>
      )}

      <TabBar<Tab>
        tabs={[
          { key: "costs", label: "Cost Transparency" },
          { key: "incremental", label: "Incremental Crawl" },
          { key: "fastmode", label: "Fast Mode" },
          { key: "presets", label: "Smart Presets" },
          { key: "phases", label: "Phases 1–4" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ display: tab === "costs" ? "block" : "none" }}>
        <CostTransparencyDashboard data={costData} isLive />
      </div>

      <div style={{ display: tab === "incremental" ? "block" : "none" }}>
        <IncrementalCrawlIndicator
          data={incrementalData}
          onToggle={async (enabled) => {
            try {
              const res = await api.toggleFeatureIncremental(enabled);
              setStatusMsg(res.message || `Incremental ${enabled ? "ON" : "OFF"}`);
              await refreshLive();
            } catch (e: any) {
              setError?.(e?.message || "Toggle failed");
            }
          }}
        />
      </div>

      <div style={{ display: tab === "fastmode" ? "block" : "none" }}>
        <FastModeSelector
          selected={selectedFastMode}
          onSelect={(mode) => setSelectedFastMode(mode as any)}
          onApply={async (mode) => {
            await withBusy("fast-mode", async () => {
              const res = await api.applyFeatureFastMode(mode as any);
              setSelectedFastMode(mode as any);
              setStatusMsg(res.message || `Applied ${mode}`);
              await refreshAll();
              await refreshLive();
            });
          }}
        />
      </div>

      <div style={{ display: tab === "presets" ? "block" : "none" }}>
        <SmartPresetsPanel
          selected={selectedPreset as any}
          onSelect={(preset) => setSelectedPreset(preset)}
          onStart={async (preset) => {
            await withBusy("preset-start", async () => {
              const res = await api.startFeaturePreset(preset);
              setSelectedPreset(preset);
              setStatusMsg(res.message || `Preset ${preset} ready`);
              const ids: string[] = res.scriptIds || [];
              if (ids.length > 0) {
                const result = await api.runExecutionBatch(ids, undefined, {
                  profile_id: res.profileId || undefined,
                  concurrency: 5,
                });
                setStatusMsg(
                  `Started ${ids.length} tests with preset "${preset}" · workers=${result?.concurrency ?? 5}`
                );
              }
              await refreshAll();
              await refreshLive();
            });
          }}
        />
      </div>

      <div style={{ display: tab === "phases" ? "block" : "none" }}>
        <div className="space-y-3 rounded-lg border border-line bg-white p-4">
          <p className="text-sm text-ink/70">
            {phases?.note || "Phase status reflects live feature flags and hot-path wiring."}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {phases?.phases &&
              Object.entries(phases.phases).map(([key, val]: any) => (
                <div key={key} className="rounded-md border border-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold capitalize">{key}</p>
                    <span
                      className={`text-[10px] font-semibold uppercase ${
                        val.enabled ? "text-green-700" : "text-ink/40"
                      }`}
                    >
                      {val.enabled ? "Live" : "Off"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink/70">{val.name}</p>
                  <p className="mt-1 text-xs text-ink/50">{val.impact}</p>
                  <button
                    className="mt-2 text-xs rounded border border-line px-2 py-1 hover:bg-gray-50"
                    onClick={async () => {
                      const n = Number(String(key).replace("phase", ""));
                      if (!n || n < 2) {
                        await api.toggleOptimization(!val.enabled);
                      } else {
                        await api.toggleOptimizationPhase(n, !val.enabled);
                      }
                      setStatusMsg(`Toggled ${key}`);
                      await refreshLive();
                    }}
                  >
                    {val.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
