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
  onExport?: () => void;
  showStats?: boolean;
}

export function BugPrioritizer({ bugs, onBugSelect, onExport, showStats = true }: BugPrioritizerProps) {
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

  // Count by category
  const categoryCount = categories.reduce(
    (acc, cat) => ({
      ...acc,
      [cat]: bugs.filter((b) => b.category === cat).length,
    }),
    {} as Record<string, number>
  );

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

  const getSeverityLabel = (severity: string): "Critical" | "High" | "Medium" | "Low" => {
    const labels: Record<string, "Critical" | "High" | "Medium" | "Low"> = {
      critical: "Critical",
      high: "High",
      medium: "Medium",
      low: "Low",
    };
    return labels[severity] || "Medium";
  };

  // Export bugs as JSON
  const handleExport = () => {
    const data = {
      exportDate: new Date().toISOString(),
      totalBugs: bugs.length,
      filteredBugs: filteredBugs.length,
      severityCounts: counts,
      categoryCounts: categoryCount,
      bugs: filteredBugs,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bugs-${new Date().getTime()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    onExport?.();
  };

  return (
    <div className="space-y-4">
      {/* Quick Statistics */}
      {showStats && (
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-red-50 rounded-lg p-2 border border-red-200/70">
            <p className="text-xs text-red-700 font-semibold">Critical</p>
            <p className="text-xl font-bold text-red-600 mt-1">{counts.critical}</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-2 border border-orange-200/70">
            <p className="text-xs text-orange-700 font-semibold">High</p>
            <p className="text-xl font-bold text-orange-600 mt-1">{counts.high}</p>
          </div>
          <div className="bg-yellow-50 rounded-lg p-2 border border-yellow-200/70">
            <p className="text-xs text-yellow-700 font-semibold">Medium</p>
            <p className="text-xl font-bold text-yellow-600 mt-1">{counts.medium}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-2 border border-blue-200/70">
            <p className="text-xs text-blue-700 font-semibold">Low</p>
            <p className="text-xl font-bold text-blue-600 mt-1">{counts.low}</p>
          </div>
        </div>
      )}

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
                🚨 Critical ({counts.critical})
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
                ⚠️ High ({counts.high})
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
                📌 Medium ({counts.medium})
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
                ℹ️ Low ({counts.low})
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
                  {cat} <span className="ml-1 font-normal opacity-70">({categoryCount[cat]})</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Export Button */}
        <button
          onClick={handleExport}
          className="w-full px-3 py-2 rounded text-xs font-semibold bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition flex items-center justify-center gap-1.5"
        >
          📥 Export Bugs as JSON
        </button>
      </div>

      {/* Bug List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">
            🐛 {filteredBugs.length} bug{filteredBugs.length !== 1 ? "s" : ""} found
            {selectedSeverity && ` (${getSeverityLabel(selectedSeverity)} priority)`}
            {selectedCategory && ` in ${selectedCategory}`}
          </p>
        </div>

        {filteredBugs.length === 0 ? (
          <div className="rounded-lg border border-line bg-white/60 p-4 text-center">
            <p className="text-sm text-ink/60">✨ No bugs match your filters</p>
          </div>
        ) : (
          filteredBugs.map((bug, idx) => (
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
                {/* Severity Indicator */}
                <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${getSeverityDot(bug.severity)}`} />
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {/* Bug Title */}
                      <h4 className="font-semibold text-sm truncate">
                        #{idx + 1} {bug.title}
                      </h4>
                      
                      {/* Metadata Row */}
                      <div className="flex gap-2 flex-wrap mt-1">
                        {/* Category Badge */}
                        <span className="inline-block text-xs opacity-75 bg-white/40 px-2 py-0.5 rounded">
                          📂 {bug.category}
                        </span>
                        
                        {/* Screen Name Badge */}
                        {bug.screenName && (
                          <span className="inline-block text-xs opacity-75 bg-white/40 px-2 py-0.5 rounded">
                            🖼️ {bug.screenName}
                          </span>
                        )}
                        
                        {/* Affected Feature Badge */}
                        {bug.affectedFeature && (
                          <span className="inline-block text-xs opacity-75 bg-white/40 px-2 py-0.5 rounded">
                            🎯 {bug.affectedFeature}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    {/* Severity Badge */}
                    <span className="text-xs font-bold uppercase flex-shrink-0 whitespace-nowrap ml-2 px-2 py-1 bg-white/50 rounded">
                      {getSeverityLabel(bug.severity)}
                    </span>
                  </div>

                  {/* Expanded Description */}
                  {expandedBugId === bug.id && bug.description && (
                    <div className="mt-3 pt-3 border-t border-current opacity-85">
                      <p className="text-xs leading-relaxed">{bug.description}</p>
                      
                      {bug.errorMessage && (
                        <div className="mt-2 p-2 bg-white/40 rounded text-xs">
                          <p className="font-semibold">Error:</p>
                          <p className="font-mono text-xs opacity-75 mt-1">{bug.errorMessage}</p>
                        </div>
                      )}
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
