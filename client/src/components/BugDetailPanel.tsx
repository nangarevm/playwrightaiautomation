import { useState } from "react";

export interface BugDetail {
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
  evidence?: Record<string, any>;
}

interface BugDetailPanelProps {
  bug: BugDetail | null;
  onClose: () => void;
  onRerun?: () => void;
}

export function BugDetailPanel({ bug, onClose, onRerun }: BugDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "errors" | "trace" | "fix">("overview");

  if (!bug) return null;

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 text-red-700 border-red-300";
      case "high":
        return "bg-orange-100 text-orange-700 border-orange-300";
      case "medium":
        return "bg-yellow-100 text-yellow-700 border-yellow-300";
      case "low":
        return "bg-blue-100 text-blue-700 border-blue-300";
      default:
        return "bg-gray-100 text-gray-700 border-gray-300";
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className={`p-6 border-b border-line ${getSeverityColor(bug.severity)}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className={`w-4 h-4 rounded-full mt-1 flex-shrink-0 ${getSeverityDot(bug.severity)}`} />
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-bold break-words">{bug.title}</h2>
                <p className="text-sm opacity-75 mt-1">{bug.category}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-2xl text-gray-400 hover:text-gray-600 flex-shrink-0">
              ✕
            </button>
          </div>
          <div className="mt-4 flex items-center gap-4 flex-wrap">
            <span className="text-sm font-bold uppercase">{bug.severity}</span>
            {bug.testName && <span className="text-xs bg-white/50 px-2 py-1 rounded">Test: {bug.testName}</span>}
            {bug.screenName && <span className="text-xs bg-white/50 px-2 py-1 rounded">Screen: {bug.screenName}</span>}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line bg-gray-50 overflow-x-auto">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-4 py-3 text-sm font-semibold border-b-2 transition whitespace-nowrap ${
              activeTab === "overview"
                ? "border-ink text-ink"
                : "border-transparent text-ink/50 hover:text-ink"
            }`}
          >
            Overview
          </button>
          {bug.evidence?.topErrors && (
            <button
              onClick={() => setActiveTab("errors")}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition whitespace-nowrap ${
                activeTab === "errors"
                  ? "border-ink text-ink"
                  : "border-transparent text-ink/50 hover:text-ink"
              }`}
            >
              Console Errors ({bug.evidence?.total || 0})
            </button>
          )}
          {bug.errorMessage && (
            <button
              onClick={() => setActiveTab("trace")}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition whitespace-nowrap ${
                activeTab === "trace"
                  ? "border-ink text-ink"
                  : "border-transparent text-ink/50 hover:text-ink"
              }`}
            >
              Error Details
            </button>
          )}
          {bug.suggestedFix && (
            <button
              onClick={() => setActiveTab("fix")}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition whitespace-nowrap ${
                activeTab === "fix"
                  ? "border-ink text-ink"
                  : "border-transparent text-ink/50 hover:text-ink"
              }`}
            >
              Suggested Fix
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === "overview" && (
            <div className="space-y-6">
              {bug.description && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-2">Description</h3>
                  <p className="text-sm text-ink/80 leading-relaxed whitespace-pre-wrap">{bug.description}</p>
                </div>
              )}

              {bug.affectedFeature && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-2">Affected Feature</h3>
                  <p className="text-sm bg-blue-50 border border-blue-200 rounded p-3">{bug.affectedFeature}</p>
                </div>
              )}

              {bug.stepsToReproduce && bug.stepsToReproduce.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-3">Steps to Reproduce</h3>
                  <ol className="space-y-2">
                    {bug.stepsToReproduce.map((step, idx) => (
                      <li key={idx} className="flex gap-3 text-sm">
                        <span className="font-bold text-ink/40 flex-shrink-0">{idx + 1}.</span>
                        <span className="text-ink/80">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {bug.screenshot && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-2">Screenshot</h3>
                  <div className="bg-gray-100 rounded-lg overflow-hidden border border-line">
                    <img src={bug.screenshot} alt="Bug screenshot" className="max-w-full h-auto" />
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "errors" && bug.evidence?.topErrors && (
            <div className="space-y-6">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="text-2xl font-bold text-red-700">{bug.evidence.total}</div>
                  <div className="text-xs text-red-600 mt-1">Total Errors</div>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                  <div className="text-2xl font-bold text-orange-700">{bug.evidence.bySeverity?.critical || 0}</div>
                  <div className="text-xs text-orange-600 mt-1">Critical</div>
                </div>
              </div>

              {/* Category Breakdown */}
              {bug.evidence.byCategory && Object.keys(bug.evidence.byCategory).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-3">By Category</h3>
                  <div className="space-y-2">
                    {Object.entries(bug.evidence.byCategory).map(([category, count]) => (
                      <div key={category} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <span className="text-sm capitalize font-medium">{category}</span>
                        <span className="text-sm font-bold text-ink/60">{count as number}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Top Errors */}
              <div>
                <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-3">Top Errors</h3>
                <div className="space-y-3">
                  {bug.evidence.topErrors?.map((error: any, idx: number) => (
                    <div key={idx} className="bg-gray-50 rounded-lg p-4 border-l-4 border-red-500">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <span className={`text-xs font-bold px-2 py-1 rounded ${
                            error.severity === 'critical' ? 'bg-red-200 text-red-800' :
                            error.severity === 'high' ? 'bg-orange-200 text-orange-800' :
                            'bg-yellow-200 text-yellow-800'
                          }`}>{error.severity.toUpperCase()}</span>
                          <span className="ml-2 text-xs font-mono text-ink/60">{error.type}</span>
                        </div>
                        <span className="text-xs text-ink/50 capitalize">{error.category}</span>
                      </div>
                      <p className="text-sm text-ink/80 mb-3 font-mono break-words">{error.message}</p>
                      {error.fix && (
                        <div className="text-xs bg-green-50 border border-green-200 rounded p-2 text-green-800">
                          💡 {error.fix}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Related Errors */}
              {bug.evidence.relatedErrorGroups && bug.evidence.relatedErrorGroups.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-3">Related Error Groups</h3>
                  <div className="space-y-2">
                    {bug.evidence.relatedErrorGroups?.map((group: any, idx: number) => (
                      <div key={idx} className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                        <p className="text-sm font-medium text-blue-900">
                          {group.count} similar errors • {group.type} • {group.origin || 'Unknown'}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "trace" && bug.errorMessage && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-2">Error Message</h3>
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 font-mono text-xs text-red-700 overflow-x-auto">
                  {bug.errorMessage}
                </div>
              </div>

              {bug.stackTrace && (
                <div>
                  <h3 className="text-sm font-semibold text-ink/60 uppercase tracking-wide mb-2">Stack Trace</h3>
                  <div className="bg-gray-900 rounded-lg p-4 font-mono text-xs text-gray-100 overflow-x-auto whitespace-pre-wrap">
                    {bug.stackTrace}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "fix" && bug.suggestedFix && (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h3 className="font-semibold text-green-900 mb-2">💡 Suggested Fix</h3>
                <p className="text-sm text-green-800 leading-relaxed whitespace-pre-wrap">{bug.suggestedFix}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-line bg-gray-50 p-4 flex justify-between items-center gap-3">
          <span className="text-xs text-ink/50">Bug ID: {bug.id}</span>
          <div className="flex gap-2">
            {onRerun && (
              <button
                onClick={onRerun}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition"
              >
                🔄 Rerun Test
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 border border-line text-ink/60 hover:text-ink rounded-lg text-sm font-medium transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
