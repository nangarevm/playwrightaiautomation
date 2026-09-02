import { useEffect, useState } from "react";
import { BugPrioritizer } from "./BugPrioritizer.js";

interface ExecutionResult {
  testsPassed: number;
  testsFailed: number;
  totalTests: number;
  bugsFound: number;
  costAccumulated: number;
  bugsByCriticality?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

interface ExecutionSummaryCardProps {
  result: ExecutionResult;
  runId: string;
  testCaseTitle?: string;
  bugs?: Array<{
    id: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    description?: string;
    screenName?: string;
  }>;
  onViewReport?: () => void;
  onRerunTests?: () => void;
}

export function ExecutionSummaryCard({ 
  result, 
  runId, 
  testCaseTitle, 
  bugs = [],
  onViewReport,
  onRerunTests
}: ExecutionSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showBugs, setShowBugs] = useState(false);

  const passRate = result.totalTests > 0 ? Math.round((result.testsPassed / result.totalTests) * 100) : 0;
  const manualQACost = result.totalTests * 15; // Estimate: $15 per test for manual QA
  const costSaved = manualQACost - result.costAccumulated;
  const costSavedPercent = manualQACost > 0 ? Math.round((costSaved / manualQACost) * 100) : 0;
  
  // Estimated time saved: ~5 minutes per manual test vs ~30 seconds automated
  const manualTimeMinutes = result.totalTests * 5;
  const automatedTimeMinutes = result.totalTests * 0.5;
  const timeSavedMinutes = manualTimeMinutes - automatedTimeMinutes;

  // Determine status
  const status = result.testsFailed === 0 ? "all_passed" : "some_failed";
  const statusColor = status === "all_passed" ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200";
  const statusTextColor = status === "all_passed" ? "text-green-700" : "text-yellow-700";
  const statusBgColor = status === "all_passed" ? "bg-green-100" : "bg-yellow-100";

  // Get top recommendations - prioritized and actionable
  const getRecommendations = () => {
    const recs: Array<{ priority: string; title: string; detail: string; action?: string }> = [];
    
    // Priority 1: Critical bugs
    if (result.bugsByCriticality?.critical && result.bugsByCriticality.critical > 0) {
      recs.push({
        priority: "critical",
        title: `🚨 ${result.bugsByCriticality.critical} Critical Bug(s) Found`,
        detail: "These must be fixed before any release. Click to view detailed analysis.",
        action: "view_bugs",
      });
    }
    
    // Priority 2: Failing tests
    if (result.testsFailed > 0) {
      recs.push({
        priority: "critical",
        title: `❌ ${result.testsFailed} Test(s) Failed`,
        detail: "Failures indicate potential product bugs. Investigate and fix immediately.",
        action: "investigate",
      });
    }
    
    // Priority 3: High priority bugs
    if (result.bugsByCriticality?.high && result.bugsByCriticality.high > 0) {
      recs.push({
        priority: "high",
        title: `⚠️ ${result.bugsByCriticality.high} High-Priority Bug(s)`,
        detail: "Should be scheduled for the next release cycle.",
        action: "schedule",
      });
    }
    
    // Priority 4: Medium bugs
    if (result.bugsByCriticality?.medium && result.bugsByCriticality.medium > 0) {
      recs.push({
        priority: "medium",
        title: `📌 ${result.bugsByCriticality.medium} Medium Priority Issue(s)`,
        detail: "Add to backlog for future sprints.",
        action: "backlog",
      });
    }
    
    // If all passed - celebrate!
    if (result.testsFailed === 0 && (result.bugsFound === 0 || !result.bugsByCriticality || (result.bugsByCriticality.critical === 0 && result.bugsByCriticality.high === 0))) {
      recs.push({
        priority: "good",
        title: "🎉 All Tests Passed!",
        detail: "No critical issues detected. Your application is ready for release!",
        action: "celebrate",
      });
    }
    
    return recs.slice(0, 3); // Show top 3 recommendations
  };

  const recommendations = getRecommendations();

