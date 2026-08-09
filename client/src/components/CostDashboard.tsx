import { useState, useEffect } from "react";

export interface CostData {
  estimatedCost: number;
  actualCost: number;
  costsAccumulated: number;
  costPerTest: number;
  breakdown: {
    llmCost: number;
    assertionCost: number;
    interactionCost: number;
    crawlCost: number;
    totalCost: number;
  };
  recommendations: string[];
  trends?: Array<{ date: string; cost: number; costPerTest: number }>;
}

interface CostDashboardProps {
  runId?: string;
  isLive?: boolean;
  costData?: CostData;
}

export function CostDashboard({ runId, isLive = false, costData }: CostDashboardProps) {
  const [data, setData] = useState<CostData | null>(costData || null);
  const [selectedTab, setSelectedTab] = useState<"overview" | "breakdown" | "trends" | "recommendations">("overview");

  const getSavingsPercent = () => {
    if (!data) return 0;
    if (data.estimatedCost === 0) return 0;
    return ((data.estimatedCost - data.actualCost) / data.estimatedCost) * 100;
  };

  const getManualQASavings = () => {
    if (!data) return 0;
    // Manual QA costs ~$10 per test on average
    const manualCost = 10;
    return data.costsAccumulated * manualCost;
  };

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;

  const getCostColor = (cost: number) => {
    if (cost < 0.1) return "text-green-600";
    if (cost < 0.15) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-6 p-6 bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-ink">💰 Cost Transparency</h2>
          <p className="text-sm text-ink/60 mt-1">Real-time cost tracking and analysis</p>
        </div>
        {isLive && <div className="flex items-center gap-2 text-green-600 text-sm font-semibold">● Live</div>}
      </div>

      {/* Key Metrics */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg p-4 border border-line">
            <div className="text-xs text-ink/60 font-semibold uppercase mb-1">Accumulated Cost</div>
            <div className={`text-2xl font-bold ${getCostColor(data.costPerTest)}`}>
              {formatCurrency(data.costsAccumulated)}
            </div>
            <div className="text-xs text-ink/40 mt-2">Current run total</div>
          </div>

          <div className="bg-white rounded-lg p-4 border border-line">
            <div className="text-xs text-ink/60 font-semibold uppercase mb-1">Cost Per Test</div>
            <div className={`text-2xl font-bold ${getCostColor(data.costPerTest)}`}>
              {formatCurrency(data.costPerTest)}
            </div>
            <div className="text-xs text-ink/40 mt-2">Efficiency metric</div>
          </div>

          <div className="bg-white rounded-lg p-4 border border-line">
            <div className="text-xs text-ink/60 font-semibold uppercase mb-1">Vs Estimate</div>
            <div className={`text-2xl font-bold ${getSavingsPercent() > 0 ? "text-green-600" : "text-orange-600"}`}>
              {getSavingsPercent() > 0 ? "-" : "+"}{Math.abs(getSavingsPercent()).toFixed(0)}%
            </div>
            <div className="text-xs text-ink/40 mt-2">
              {getSavingsPercent() > 0 ? "Below estimate" : "Above estimate"}
            </div>
          </div>

          <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-4 border border-green-200">
            <div className="text-xs text-green-900 font-semibold uppercase mb-1">Manual QA Savings</div>
            <div className="text-2xl font-bold text-green-700">
              {formatCurrency(getManualQASavings())}
            </div>
            <div className="text-xs text-green-600 mt-2">vs traditional QA</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-line bg-white rounded-t-lg">
        {(["overview", "breakdown", "trends", "recommendations"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSelectedTab(tab)}
            className={`px-4 py-3 text-sm font-semibold border-b-2 transition capitalize ${
              selectedTab === tab
                ? "border-ink text-ink"
                : "border-transparent text-ink/50 hover:text-ink"
            }`}
          >
            {tab === "overview" && "📊 Overview"}
            {tab === "breakdown" && "🧩 Breakdown"}
            {tab === "trends" && "📈 Trends"}
            {tab === "recommendations" && "💡 Recommendations"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-white rounded-lg p-6 space-y-4">
        {selectedTab === "overview" && data && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-ink/60 uppercase mb-3">Cost Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                  <span className="text-sm text-ink/80">Estimated Cost</span>
                  <span className="font-mono font-semibold">{formatCurrency(data.estimatedCost)}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                  <span className="text-sm text-ink/80">Actual Cost</span>
                  <span className={`font-mono font-semibold ${getCostColor(data.actualCost / 10)}`}>
                    {formatCurrency(data.actualCost)}
                  </span>
                </div>
                <div className="flex justify-between items-center p-3 bg-blue-50 rounded border border-blue-200">
                  <span className="text-sm text-blue-900 font-medium">Savings</span>
                  <span className="font-mono font-bold text-blue-700">
                    {formatCurrency(Math.max(0, data.estimatedCost - data.actualCost))}
                  </span>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            <div>
              <h3 className="text-sm font-semibold text-ink/60 uppercase mb-2">Budget Utilization</h3>
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    (data.actualCost / data.estimatedCost) * 100 > 100
                      ? "bg-red-500"
                      : (data.actualCost / data.estimatedCost) * 100 > 80
                      ? "bg-yellow-500"
                      : "bg-green-500"
                  }`}
                  style={{ width: `${Math.min(100, (data.actualCost / data.estimatedCost) * 100)}%` }}
                />
              </div>
              <div className="text-xs text-ink/60 mt-2">
                {((data.actualCost / data.estimatedCost) * 100).toFixed(0)}% of budget used
              </div>
            </div>
          </div>
        )}

        {selectedTab === "breakdown" && data && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-ink/60 uppercase mb-3">Cost Components</h3>
            <div className="space-y-3">
              {[
                { label: "LLM Generation", value: data.breakdown.llmCost, icon: "🤖" },
                { label: "Assertions", value: data.breakdown.assertionCost, icon: "✓" },
                { label: "Interaction Validation", value: data.breakdown.interactionCost, icon: "🖱️" },
                { label: "Crawling", value: data.breakdown.crawlCost, icon: "🕷️" },
              ].map((component) => {
                const percentage = (component.value / data.breakdown.totalCost) * 100;
                return (
                  <div key={component.label}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm">
                        {component.icon} {component.label}
                      </span>
                      <div className="text-right">
                        <div className="text-sm font-semibold">{formatCurrency(component.value)}</div>
                        <div className="text-xs text-ink/60">{percentage.toFixed(0)}%</div>
                      </div>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selectedTab === "trends" && data?.trends && data.trends.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-ink/60 uppercase mb-3">Historical Trends</h3>
            <div className="h-40 bg-gradient-to-b from-blue-50 to-gray-50 rounded-lg p-4 flex items-end gap-1">
              {data.trends.slice(-14).map((trend, idx) => {
                const maxCost = Math.max(...data.trends!.map(t => t.cost));
                return (
                  <div
                    key={idx}
                    className="flex-1 bg-blue-400 rounded-t-sm hover:bg-blue-500 transition"
                    style={{ height: `${(trend.cost / maxCost) * 100}%` }}
                    title={`${trend.date}: ${formatCurrency(trend.cost)}`}
                  />
                );
              })}
            </div>
            <div className="text-xs text-ink/60 text-center">Last 14 days</div>
          </div>
        )}

        {selectedTab === "recommendations" && data?.recommendations && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-ink/60 uppercase mb-3">Cost Optimization Tips</h3>
            {data.recommendations.length > 0 ? (
              <div className="space-y-2">
                {data.recommendations.map((rec, idx) => (
                  <div key={idx} className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex gap-3">
                    <span className="text-lg flex-shrink-0">{rec.substring(0, 2)}</span>
                    <span className="text-sm text-blue-900">{rec.substring(3)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-ink/50">No recommendations at this time</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
