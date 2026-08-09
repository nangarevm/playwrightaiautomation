import { useState } from "react";

export type FastModeType = "critical" | "balanced" | "full";

export interface FastModeProfile {
  type: FastModeType;
  icon: string;
  name: string;
  duration: string;
  cost: string;
  bugDetectionRate: string;
  useCase: string;
  description: string;
  isRecommended?: boolean;
}

interface FastModeSelectorProps {
  selected?: FastModeType;
  onSelect?: (mode: FastModeType) => void;
  onApply?: (mode: FastModeType) => void;
}

const modeProfiles: Record<FastModeType, FastModeProfile> = {
  critical: {
    type: "critical",
    icon: "🚀",
    name: "Critical",
    duration: "2 min",
    cost: "$4",
    bugDetectionRate: "60-70%",
    useCase: "Quick validation",
    description: "Fastest execution. Critical paths only. Quick sanity checks.",
  },
  balanced: {
    type: "balanced",
    icon: "⭐",
    name: "Balanced",
    duration: "5 min",
    cost: "$15",
    bugDetectionRate: "80-85%",
    useCase: "Daily testing",
    description: "Best balance. Critical + edge cases. Recommended for most runs.",
    isRecommended: true,
  },
  full: {
    type: "full",
    icon: "🐛",
    name: "Full",
    duration: "20 min",
    cost: "$50",
    bugDetectionRate: "95-98%",
    useCase: "Pre-release",
    description: "Comprehensive coverage. Everything tested. Maximum detection.",
  },
};

export function FastModeSelector({
  selected = "balanced",
  onSelect,
  onApply,
}: FastModeSelectorProps) {
  const [selectedMode, setSelectedMode] = useState<FastModeType>(selected);
  const [showComparison, setShowComparison] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [compareMode, setCompareMode] = useState<FastModeType | null>(null);

  const handleSelect = (mode: FastModeType) => {
    setSelectedMode(mode);
    onSelect?.(mode);
  };

  const handleApply = () => {
    onApply?.(selectedMode);
  };

  const currentProfile = modeProfiles[selectedMode];

  return (
    <div className="space-y-6 p-6 bg-white rounded-lg border border-line shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-ink">⚡ Fast Mode Tuning</h3>
          <p className="text-sm text-ink/60 mt-1">
            Select and compare execution profiles for your needs
          </p>
        </div>
      </div>

      {/* Mode Selection Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(["critical", "balanced", "full"] as const).map((modeKey) => {
          const profile = modeProfiles[modeKey];
          const isSelected = selectedMode === modeKey;

          return (
            <button
              key={modeKey}
              onClick={() => handleSelect(modeKey)}
              className={`relative p-4 rounded-lg border-2 transition transform hover:scale-105 ${
                isSelected
                  ? "border-ink bg-ink/5 shadow-md"
                  : "border-line bg-gray-50 hover:bg-gray-100"
              }`}
            >
              {/* Recommended Badge */}
              {profile.isRecommended && (
                <div className="absolute -top-3 -right-3 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full border border-yellow-500 shadow-md">
                  ⭐ Recommended
                </div>
              )}

              {/* Selection Indicator */}
              {isSelected && (
                <div className="absolute top-2 right-2 w-5 h-5 bg-ink rounded-full flex items-center justify-center">
                  <span className="text-white text-xs">✓</span>
                </div>
              )}

              <div className="text-3xl mb-3">{profile.icon}</div>
              <h4 className="font-bold text-ink text-lg text-left">{profile.name}</h4>

              <div className="space-y-2 mt-3 text-left">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-ink/60">Duration</span>
                  <span className="text-sm font-semibold text-ink">{profile.duration}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-ink/60">Cost</span>
                  <span className="text-sm font-semibold text-ink">{profile.cost}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-ink/60">Detection</span>
                  <span className="text-sm font-semibold text-green-600">
                    {profile.bugDetectionRate}
                  </span>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-line">
                <p className="text-xs text-ink/70 text-left">{profile.useCase}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Comparison Toggle */}
      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-line">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showComparison}
            onChange={(e) => setShowComparison(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm font-medium text-ink/80">
            Compare modes side-by-side
          </span>
        </label>
        <span className="text-xs text-ink/50">📊 Analytics</span>
      </div>

      {/* Comparison Section */}
      {showComparison && (
        <div className="space-y-3 p-4 bg-blue-50 rounded-lg border border-blue-200 animate-in fade-in slide-in-from-top-2">
          <h4 className="font-semibold text-sm text-blue-900 mb-3">Mode Comparison</h4>

          <div className="space-y-2">
            {/* Duration Comparison */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-blue-900">Duration</span>
              </div>
              <div className="flex gap-2">
                {(["critical", "balanced", "full"] as const).map((mode) => (
                  <div key={mode} className="flex-1 text-center">
                    <div className="text-xs font-semibold text-blue-700 bg-white rounded p-2">
                      {modeProfiles[mode].duration}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Cost Comparison */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-blue-900">Cost</span>
              </div>
              <div className="flex gap-2">
                {(["critical", "balanced", "full"] as const).map((mode) => (
                  <div key={mode} className="flex-1 text-center">
                    <div className="text-xs font-semibold text-blue-700 bg-white rounded p-2">
                      {modeProfiles[mode].cost}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Detection Rate Comparison */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-blue-900">Bug Detection</span>
              </div>
              <div className="flex gap-2">
                {(["critical", "balanced", "full"] as const).map((mode) => (
                  <div key={mode} className="flex-1">
                    <div className="text-xs font-semibold text-blue-700 bg-white rounded p-2 text-center">
                      {modeProfiles[mode].bugDetectionRate}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Selected Mode Details */}
      <div className="p-4 bg-gray-50 rounded-lg border border-line">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{currentProfile.icon}</span>
            <div>
              <h4 className="font-bold text-ink">{currentProfile.name} Mode</h4>
              <p className="text-xs text-ink/60">{currentProfile.description}</p>
            </div>
          </div>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-xs text-ink/50 hover:text-ink transition"
          >
            {showDetails ? "Hide" : "Show"} details
          </button>
        </div>

        {showDetails && (
          <div className="space-y-2 mb-3 p-3 bg-white rounded border border-line">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-ink/60">Duration:</span>
                <span className="font-semibold ml-1">{currentProfile.duration}</span>
              </div>
              <div>
                <span className="text-ink/60">Cost:</span>
                <span className="font-semibold ml-1">{currentProfile.cost}</span>
              </div>
              <div>
                <span className="text-ink/60">Detection:</span>
                <span className="font-semibold ml-1 text-green-600">
                  {currentProfile.bugDetectionRate}
                </span>
              </div>
              <div>
                <span className="text-ink/60">Use Case:</span>
                <span className="font-semibold ml-1">{currentProfile.useCase}</span>
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleApply}
            className="flex-1 px-4 py-2 bg-ink text-white rounded font-medium text-sm hover:bg-ink/90 transition"
          >
            ✓ Apply Mode
          </button>
          <button className="flex-1 px-4 py-2 bg-blue-100 text-blue-700 rounded font-medium text-sm hover:bg-blue-200 transition">
            📋 View Details
          </button>
        </div>
      </div>

      {/* Helpful Tip */}
      <div className="p-3 bg-blue-50 rounded border border-blue-200 text-xs text-blue-900">
        <span className="font-semibold">💡 Tip:</span> Balanced Mode is recommended for most
        workflows. Switch to Critical for speed or Full for comprehensive coverage.
      </div>
    </div>
  );
}
