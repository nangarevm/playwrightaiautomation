export function StatTile({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: "up" | "down";
}) {
  return (
    <div className="panel p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 text-2xl font-display font-bold tabular-nums">{value}</p>
      {sub && (
        <p className={`text-xs mt-1 ${trend === "down" ? "text-alert" : trend === "up" ? "text-signal" : "text-ink/50"}`}>
          {sub}
        </p>
      )}
    </div>
  );
}
