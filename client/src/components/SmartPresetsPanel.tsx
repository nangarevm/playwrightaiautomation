import { useState } from "react";

export type PresetType = "smoke" | "quick" | "full" | "nightly" | "incremental" | "custom";

export interface TestPreset {
  id: PresetType;
  icon: string;
  name: string;
  duration: string;
  cost: number;
  useCase: string;
  description: string;
  coverage: string;
}

interface SmartPresetsPanelProps {
  selected?: PresetType;
  onSelect?: (preset: PresetType) => void;
  onStart?: (preset: PresetType) => void;
  maxBudget?: number;
}

const presets: Record<PresetType, TestPreset> = {
  smoke: {
    id: "smoke",
    icon: "🔥",
    name: "Smoke Test",
    duration: "2 min",
    cost: 4,
    useCase: "Quick validation",
    description: "Is the app working?",
    coverage: "Basic (60-70%)",
  },
  quick: {
    id: "quick",
    icon: "⚡",
    name: "Quick Scan",
    duration: "5 min",
    cost: 10,
    useCase: "Daily testing",
    description: "Fast coverage of main flows",
    coverage: "Good (75-80%)",
  },
  full: {
    id: "full",
    icon: "🐛",
    name: "Full Validation",
    duration: "20 min",
    cost: 50,
    useCase: "Pre-release",
    description: "Everything, before shipping",
    coverage: "Excellent (90-95%)",
  },
  nightly: {
    id: "nightly",
    icon: "🌙",
    name: "Nightly Deep Dive",
    duration: "60 min",
    cost: 150,
    useCase: "Overnight runs",
    description: "Comprehensive regression testing",
    coverage: "Comprehensive (95-98%)",
  },
  incremental: {
    id: "incremental",
    icon: "🔄",
    name: "Incremental Check",
    duration: "5 min",
    cost: 5,
    useCase: "After commits",
    description: "Only changed pages",
    coverage: "Targeted (85%)",
  },
  custom: {
    id: "custom",
    icon: "⚙️",
    name: "Custom",
    duration: "Varies",
    cost: 0,
    useCase: "Advanced users",
    description: "Build your own preset",
    coverage: "Custom",
  },
};

