import { useState } from "react";
import { useApp } from "../context/AppState.js";
import { TabBar } from "../components/TabBar.js";
import { UltrafastRunner } from "./run/UltrafastRunner.js";
import Projects from "./Projects.js";
import AiStudio from "./AiStudio.js";
import Execution from "./Execution.js";
import Reports from "./Reports.js";

type Step = "input" | "generate" | "execute" | "report";

// The core end-to-end flow: Input -> Generate & Review -> Execute -> Report, all
// under one nav entry. Ultrafast Mode replaces the step tabs entirely with
// UltrafastRunner (FR-4.25: zero intermediate screens). Fast Mode keeps every
// existing page's full functionality, just presented as steps instead of separate
// sidebar tabs -- nothing about Projects/AiStudio/Execution below has been rewritten.
export default function Run() {
  const { speedMode, setSpeedMode } = useApp();
  const [step, setStep] = useState<Step>("input");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl tracking-tight">Run</h2>
          <p className="text-sm text-ink/60">From a requirement to a finished test report</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
            <button
              className={`rounded-full px-3.5 py-1.5 font-medium ${speedMode === "ultrafast" ? "bg-ink text-paper" : "text-ink/60"}`}
              onClick={() => setSpeedMode("ultrafast")}
            >
              Ultrafast
            </button>
            <button
              className={`rounded-full px-3.5 py-1.5 font-medium ${speedMode === "fast" ? "bg-ink text-paper" : "text-ink/60"}`}
              onClick={() => setSpeedMode("fast")}
            >
              Fast
            </button>
          </div>
          <span className="text-xs text-ink/50 max-w-xs text-right">
            {speedMode === "ultrafast"
              ? "Fully automatic — no review or confirmation steps."
              : "You review and confirm each step before it runs."}
          </span>
        </div>
      </div>

      {speedMode === "ultrafast" ? (
        <UltrafastRunner />
      ) : (
        <div className="space-y-5">
          <TabBar<Step>
            tabs={[
              { key: "input", label: "1. Input" },
              { key: "generate", label: "2. Generate & review" },
              { key: "execute", label: "3. Execute" },
              { key: "report", label: "4. Report" },
            ]}
            active={step}
            onChange={setStep}
          />

          <div style={{ display: step === "input" ? "block" : "none" }}>
            <Projects />
          </div>
          <div style={{ display: step === "generate" ? "block" : "none" }}>
            <AiStudio />
          </div>
          <div style={{ display: step === "execute" ? "block" : "none" }}>
            <Execution />
          </div>
          <div style={{ display: step === "report" ? "block" : "none" }}>
            <Reports />
          </div>
        </div>
      )}
    </div>
  );
}