  return (
    <div className={`rounded-lg border-2 shadow-lg ${statusColor} p-6 space-y-5`}>
      {/* Header with Status */}
      <div className="flex justify-between items-start border-b border-line/50 pb-4">
        <div>
          <h3 className="font-bold text-lg text-ink mb-1">✨ Execution Summary</h3>
          {testCaseTitle && <p className="text-xs text-ink/50">{testCaseTitle}</p>}
        </div>
        <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${statusBgColor} ${statusTextColor} whitespace-nowrap`}>
          {status === "all_passed" ? "✓ All Passed" : "Some Failed"}
        </div>
      </div>

      {/* Key Metrics - 4 Column Grid */}
      <div className="grid grid-cols-4 gap-3">
        {/* Tests Passed */}
        <div className="bg-white rounded-lg p-3 border border-green-200/70">
          <p className="text-xs text-green-700 font-semibold">Tests Passed</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{result.testsPassed}</p>
          <p className="text-xs text-ink/40 mt-1">{passRate}% pass rate</p>
        </div>

        {/* Tests Failed */}
        <div className="bg-white rounded-lg p-3 border border-red-200/70">
          <p className="text-xs text-red-700 font-semibold">Tests Failed</p>
          <p className={`text-2xl font-bold mt-1 ${result.testsFailed > 0 ? "text-red-600" : "text-ink/20"}`}>
            {result.testsFailed}
          </p>
          <p className="text-xs text-ink/40 mt-1">of {result.totalTests}</p>
        </div>

        {/* Bugs Found */}
        <div className="bg-white rounded-lg p-3 border border-yellow-200/70">
          <p className="text-xs text-yellow-700 font-semibold">Bugs Found</p>
          <p className={`text-2xl font-bold mt-1 ${result.bugsFound > 0 ? "text-yellow-600" : "text-ink/20"}`}>
            {result.bugsFound}
          </p>
          <p className="text-xs text-ink/40 mt-1">issues discovered</p>
        </div>

        {/* Cost Saved */}
        <div className="bg-white rounded-lg p-3 border border-purple-200/70">
          <p className="text-xs text-purple-700 font-semibold">Cost Saved</p>
          <p className="text-2xl font-bold text-purple-600 mt-1">${costSaved.toFixed(2)}</p>
          <p className="text-xs text-ink/40 mt-1">{costSavedPercent}% vs manual</p>
        </div>
      </div>

      {/* ROI & Time Saved - Horizontal Cards */}
      <div className="grid grid-cols-2 gap-3">
        {/* Time Saved Card */}
        <div className="bg-blue-50 rounded-lg p-3 border border-blue-200/70">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-900 font-semibold">⏱️ Time Saved</p>
              <p className="text-lg font-bold text-blue-600 mt-1">{timeSavedMinutes.toFixed(0)}m</p>
              <p className="text-xs text-blue-700/60 mt-0.5">vs manual testing</p>
            </div>
            <div className="text-3xl">⚡</div>
          </div>
        </div>

        {/* Execution Cost Card */}
        <div className="bg-purple-50 rounded-lg p-3 border border-purple-200/70">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-purple-900 font-semibold">💰 This Run Cost</p>
              <p className="text-lg font-bold text-purple-600 mt-1">${result.costAccumulated.toFixed(2)}</p>
              <p className="text-xs text-purple-700/60 mt-0.5">vs ${manualQACost.toFixed(0)} manual</p>
            </div>
            <div className="text-3xl">💵</div>
          </div>
        </div>
      </div>

      {/* Bug Severity Breakdown - if bugs found */}
      {result.bugsFound > 0 && result.bugsByCriticality && (
        <div className="bg-white rounded-lg p-4 border border-line/70">
          <p className="text-xs font-semibold text-ink/70 mb-3">🐛 Bug Severity Breakdown</p>
          <div className="space-y-2">
            {result.bugsByCriticality.critical > 0 && (
              <div className="flex items-center justify-between py-1.5 px-2 bg-red-50 rounded">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-600" />
                  <span className="font-medium text-red-900">Critical</span>
                </span>
                <span className="font-bold text-red-600">{result.bugsByCriticality.critical}</span>
              </div>
            )}
            {result.bugsByCriticality.high > 0 && (
              <div className="flex items-center justify-between py-1.5 px-2 bg-orange-50 rounded">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-orange-600" />
                  <span className="font-medium text-orange-900">High</span>
                </span>
                <span className="font-bold text-orange-600">{result.bugsByCriticality.high}</span>
              </div>
            )}
            {result.bugsByCriticality.medium > 0 && (
              <div className="flex items-center justify-between py-1.5 px-2 bg-yellow-50 rounded">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-600" />
                  <span className="font-medium text-yellow-900">Medium</span>
                </span>
                <span className="font-bold text-yellow-600">{result.bugsByCriticality.medium}</span>
              </div>
            )}
            {result.bugsByCriticality.low > 0 && (
              <div className="flex items-center justify-between py-1.5 px-2 bg-blue-50 rounded">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
                  <span className="font-medium text-blue-900">Low</span>
                </span>
                <span className="font-bold text-blue-600">{result.bugsByCriticality.low}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top Recommendations - Actionable */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-ink/70 flex items-center gap-1.5">
          📋 Next Steps ({recommendations.length})
        </p>
        {recommendations.map((rec, idx) => (
          <div
            key={idx}
            className={`rounded-lg p-3 border-l-4 ${
              rec.priority === "critical"
                ? "bg-red-50 border-red-500"
                : rec.priority === "high"
                  ? "bg-orange-50 border-orange-500"
                  : rec.priority === "medium"
                    ? "bg-yellow-50 border-yellow-500"
                    : "bg-green-50 border-green-500"
            }`}
          >
            <p className={`text-sm font-semibold ${
              rec.priority === "critical" ? "text-red-700" 
              : rec.priority === "high" ? "text-orange-700" 
              : rec.priority === "medium" ? "text-yellow-700"
              : "text-green-700"
            }`}>
              {rec.title}
            </p>
            <p className="text-xs text-ink/60 mt-0.5">{rec.detail}</p>
          </div>
        ))}
      </div>

      {/* Detailed Bug Analysis - Collapsible */}
      {bugs.length > 0 && (
        <div className="border-t border-line/50 pt-3">
          <button
            onClick={() => setShowBugs(!showBugs)}
            className="text-sm font-semibold text-ink hover:text-signal mb-2 flex items-center gap-1.5"
          >
            {showBugs ? "▼" : "▶"} Detailed Bug Analysis ({bugs.length})
          </button>
          {showBugs && <BugPrioritizer bugs={bugs} />}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={onViewReport}
          className="flex-1 bg-signal hover:bg-signal/90 text-white font-semibold py-2.5 px-4 rounded-lg transition text-sm"
        >
          View Full Report
        </button>
        <button
          onClick={onRerunTests}
          className="flex-1 px-4 py-2.5 border border-signal text-signal hover:bg-signal/5 rounded-lg transition text-sm font-medium"
        >
          Rerun Tests
        </button>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-line/50 pt-3 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold mb-2">Execution Details</p>
            <div className="bg-white rounded p-3 text-xs space-y-1 font-mono border border-line/50">
              <div className="flex justify-between">
                <span className="text-ink/60">Run ID:</span>
                <span className="text-ink font-medium">{runId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink/60">Total Tests:</span>
                <span className="text-ink font-medium">{result.totalTests}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink/60">Pass Rate:</span>
                <span className="text-ink font-medium">{passRate}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink/60">Bugs Found:</span>
                <span className="text-ink font-medium">{result.bugsFound}</span>
              </div>
              <div className="flex justify-between border-t border-line/50 pt-1">
                <span className="text-ink/60">This run cost:</span>
                <span className="text-ink font-medium">${result.costAccumulated.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink/60">Manual QA estimate:</span>
                <span className="text-ink font-medium">${manualQACost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-purple-700 font-semibold">
                <span>Amount saved:</span>
                <span>${costSaved.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Show More/Less Toggle */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-2 text-ink/60 hover:text-ink border border-line rounded-lg transition text-xs font-medium"
      >
        {isExpanded ? "▲ Show Less" : "▼ Show More Details"}
      </button>
    </div>
  );
}
