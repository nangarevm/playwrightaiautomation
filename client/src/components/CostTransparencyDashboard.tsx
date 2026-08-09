import { useState, useEffect } from "react";

export interface CostTransparencyData {
  todayCost: number;
  weekCost: number;
  monthCost: number;
  timeSavedHours: number;
  roiMultiplier: number;
  breakdownChartData: Array<{
    category: string;
    percentage: number;
    color: string;
  }>;
  trends: Array<{
    date: string;
    cost: number;
  }>;
  recommendations: Array<{
    icon: string;
    title: string;
    savingsPercent: string;
  }>;
}

interface CostTransparencyDashboardProps {
  data?: CostTransparencyData;
  isLive?: boolean;
}

const defaultData: CostTransparencyData = {
  todayCost: 45.2,
  weekCost: 280.5,
  monthCost: 1052.8,
  timeSavedHours: 12,
  roiMultiplier: 22.4,
  breakdownChartData: [
    { category: "LLM", percentage: 35, color: "bg-blue-500" },
    { category: "Compute", percentage: 40, color: "bg-purple-500" },
    { category: "Storage", percentage: 15, color: "bg-green-500" },
    { category: "Data Transfer", percentage: 10, color: "bg-orange-500" },
  ],
  trends: [
    { date: "Mon", cost: 45.2 },
    { date: "Tue", cost: 52.1 },
    { date: "Wed", cost: 38.9 },
    { date: "Thu", cost: 48.5 },
    { date: "Fri", cost: 62.3 },
    { date: "Sat", cost: 18.7 },
    { date: "Sun", cost: 15.8 },
  ],
  recommendations: [
    { icon: "⚡", title: "Switch to Fast Mode", savingsPercent: "30-50%" },
    { icon: "🔄", title: "Enable Incremental Crawl", savingsPercent: "40-60%" },
  ],
};

