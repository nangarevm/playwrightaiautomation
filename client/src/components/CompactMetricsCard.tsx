interface CompactMetricsCardProps {
  icon: string;
  label: string;
  value: number | string;
  unit?: string;
  trend?: "up" | "down" | "stable";
  onClick?: () => void;
  className?: string;
}

export function CompactMetricsCard({
  icon,
  label,
  value,
  unit = "",
  trend,
  onClick,
  className = "",
}: CompactMetricsCardProps) {
  const trendIcon = {
    up: "📈",
    down: "📉",
    stable: "→",
  }[trend || "stable"];

  return (
    <button
      onClick={onClick}
      className={`rounded-lg border border-line bg-white/60 p-3 text-left transition-all hover:bg-white hover:border-signal/50 ${
        onClick ? "cursor-pointer" : "cursor-default"
      } ${className}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-xl leading-none">{icon}</span>
        {trend && <span className="text-xs opacity-60">{trendIcon}</span>}
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/50 mb-1">
        {label}
      </p>
      <div className="flex items-baseline gap-1">
        <p className="text-sm font-bold text-ink">{value}</p>
        {unit && <p className="text-xs text-ink/50">{unit}</p>}
      </div>
    </button>
  );
}
