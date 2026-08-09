interface LiveProgressBarProps {
  progress: number; // 0-100
  label?: string;
  estimatedSecondsRemaining?: number;
  onCancel?: () => void;
  isIndeterminate?: boolean;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

export function LiveProgressBar({
  progress,
  label,
  estimatedSecondsRemaining,
  onCancel,
  isIndeterminate = false,
}: LiveProgressBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {label && <p className="text-xs font-medium text-ink">{label}</p>}
        <div className="flex-1" />
        {estimatedSecondsRemaining !== undefined && (
          <p className="text-xs text-ink/60">
            ~{formatTime(estimatedSecondsRemaining)} remaining
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-line overflow-hidden">
          {isIndeterminate ? (
            <div className="h-full w-1/3 bg-signal rounded-full animate-pulse" />
          ) : (
            <div
              className="h-full bg-signal rounded-full transition-all"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          )}
        </div>

        {!isIndeterminate && (
          <p className="text-xs font-medium text-ink/70 w-10 text-right">
            {Math.round(progress)}%
          </p>
        )}

        {onCancel && (
          <button
            onClick={onCancel}
            className="text-xs text-alert hover:text-alert/80 font-medium px-2 py-1 rounded border border-alert/30 hover:border-alert/60 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
