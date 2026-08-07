import { useEffect, useState } from "react";

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
}

export function ExecutionSummaryCard({ result, runId, testCaseTitle }: ExecutionSummaryCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const passRate = result.totalTests > 0 ? Math.round((result.testsPassed / result.totalTests) * 100) : 0;
  const manualQACost = (result.totalTests * 15); // Estimate: $15 per test for manual QA
  const costSaved = manualQACost - result.costAccumulated;
  const costSavedPercent = manualQACost > 0 ? Math.round((costSaved / manualQACost) * 100) : 0;

  // Determine status
  const status = result.testsFailed === 0 ? "all_passed" : "some_failed";
  const statusColor = status === "all_passed" ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200";
  const statusTextColor = status === "all_passed" ? "text-green-700" : "text-yellow-700";
  const statusBgColor = status === "all_passed" ? "bg-green-100" : "bg-yellow-100";

  // Get top recommendations
  const getRecommendations = () => {
    const recs = [];
    if (result.testsFailed > 0) {
      recs.push({
        priority: "critical",
        title: `Fix ${result.testsFailed} failing test(s)`,
        detail: "These tests indicate potential product bugs that need investigation",
      });
    }
    if (result.bugsFound > 0) {
      const criticality = result.bugsByCriticality?.critical || 0;
      if (criticality > 0) {
        recs.push({
          priority: "critical",
          title: `${criticality} critical bug(s) found`,
          detail: "These require immediate attention before release",
        });
      }
      if (result.bugsByCriticality?.high || 0 > 0) {
        recs.push({
          priority: "high",
          title: `${result.bugsByCriticality?.high} high-priority bug(s)`,
          detail: "Should be fixed before next release",
        });
      }
    }
    if (recs.length === 0) {
      recs.push({
        priority: "good",
        title: "All tests passed! 🎉",
        detail: "No critical issues detected. You're good to go!",
      });
    }
    return recs;
  };

  const recommendations = getRecommendations();

  return (
    <div className={`rounded-lg border-2 shadow-lg ${statusColor} p-6 space-y-6`}>
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-bold text-lg text-ink mb-2">✨ Execution Summary</h3>
          {testCaseTitle && <p className="text-sm text-ink/60">{testCaseTitle}</p>}
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-semibold ${statusBgColor} ${statusTextColor}`}>
          {status === "all_passed" ? "All Passed ✓" : "Some Failed"}
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-2 gap-4">
        {/* Passed Tests */}
        <div className="bg-white rounded-lg p-4 border border-green-200">
          <p className="text-xs uppercase tracking-wide text-green-700 font-semibold mb-1">Tests Passed</p>
          <p className="text-3xl font-bold text-green-600">{result.testsPassed}</p>
          <p className="text-xs text-ink/50 mt-2">{passRate}% pass rate</p>
        </div>

        {/* Failed Tests */}
        <div className="bg-white rounded-lg p-4 border border-red-200">
          <p className="text-xs uppercase tracking-wide text-red-700 font-semibold mb-1">Tests Failed</p>
          <p className={`text-3xl font-bold ${result.testsFailed > 0 ? "text-red-600" : "text-ink/30"}`}>
            {result.testsFailed}
          </p>
          <p className="text-xs text-ink/50 mt-2">of {result.totalTests} total</p>
        </div>

        {/* Bugs Found */}
        <div className="bg-white rounded-lg p-4 border border-yellow-200">
          <p className="text-xs uppercase tracking-wide text-yellow-700 font-semibold mb-1">Bugs Discovered</p>
          <p className={`text-3xl font-bold ${result.bugsFound > 0 ? "text-yellow-600" : "text-ink/30"}`}>
            {result.bugsFound}
          </p>
          <p className="text-xs text-ink/50 mt-2">issues found</p>
        </div>

        {/* Cost Saved */}
        <div className="bg-white rounded-lg p-4 border border-purple-200">
          <p className="text-xs uppercase tracking-wide text-purple-700 font-semibold mb-1">Cost Saved</p>
          <p className="text-3xl font-bold text-purple-600">${costSaved.toFixed(2)}</p>
          <p className="text-xs text-ink/50 mt-2">{costSavedPercent}% vs manual QA</p>
        </div>
      </div>

      {/* Bug Breakdown (if bugs found) */}
      {result.bugsFound > 0 && result.bugsByCriticality && (
        <div className="bg-white rounded-lg p-4 border border-line">
          <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold mb-3">Bug Severity Breakdown</p>
          <div className="space-y-2">
            {result.bugsByCriticality.critical > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-red-600" />
                  Critical
                </span>
                <span className="font-bold text-red-600">{result.bugsByCriticality.critical}</span>
              </div>
            )}
            {result.bugsByCriticality.high > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-orange-600" />
                  High
                </span>
                <span className="font-bold text-orange-600">{result.bugsByCriticality.high}</span>
              </div>
            )}
            {result.bugsByCriticality.medium > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-yellow-600" />
                  Medium
                </span>
                <span className="font-bold text-yellow-600">{result.bugsByCriticality.medium}</span>
              </div>
            )}
            {result.bugsByCriticality.low > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-blue-600" />
                  Low
                </span>
                <span className="font-bold text-blue-600">{result.bugsByCriticality.low}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cost Analysis */}
      <div className="bg-white rounded-lg p-4 border border-purple-200">
        <p className="text-xs uppercase tracking-wide text-purple-700 font-semibold mb-3">Cost Analysis</p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-ink/60">This run cost:</span>
            <span className="font-semibold">${result.costAccumulated.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink/60">Manual QA estimate:</span>
            <span className="font-semibold">${manualQACost.toFixed(2)}</span>
          </div>
          <div className="border-t border-line pt-2 flex justify-between">
            <span className="text-purple-700 font-semibold">Amount saved:</span>
            <span className="text-purple-700 font-bold text-lg">${costSaved.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Recommendations */}
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">📋 Next Steps</p>
        {recommendations.map((rec, idx) => (
          <div
            key={idx}
            className={`rounded-lg p-3 border-l-4 ${
              rec.priority === "critical"
                ? "bg-red-50 border-red-500"
                : rec.priority === "high"
                  ? "bg-orange-50 border-orange-500"
                  : "bg-green-50 border-green-500"
            }`}
          >
            <p className={`text-sm font-semibold ${rec.priority === "critical" ? "text-red-700" : rec.priority === "high" ? "text-orange-700" : "text-green-700"}`}>
              {rec.title}
            </p>
            <p className="text-xs text-ink/60 mt-1">{rec.detail}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition text-sm">
          View Full Report
        </button>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="px-4 py-2 border border-line text-ink/60 hover:text-ink rounded-lg transition text-sm"
        >
          {isExpanded ? "Show Less" : "Show More"}
        </button>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-line pt-4 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold mb-2">Execution Details</p>
            <div className="bg-white rounded p-3 text-xs space-y-1 font-mono">
              <div className="flex justify-between">
                <span>Run ID:</span>
                <span className="text-ink/50">{runId}</span>
              </div>
              <div className="flex justify-between">
                <span>Total Tests:</span>
                <span className="text-ink/50">{result.totalTests}</span>
              </div>
              <div className="flex justify-between">
                <span>Bugs Found:</span>
                <span className="text-ink/50">{result.bugsFound}</span>
              </div>
              <div className="flex justify-between">
                <span>Execution Cost:</span>
                <span className="text-ink/50">${result.costAccumulated.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
