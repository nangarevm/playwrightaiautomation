import { useState, useEffect } from "react";

export interface StatusTickerData {
  isRunning: boolean;
  elapsedSeconds: number;
  costAccumulated: number;
  bugsFound: number;
  pagesProcessed: number;
  pagesTotal: number;
  currentOperation: string | null;
  status: "idle" | "running" | "warning" | "error";
}

interface StatusTickerProps {
  data?: Partial<StatusTickerData>;
}

const defaultData: StatusTickerData = {
  isRunning: false,
  elapsedSeconds: 0,
  costAccumulated: 0,
  bugsFound: 0,
  pagesProcessed: 0,
  pagesTotal: 0,
  currentOperation: null,
  status: "idle",
};

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function StatusTicker({ data = {} }: StatusTickerProps) {
  const merged = { ...defaultData, ...data };
  const [displayTime, setDisplayTime] = useState(merged.elapsedSeconds);

  useEffect(() => {
    if (!merged.isRunning) return;
    
    const interval = setInterval(() => {
      setDisplayTime((prev) => prev + 1);
    }, 1000);
    
    return () => clearInterval(interval);
  }, [merged.isRunning]);

  // Reset time when operation stops
  useEffect(() => {
    if (!merged.isRunning) {
      setDisplayTime(merged.elapsedSeconds);
    }
  }, [merged.isRunning, merged.elapsedSeconds]);

  // Don't show when idle and no data
  if (
    !merged.isRunning &&
    merged.costAccumulated === 0 &&
    merged.bugsFound === 0 &&
    merged.pagesProcessed === 0
  ) {
    return null;
  }

  const statusColors = {
    idle: "bg-gray-50 text-gray-700",
    running: "bg-blue-50 text-blue-700",
    warning: "bg-amber-50 text-amber-700",
    error: "bg-red-50 text-red-700",
  };

  return (
    <div
      className={`border-b border-line ${statusColors[merged.status]} sticky top-[56px] z-20 px-4 py-2 text-xs`}
    >
      <div className="max-w-6xl mx-auto flex items-center gap-4 flex-wrap">
        {merged.currentOperation && (
          <div className="flex items-center gap-2">
            {merged.isRunning && (
              <span className="inline-block h-2 w-2 rounded-full bg-current animate-pulse" />
            )}
            <span className="font-medium">{merged.currentOperation}</span>
          </div>
        )}

        {merged.isRunning && (
          <span className="font-medium">
            ⏱️ {formatTime(displayTime)}
          </span>
        )}

        {merged.costAccumulated > 0 && (
          <span>💰 {formatCost(merged.costAccumulated)}</span>
        )}

        {merged.bugsFound > 0 && (
          <span>🐛 {merged.bugsFound} bug{merged.bugsFound !== 1 ? "s" : ""}</span>
        )}

        {merged.pagesTotal > 0 && (
          <span>
            📄 {merged.pagesProcessed}/{merged.pagesTotal}
          </span>
        )}

        <div className="flex-1" />

        {merged.isRunning && (
          <span className="text-xs opacity-75 italic">
            {merged.status === "warning" && "⚠️ Slow"}
            {merged.status === "error" && "❌ Error occurred"}
          </span>
        )}
      </div>
    </div>
  );
}
