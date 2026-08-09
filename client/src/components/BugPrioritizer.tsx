import { useState } from "react";
import { BugDetailPanel } from "./BugDetailPanel.js";

export interface BugItem {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description?: string;
  screenName?: string;
  screenshot?: string;
  errorMessage?: string;
  stackTrace?: string;
  affectedFeature?: string;
  stepsToReproduce?: string[];
  suggestedFix?: string;
  testName?: string;
  testStep?: number;
  discoveredAt?: string;
}

interface BugPrioritizerProps {
  bugs: BugItem[];
  onBugSelect?: (bug: BugItem) => void;
}

export function BugPrioritizer({ bugs, onBugSelect }: BugPrioritizerProps) {
  const [selectedSeverity, setSelectedSeverity] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [expandedBugId, setExpandedBugId] = useState<string | null>(null);
  const [selectedBugForDetail, setSelectedBugForDetail] = useState<BugItem | null>(null);

  // Sort bugs by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedBugs = [...bugs].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Filter bugs
  const filteredBugs = sortedBugs.filter((bug) => {
    if (selectedSeverity && bug.severity !== selectedSeverity) return false;
    if (selectedCategory && bug.category !== selectedCategory) return false;
    return true;
  });

  // Get unique categories
  const categories = Array.from(new Set(bugs.map((b) => b.category)));

  // Count by severity
  const counts = {
    critical: bugs.filter((b) => b.severity === "critical").length,
    high: bugs.filter((b) => b.severity === "high").length,
    medium: bugs.filter((b) => b.severity === "medium").length,
    low: bugs.filter((b) => b.severity === "low").length,
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 border-red-300 text-red-700";
      case "high":
        return "bg-orange-100 border-orange-300 text-orange-700";
      case "medium":
        return "bg-yellow-100 border-yellow-300 text-yellow-700";
      case "low":
        return "bg-blue-100 border-blue-300 text-blue-700";
      default:
        return "bg-gray-100 border-gray-300 text-gray-700";
    }
  };

  const getSeverityDot = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-600";
      case "high":
        return "bg-orange-600";
      case "medium":
        return "bg-yellow-600";
      case "low":
        return "bg-blue-600";
      default:
        return "bg-gray-600";
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter Buttons */}
      <div className="space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold mb-2">Filter by Severity</p>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setSelectedSeverity(null)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                selectedSeverity === null
                  ? "bg-ink text-white"
                  : "bg-white/60 border border-line text-ink/60 hover:text-ink"
              }`}
            >
              All ({bugs.length})
            </button>
            {counts.critical > 0 && (
              <button
                onClick={() => setSelectedSeverity("critical")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedSeverity === "critical"
                    ? "bg-red-600 text-white"
                    : "bg-red-100 border border-red-300 text-red-700 hover:bg-red-200"
                }`}
              >
                Critical ({counts.critical})
              </button>
            )}
            {counts.high > 0 && (
              <button
                onClick={() => setSelectedSeverity("high")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedSeverity === "high"
                    ? "bg-orange-600 text-white"
                    : "bg-orange-100 border border-orange-300 text-orange-700 hover:bg-orange-200"
                }`}
              >
                High ({counts.high})
              </button>
            )}
            {counts.medium > 0 && (
              <button
                onClick={() => setSelectedSeverity("medium")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedSeverity === "medium"
                    ? "bg-yellow-600 text-white"
                    : "bg-yellow-100 border border-yellow-300 text-yellow-700 hover:bg-yellow-200"
                }`}
              >
                Medium ({counts.medium})
              </button>
            )}
            {counts.low > 0 && (
              <button
                onClick={() => setSelectedSeverity("low")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedSeverity === "low"
                    ? "bg-blue-600 text-white"
                    : "bg-blue-100 border border-blue-300 text-blue-700 hover:bg-blue-200"
                }`}
              >
                Low ({counts.low})
              </button>
            )}
          </div>
        </div>

        {categories.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold mb-2">Filter by Category</p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setSelectedCategory(null)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedCategory === null
                    ? "bg-ink text-white"
                    : "bg-white/60 border border-line text-ink/60 hover:text-ink"
                }`}
              >
                All Categories
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                    selectedCategory === cat
                      ? "bg-ink text-white"
                      : "bg-white/60 border border-line text-ink/60 hover:text-ink"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bug List */}
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">
          {filteredBugs.length} bug{filteredBugs.length !== 1 ? "s" : ""} found
        </p>

        {filteredBugs.length === 0 ? (
          <div className="rounded-lg border border-line bg-white/60 p-4 text-center">
            <p className="text-sm text-ink/60">No bugs match your filters</p>
          </div>
        ) : (
          filteredBugs.map((bug) => (
            <div
              key={bug.id}
              className={`rounded-lg border-2 p-3 cursor-pointer transition hover:shadow-md ${getSeverityColor(bug.severity)}`}
              onClick={() => {
                setSelectedBugForDetail(bug);
                setExpandedBugId(expandedBugId === bug.id ? null : bug.id);
                onBugSelect?.(bug);
              }}
            >
              <div className="flex items-start gap-3">
                <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${getSeverityDot(bug.severity)}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm truncate">{bug.title}</h4>
                      <p className="text-xs opacity-75 mt-1">{bug.category}</p>
                      {bug.screenName && <p className="text-xs opacity-60 mt-0.5">Screen: {bug.screenName}</p>}
                    </div>
                    <span className="text-xs font-bold uppercase flex-shrink-0 whitespace-nowrap ml-2">
                      {bug.severity}
                    </span>
                  </div>

                  {expandedBugId === bug.id && bug.description && (
                    <div className="mt-3 pt-3 border-t border-current opacity-75">
                      <p className="text-xs">{bug.description}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bug Detail Panel */}
      <BugDetailPanel bug={selectedBugForDetail} onClose={() => setSelectedBugForDetail(null)} />
    </div>
  );
}
