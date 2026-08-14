import { useState } from "react";
import { useApp } from "../context/AppState.js";
import { TabBar } from "../components/TabBar.js";
import { UltrafastRunner } from "./run/UltrafastRunner.js";
import Projects from "./Projects.js";
import AiStudio from "./AiStudio.js";
import Execution from "./Execution.js";
import Reports from "./Reports.js";

type Step = "input" | "generate" | "execute" | "report";

const FAST_STEPS: { key: Step; label: string; hint: string }[] = [
  { key: "input", label: "Input", hint: "Add a website, file, or description" },
  { key: "generate", label: "Review", hint: "Approve generated test cases" },
  { key: "execute", label: "Run", hint: "Execute tests" },
  { key: "report", label: "Report", hint: "View results" },
];

// The core end-to-end flow: Input -> Generate & Review -> Execute -> Report, all
// under one nav entry. Ultrafast Mode replaces the step tabs entirely with
// UltrafastRunner (FR-4.25: zero intermediate screens). Fast Mode keeps every
// existing page's full functionality, just presented as steps instead of separate
// sidebar tabs -- nothing about Projects/AiStudio/Execution below has been rewritten.
export default function Run() {
  const { speedMode, setSpeedMode } = useApp();
  const [step, setStep] = useState<Step>("input");

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
          <button
            className={`rounded-full px-3 py-1.5 font-medium ${speedMode === "ultrafast" ? "bg-ink text-paper" : "text-ink/60"}`}
            onClick={() => setSpeedMode("ultrafast")}
          >
            Ultrafast
          </button>
          <button
            className={`rounded-full px-3 py-1.5 font-medium ${speedMode === "fast" ? "bg-ink text-paper" : "text-ink/60"}`}
            onClick={() => setSpeedMode("fast")}
          >
            Fast
          </button>
        </div>
        <p className="text-xs text-ink/50">
          {speedMode === "ultrafast" ? "Automatic — crawl, test, report" : "Step-by-step with review at each stage"}
        </p>
      </div>

      {speedMode === "ultrafast" ? (
        <UltrafastRunner />
      ) : (
        <div className="space-y-3">
          <TabBar<Step>
            tabs={FAST_STEPS.map(({ key, label }) => ({ key, label }))}
            active={step}
            onChange={setStep}
          />
          <p className="text-xs text-ink/45 -mt-1">{FAST_STEPS.find((s) => s.key === step)?.hint}</p>

          <div style={{ display: step === "input" ? "block" : "none" }}>
            <Projects compact />
          </div>
          <div style={{ display: step === "generate" ? "block" : "none" }}>
            <AiStudio compact />
          </div>
          <div style={{ display: step === "execute" ? "block" : "none" }}>
            <Execution compact />
          </div>
          <div style={{ display: step === "report" ? "block" : "none" }}>
            <Reports compact />
          </div>
        </div>
      )}
    </div>
  );
}
