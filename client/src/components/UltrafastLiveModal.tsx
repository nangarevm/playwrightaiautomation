import { useEffect, useState } from "react";

interface ExecutionProgress {
  status: string;
  progress: number;
  testsPassed: number;
  testsFailed: number;
  totalTests: number;
  bugsFound: number;
  costAccumulated: number;
  estimatedTimeRemaining: number;
}

interface UltrafastLiveModalProps {
  runId: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function UltrafastLiveModal({ runId, isOpen, onClose }: UltrafastLiveModalProps) {
  const [progress, setProgress] = useState<ExecutionProgress | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (!isOpen || !runId) return;

    // Connect to Server-Sent Events stream
    const eventSource = new EventSource(`/api/execution/${runId}/stream`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "progress") {
          setProgress(data);
        }
      } catch (err) {
        console.error("Failed to parse SSE message:", err);
      }
    };

    return () => {
      eventSource.close();
    };
  }, [runId, isOpen]);

  if (!isOpen || !progress) return null;

  const passRate = progress.totalTests > 0 ? Math.round((progress.testsPassed / progress.totalTests) * 100) : 0;
  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-500 text-white p-6 flex justify-between items-center">
          <div>
            <h3 className="text-xl font-bold">🚀 Ultrafast Execution</h3>
            <p className="text-blue-100 text-sm mt-1">Real-time progress monitoring</p>
          </div>
          <button onClick={onClose} className="text-2xl text-white hover:text-blue-100 transition">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 flex-1 overflow-y-auto">
          {/* Progress Bar */}
          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium text-ink">Overall Progress</span>
              <span className="text-sm font-bold text-blue-600">{progress.progress}%</span>
            </div>
            <div className="w-full bg-line rounded-full h-3 overflow-hidden">
              <div
                className="bg-gradient-to-r from-blue-500 to-blue-400 h-full transition-all duration-300"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-lg border border-line p-4">
              <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">Passed</p>
              <p className="text-3xl font-bold text-green-600 mt-2">{progress.testsPassed}</p>
              <p className="text-xs text-ink/50 mt-1">{passRate}% pass rate</p>
            </div>

            <div className="bg-white rounded-lg border border-line p-4">
              <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">Failed</p>
              <p className={`text-3xl font-bold mt-2 ${progress.testsFailed > 0 ? "text-red-600" : "text-ink/30"}`}>
                {progress.testsFailed}
              </p>
              <p className="text-xs text-ink/50 mt-1">of {progress.totalTests} tests</p>
            </div>

            <div className="bg-white rounded-lg border border-line p-4">
              <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">Bugs Found</p>
              <p className={`text-3xl font-bold mt-2 ${progress.bugsFound > 0 ? "text-yellow-600" : "text-ink/30"}`}>
                {progress.bugsFound}
              </p>
              <p className="text-xs text-ink/50 mt-1">discovered issues</p>
            </div>

            <div className="bg-white rounded-lg border border-line p-4">
              <p className="text-xs uppercase tracking-wide text-ink/60 font-semibold">Cost</p>
              <p className="text-3xl font-bold text-purple-600 mt-2">${progress.costAccumulated.toFixed(2)}</p>
              <p className="text-xs text-ink/50 mt-1">estimated cost</p>
            </div>
          </div>

          {/* Time Remaining */}
          <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
            <p className="text-xs uppercase tracking-wide text-blue-900 font-semibold mb-2">Time Remaining</p>
            <p className="text-2xl font-bold text-blue-600">{formatTime(progress.estimatedTimeRemaining)}</p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-line bg-gray-50 p-4 flex justify-between items-center">
          <span className="text-xs text-ink/50">Run ID: {runId}</span>
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>
    </div>
  );
}
