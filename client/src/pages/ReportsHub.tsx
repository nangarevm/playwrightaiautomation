import { useState } from "react";
import { TabBar } from "../components/TabBar.js";
import Reports from "./Reports.js";
import Insights from "./Insights.js";
import Bugs from "./Bugs.js";

type Tab = "reports" | "insights" | "bugs";

// Groups release-ready exports (Reports) with deeper analytics (Insights) and
// proactively discovered defects (Bugs) under one nav entry -- all three are
// "look at results" screens, just different levels of detail.
export default function ReportsHub() {
  const [tab, setTab] = useState<Tab>("reports");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Reports</h2>
        <p className="text-sm text-ink/60">Release summaries, exports, analytics, and bug findings</p>
      </div>

      <TabBar<Tab>
        tabs={[
          { key: "reports", label: "Reports" },
          { key: "insights", label: "Insights" },
          { key: "bugs", label: "Bugs" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ display: tab === "reports" ? "block" : "none" }}>
        <Reports />
      </div>
      <div style={{ display: tab === "insights" ? "block" : "none" }}>
        <Insights />
      </div>
      <div style={{ display: tab === "bugs" ? "block" : "none" }}>
        <Bugs />
      </div>
    </div>
  );
}