export function CostTransparencyDashboard({
  data = defaultData,
  isLive = false,
}: CostTransparencyDashboardProps) {
  const [selectedTab, setSelectedTab] = useState<
    "overview" | "breakdown" | "trends" | "recommendations"
  >("overview");

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
  const formatHours = (value: number) => `${value}h`;

  const getTrendColor = (trend: number, prevTrend: number | undefined) => {
    if (!prevTrend) return "text-ink/60";
    return trend < prevTrend ? "text-green-600" : "text-red-600";
  };

  const pieSlices = data.breakdownChartData.map((item, idx) => {
    let cumulativePercentage = data.breakdownChartData
      .slice(0, idx)
      .reduce((sum, d) => sum + d.percentage, 0);

    const startAngle = (cumulativePercentage / 100) * 360;
    const endAngle = ((cumulativePercentage + item.percentage) / 100) * 360;

    return {
      ...item,
      startAngle,
      endAngle,
    };
  });

  return (
    <div className="space-y-6 p-6 bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-ink">💰 Cost Transparency Dashboard</h2>
          <p className="text-sm text-ink/60 mt-1">Real-time cost tracking and optimization insights</p>
        </div>
        {isLive && (
          <div className="flex items-center gap-2 text-green-600 text-sm font-semibold animate-pulse">
            ● Live
          </div>
        )}
      </div>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg p-4 border border-line shadow-sm hover:shadow-md transition">
          <div className="text-xs text-ink/60 font-semibold uppercase mb-1">Today</div>
          <div className="text-2xl font-bold text-ink">{formatCurrency(data.todayCost)}</div>
          <div className="text-xs text-ink/40 mt-2">Daily cost</div>
        </div>

        <div className="bg-white rounded-lg p-4 border border-line shadow-sm hover:shadow-md transition">
          <div className="text-xs text-ink/60 font-semibold uppercase mb-1">This Week</div>
          <div className="text-2xl font-bold text-ink">{formatCurrency(data.weekCost)}</div>
          <div className="text-xs text-ink/40 mt-2">7-day total</div>
        </div>

        <div className="bg-white rounded-lg p-4 border border-line shadow-sm hover:shadow-md transition">
          <div className="text-xs text-ink/60 font-semibold uppercase mb-1">Time Saved</div>
          <div className="text-2xl font-bold text-green-600">{formatHours(data.timeSavedHours)}</div>
          <div className="text-xs text-green-600 mt-2">vs manual QA</div>
        </div>

        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200 shadow-sm hover:shadow-md transition">
          <div className="text-xs text-blue-900 font-semibold uppercase mb-1">ROI</div>
          <div className="text-2xl font-bold text-blue-700">{data.roiMultiplier}x</div>
          <div className="text-xs text-blue-600 mt-2">Return multiplier</div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex border-b border-line bg-white rounded-t-lg">
        {(
          ["overview", "breakdown", "trends", "recommendations"] as const
        ).map((tab) => (
          <button
            key={tab}
            onClick={() => setSelectedTab(tab)}
            className={`flex-1 px-4 py-3 text-sm font-semibold border-b-2 transition capitalize ${
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

      {/* Tab Content */}
      <div className="bg-white rounded-lg p-6 space-y-6 min-h-64">
        {/* Overview Tab */}
        {selectedTab === "overview" && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-ink/60 uppercase">Cost Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <span className="text-sm text-ink/80">Month to Date</span>
                <span className="font-mono font-semibold text-lg">
                  {formatCurrency(data.monthCost)}
                </span>
              </div>
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <span className="text-sm text-ink/80">Average Daily</span>
                <span className="font-mono font-semibold text-lg">
                  {formatCurrency(data.todayCost)}
                </span>
              </div>
              <div className="flex justify-between items-center p-3 bg-green-50 rounded border border-green-200">
                <span className="text-sm text-green-900 font-medium">Manual QA Equivalent</span>
                <span className="font-mono font-bold text-green-700">
                  {formatCurrency(data.monthCost * 15)}
                </span>
              </div>
            </div>

            {/* Budget Progress */}
            <div className="pt-4">
              <h3 className="text-sm font-semibold text-ink/60 uppercase mb-2">Budget Utilization</h3>
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-blue-500 transition-all"
                  style={{ width: "65%" }}
                />
              </div>
              <div className="text-xs text-ink/60 mt-2">65% of monthly budget used</div>
            </div>
          </div>
        )}

        {/* Breakdown Tab */}
        {selectedTab === "breakdown" && (
          <div className="space-y-6">
            <h3 className="text-sm font-semibold text-ink/60 uppercase">Cost Components</h3>

            {/* Pie Chart Visualization */}
            <div className="flex items-center justify-center mb-6">
              <svg width="200" height="200" viewBox="0 0 200 200" className="drop-shadow-md">
                <circle cx="100" cy="100" r="80" fill="none" />
                {pieSlices.map((slice, idx) => {
                  const startRad = (slice.startAngle * Math.PI) / 180;
                  const endRad = (slice.endAngle * Math.PI) / 180;
                  const x1 = 100 + 80 * Math.cos(startRad);
                  const y1 = 100 + 80 * Math.sin(startRad);
                  const x2 = 100 + 80 * Math.cos(endRad);
                  const y2 = 100 + 80 * Math.sin(endRad);
                  const largeArc = slice.percentage > 50 ? 1 : 0;

                  const pathData = [
                    `M 100 100`,
                    `L ${x1} ${y1}`,
                    `A 80 80 0 ${largeArc} 1 ${x2} ${y2}`,
                    "Z",
                  ].join(" ");

                  return (
                    <path
                      key={idx}
                      d={pathData}
                      className={slice.color}
                      opacity="0.9"
                    />
                  );
                })}
              </svg>
            </div>

            {/* Legend */}
            <div className="grid grid-cols-2 gap-3">
              {data.breakdownChartData.map((item) => (
                <div key={item.category} className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${item.color}`} />
                  <span className="text-sm text-ink/80">
                    {item.category} ({item.percentage}%)
                  </span>
                </div>
              ))}
            </div>

            {/* Breakdown Table */}
            <div className="space-y-2">
              {data.breakdownChartData.map((item) => (
                <div key={item.category}>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm text-ink/80">{item.category}</span>
                    <span className="text-sm font-semibold">
                      {formatCurrency((data.monthCost * item.percentage) / 100)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className={`h-full ${item.color} rounded-full transition-all`}
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Trends Tab */}
        {selectedTab === "trends" && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-ink/60 uppercase">Last 7 Days</h3>

            <div className="h-48 bg-gradient-to-b from-blue-50 to-gray-50 rounded-lg p-4 flex items-end gap-1.5">
              {data.trends.map((trend, idx) => {
                const maxCost = Math.max(...data.trends.map((t) => t.cost));
                return (
                  <div
                    key={idx}
                    className="flex-1 flex flex-col items-center gap-1"
                  >
                    <div
                      className="w-full bg-gradient-to-t from-blue-500 to-blue-400 rounded-t hover:from-blue-600 hover:to-blue-500 transition cursor-pointer group"
                      style={{ height: `${(trend.cost / maxCost) * 100}%`, minHeight: "8px" }}
                      title={`${trend.date}: ${formatCurrency(trend.cost)}`}
                    >
                      <div className="opacity-0 group-hover:opacity-100 transition text-xs font-bold text-white text-center mt-1">
                        {formatCurrency(trend.cost)}
                      </div>
                    </div>
                    <span className="text-xs text-ink/60 mt-2">{trend.date}</span>
                  </div>
                );
              })}
            </div>

            <div className="text-xs text-ink/60 text-center mt-4">
              Average: {formatCurrency(data.trends.reduce((sum, t) => sum + t.cost, 0) / data.trends.length)} per day
            </div>
          </div>
        )}

        {/* Recommendations Tab */}
        {selectedTab === "recommendations" && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-ink/60 uppercase mb-4">Cost Optimization Tips</h3>
            {data.recommendations.map((rec, idx) => (
              <div
                key={idx}
                className="p-4 bg-blue-50 border border-blue-200 rounded-lg flex gap-3 hover:bg-blue-100 transition"
              >
                <span className="text-2xl flex-shrink-0">{rec.icon}</span>
                <div className="flex-1">
                  <div className="font-semibold text-sm text-blue-900">{rec.title}</div>
                  <div className="text-xs text-blue-700 mt-1">
                    Potential savings: {rec.savingsPercent}
                  </div>
                </div>
              </div>
            ))}

            {/* Action Buttons */}
            <div className="flex gap-2 pt-4">
              <button className="flex-1 px-4 py-2 bg-blue-600 text-white rounded font-medium text-sm hover:bg-blue-700 transition">
                📥 Export Report
              </button>
              <button className="flex-1 px-4 py-2 bg-gray-200 text-ink rounded font-medium text-sm hover:bg-gray-300 transition">
                🔍 View Details
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
