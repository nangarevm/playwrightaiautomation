import { useEffect, useState } from "react";

export interface IncrementalCrawlData {
  isEnabled: boolean;
  pagesScanned: number;
  totalPages: number;
  changedPages: number;
  reusePercentage: number;
  costSavings: number;
  lastBaselineDate: string;
  strategyRecommendation: string;
  isOptimal: boolean;
}

interface IncrementalCrawlIndicatorProps {
  data?: IncrementalCrawlData;
  onToggle?: (enabled: boolean) => void;
}

const defaultData: IncrementalCrawlData = {
  isEnabled: true,
  pagesScanned: 20,
  totalPages: 30,
  changedPages: 5,
  reusePercentage: 83,
  costSavings: 2.5,
  lastBaselineDate: "2 days ago",
  strategyRecommendation: "Incremental crawl is optimal for your setup",
  isOptimal: true,
};

export function IncrementalCrawlIndicator({
  data = defaultData,
  onToggle,
}: IncrementalCrawlIndicatorProps) {
  const [isEnabled, setIsEnabled] = useState(data.isEnabled);
  const [expanded, setExpanded] = useState(false);
  const live = data || defaultData;

  useEffect(() => {
    setIsEnabled(live.isEnabled);
  }, [live.isEnabled]);

  const handleToggle = (enabled: boolean) => {
    setIsEnabled(enabled);
    onToggle?.(enabled);
  };

  const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
  const reuseRate =
    live.pagesScanned > 0
      ? Math.round(((live.pagesScanned - live.changedPages) / live.pagesScanned) * 100)
      : live.reusePercentage || 0;

  return (
    <div className="space-y-4 p-6 bg-white rounded-lg border border-line shadow-sm hover:shadow-md transition">
      {/* Header with Toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🔄</span>
          <div>
            <h3 className="font-semibold text-ink">Incremental Crawl Status</h3>
            <p className="text-xs text-ink/60">Smart page change detection and reuse</p>
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => handleToggle(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm font-medium text-ink/80">
            {isEnabled ? "ON" : "OFF"}
          </span>
        </label>
      </div>

      {isEnabled && (
        <div className="space-y-4">
          {/* Progress Bars */}
          <div className="space-y-4">
            {/* Pages Scanned */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium text-ink/80">Pages Scanned</label>
                <span className="text-sm font-semibold text-ink">
                  {live.pagesScanned}/{Math.max(1, live.totalPages)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (live.pagesScanned / Math.max(1, live.totalPages)) * 100)}%`,
                  }}
                />
              </div>
            </div>

            {/* Changed Pages */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium text-ink/80">Changed Pages</label>
                <span className="text-sm font-semibold text-orange-600">
                  {live.changedPages} pages
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (live.changedPages / Math.max(1, live.totalPages)) * 100)}%`,
                  }}
                />
              </div>
            </div>

            {/* Reused Pages */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium text-ink/80">Reused Pages</label>
                <span className="text-sm font-semibold text-green-600">
                  {Math.max(0, live.pagesScanned - live.changedPages)} pages
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      (Math.max(0, live.pagesScanned - live.changedPages) /
                        Math.max(1, live.totalPages)) *
                        100
                    )}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Efficiency Badge */}
          <div className="flex items-center justify-between p-3 bg-green-50 rounded border border-green-200">
            <div>
              <div className="text-xs font-semibold text-green-900 uppercase">Efficiency</div>
              <div className="text-xs text-green-700 mt-0.5">Reuse rate</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-green-700">{reuseRate}%</div>
              <div className="text-xs text-green-600">✅ Excellent</div>
            </div>
          </div>

          {/* Cost Savings */}
          <div className="flex items-center justify-between p-3 bg-blue-50 rounded border border-blue-200">
            <div>
              <div className="text-xs font-semibold text-blue-900 uppercase">Cost Savings</div>
              <div className="text-xs text-blue-700 mt-0.5">This crawl</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-blue-700">
                {formatCurrency(live.costSavings)}
              </div>
              <div className="text-xs text-blue-600">Saved</div>
            </div>
          </div>

          {/* Expandable Details */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-left px-3 py-2 bg-gray-50 rounded hover:bg-gray-100 transition text-sm font-medium text-ink flex items-center justify-between"
          >
            <span>Details & Strategy</span>
            <span className={`transition-transform ${expanded ? "rotate-180" : ""}`}>
              ▼
            </span>
          </button>

          {expanded && (
            <div className="space-y-3 p-3 bg-gray-50 rounded border border-gray-200">
              <div>
                <div className="text-xs font-semibold text-ink/60 uppercase mb-1">
                  Last Baseline
                </div>
                <div className="text-sm text-ink">{live.lastBaselineDate}</div>
              </div>

              <div>
                <div className="text-xs font-semibold text-ink/60 uppercase mb-1">
                  Strategy Recommendation
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-lg flex-shrink-0">
                    {live.isOptimal ? "OK" : "!"}
                  </span>
                  <div className="text-sm text-ink">{live.strategyRecommendation}</div>
                </div>
              </div>
            </div>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2 bg-blue-50 rounded">
              <div className="text-xs font-semibold text-blue-900">{live.pagesScanned}</div>
              <div className="text-xs text-blue-700">Scanned</div>
            </div>
            <div className="p-2 bg-orange-50 rounded">
              <div className="text-xs font-semibold text-orange-900">{live.changedPages}</div>
              <div className="text-xs text-orange-700">Changed</div>
            </div>
            <div className="p-2 bg-green-50 rounded">
              <div className="text-xs font-semibold text-green-900">
                {Math.max(0, live.pagesScanned - live.changedPages)}
              </div>
              <div className="text-xs text-green-700">Reused</div>
            </div>
          </div>
        </div>
      )}

      {!isEnabled && (
        <div className="p-4 bg-gray-50 rounded border border-gray-200 text-center">
          <p className="text-sm text-ink/60">
            Incremental crawl is disabled. Enable it to skip unchanged pages and save on costs.
          </p>
        </div>
      )}
    </div>
  );
}