export function SmartPresetsPanel({
  selected = "quick",
  onSelect,
  onStart,
  maxBudget = 200,
}: SmartPresetsPanelProps) {
  const [selectedPreset, setSelectedPreset] = useState<PresetType>(selected);
  const [budgetFilter, setBudgetFilter] = useState<number>(maxBudget);
  const [useCaseFilter, setUseCaseFilter] = useState<string>("");
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState("");

  const handleSelect = (preset: PresetType) => {
    setSelectedPreset(preset);
    onSelect?.(preset);
  };

  const handleStart = () => {
    onStart?.(selectedPreset);
  };

  // Filter presets based on budget and use case
  const filteredPresets = Object.values(presets).filter((preset) => {
    if (preset.id === "custom") return true; // Always show custom
    const withinBudget = preset.cost <= budgetFilter;
    const matchesUseCase = !useCaseFilter || preset.useCase.includes(useCaseFilter);
    return withinBudget && matchesUseCase;
  });

  const availableUseCases = [
    ...new Set(Object.values(presets).map((p) => p.useCase)),
  ].filter((uc) => uc !== "Advanced users" && uc !== "Build your own preset");

  const currentPreset = presets[selectedPreset];

  return (
    <div className="space-y-6 p-6 bg-white rounded-lg border border-line shadow-sm">
      {/* Header */}
      <div>
        <h3 className="text-lg font-bold text-ink">🎯 Smart Test Presets</h3>
        <p className="text-sm text-ink/60 mt-1">
          Pre-configured execution profiles for common scenarios
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-line">
        <h4 className="text-xs font-semibold text-ink/60 uppercase">Filters</h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Budget Filter */}
          <div>
            <label className="text-xs font-medium text-ink/80 block mb-2">
              Max Budget: ${budgetFilter}
            </label>
            <input
              type="range"
              min="0"
              max="200"
              value={budgetFilter}
              onChange={(e) => setBudgetFilter(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-ink/50 mt-1">
              <span>$0</span>
              <span>$200</span>
            </div>
          </div>

          {/* Use Case Filter */}
          <div>
            <label className="text-xs font-medium text-ink/80 block mb-2">
              Use Case
            </label>
            <select
              value={useCaseFilter}
              onChange={(e) => setUseCaseFilter(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded text-sm"
            >
              <option value="">All use cases</option>
              {availableUseCases.map((uc) => (
                <option key={uc} value={uc}>
                  {uc}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <button className="flex-1 px-3 py-2 bg-blue-100 text-blue-700 rounded text-xs font-medium hover:bg-blue-200 transition">
            💡 Recommend for me
          </button>
          <button
            onClick={() => setShowCustom(true)}
            className="flex-1 px-3 py-2 bg-gray-200 text-ink rounded text-xs font-medium hover:bg-gray-300 transition"
          >
            ➕ Save Custom Preset
          </button>
        </div>
      </div>

      {/* Preset Grid */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-ink/60 uppercase">Available Presets</h4>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {filteredPresets.map((preset) => {
            const isSelected = selectedPreset === preset.id;

            return (
              <button
                key={preset.id}
                onClick={() => handleSelect(preset.id)}
                className={`relative p-4 rounded-lg border-2 transition transform hover:scale-105 text-left ${
                  isSelected
                    ? "border-ink bg-ink/5 shadow-md"
                    : "border-line bg-gray-50 hover:bg-gray-100"
                }`}
              >
                {/* Selection Indicator */}
                {isSelected && (
                  <div className="absolute top-2 right-2 w-5 h-5 bg-ink rounded-full flex items-center justify-center shadow-md">
                    <span className="text-white text-xs">✓</span>
                  </div>
                )}

                <div className="text-2xl mb-2">{preset.icon}</div>
                <h5 className="font-bold text-sm text-ink line-clamp-1">
                  {preset.name}
                </h5>
                <p className="text-xs text-ink/60 mt-1">{preset.description}</p>

                <div className="flex justify-between items-center mt-2 pt-2 border-t border-line">
                  <div className="text-xs">
                    <span className="text-ink/60">{preset.duration}</span>
                    <span className="text-ink/80 font-semibold ml-1">${preset.cost}</span>
                  </div>
                  <span className="text-xs font-semibold text-green-600">{preset.coverage}</span>
                </div>
              </button>
            );
          })}
        </div>

        {filteredPresets.length === 0 && (
          <div className="text-center p-6 bg-gray-50 rounded border border-line">
            <p className="text-sm text-ink/60">
              No presets match your filters. Adjust budget or use case.
            </p>
          </div>
        )}
      </div>

      {/* Selected Preset Details */}
      <div className="space-y-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-ink">Selected Preset</h4>
          <span className="text-2xl">{currentPreset.icon}</span>
        </div>

        <div className="space-y-2">
          <div>
            <div className="text-xs text-blue-700 font-semibold uppercase">Preset Name</div>
            <div className="text-sm font-bold text-ink mt-1">{currentPreset.name}</div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 bg-white rounded border border-blue-200">
              <div className="text-xs text-blue-700 font-semibold">Duration</div>
              <div className="text-sm font-bold text-ink mt-1">{currentPreset.duration}</div>
            </div>
            <div className="p-2 bg-white rounded border border-blue-200">
              <div className="text-xs text-blue-700 font-semibold">Cost</div>
              <div className="text-sm font-bold text-ink mt-1">${currentPreset.cost}</div>
            </div>
            <div className="p-2 bg-white rounded border border-blue-200">
              <div className="text-xs text-blue-700 font-semibold">Coverage</div>
              <div className="text-sm font-bold text-ink mt-1">{currentPreset.coverage}</div>
            </div>
          </div>

          <div className="p-2 bg-white rounded border border-blue-200">
            <div className="text-xs text-blue-700 font-semibold">Best For</div>
            <div className="text-sm text-ink mt-1">{currentPreset.useCase}</div>
          </div>
        </div>

        {/* Start Button */}
        <button
          onClick={handleStart}
          className="w-full px-4 py-3 bg-ink text-white rounded-lg font-bold text-sm hover:bg-ink/90 transition shadow-md hover:shadow-lg"
        >
          ▶️ Start with this preset
        </button>
      </div>

      {/* Custom Preset Modal */}
      {showCustom && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl animate-in fade-in zoom-in-95">
            <h3 className="text-lg font-bold text-ink mb-4">Save Custom Preset</h3>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-ink/80 block mb-2">
                  Preset Name
                </label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g., 'Staging Tests'"
                  className="w-full px-3 py-2 border border-line rounded text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-ink/80">Configuration</label>
                <div className="space-y-2 p-3 bg-gray-50 rounded">
                  <div className="flex justify-between text-sm">
                    <span>Mode</span>
                    <span className="font-semibold">Fast</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Max Pages</span>
                    <span className="font-semibold">20</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Parallelism</span>
                    <span className="font-semibold">5</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Video Recording</span>
                    <span className="font-semibold">Off</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setShowCustom(false)}
                className="flex-1 px-4 py-2 border border-line rounded text-sm font-medium hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCustom(false);
                  setCustomName("");
                }}
                className="flex-1 px-4 py-2 bg-ink text-white rounded text-sm font-medium hover:bg-ink/90 transition"
              >
                Save Preset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
