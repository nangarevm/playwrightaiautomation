import { useState } from "react";
import { TabBar } from "../components/TabBar.js";
import Screens from "./Screens.js";
import ManualTestCases from "./library/ManualTestCases.js";
import Testing from "./Testing.js";

type Tab = "screens" | "manual" | "scripts";

// Library groups the "go deeper than the guided Run flow" pages -- the discovered-
// screen catalog, manually authored test cases (FR-8.7), and automation scripts --
// under one nav entry. The AI Crawler used to live here as a fourth tab; it now
// lives permanently inside Run's Ultrafast mode instead (see run/UltrafastRunner.tsx)
// since crawling a site *is* an input source for the automatic pipeline, not a
// separate library asset. Each tab renders existing page logic unchanged.
export default function Library() {
  const [tab, setTab] = useState<Tab>("screens");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Library</h2>
        <p className="text-sm text-ink/60">Discovered screens, manually authored test cases, and automation scripts</p>
      </div>

      <TabBar<Tab>
        tabs={[
          { key: "screens", label: "Screens" },
          { key: "manual", label: "Manual Test Cases" },
          { key: "scripts", label: "Scripts" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ display: tab === "screens" ? "block" : "none" }}>
        <Screens />
      </div>
      <div style={{ display: tab === "manual" ? "block" : "none" }}>
        <ManualTestCases />
      </div>
      <div style={{ display: tab === "scripts" ? "block" : "none" }}>
        <Testing />
      </div>
    </div>
  );
}
