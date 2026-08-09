export interface ActivityItem {
  id: string;
  type: "success" | "error" | "warning" | "info";
  action: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

interface ActivityFeedProps {
  items: ActivityItem[];
  maxItems?: number;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const typeConfig = {
  success: { icon: "✓", color: "text-green-600", bg: "bg-green-50" },
  error: { icon: "✕", color: "text-red-600", bg: "bg-red-50" },
  warning: { icon: "!", color: "text-amber-600", bg: "bg-amber-50" },
  info: { icon: "i", color: "text-blue-600", bg: "bg-blue-50" },
};

export function ActivityFeed({
  items,
  maxItems = 5,
}: ActivityFeedProps) {
  const displayed = items.slice(0, maxItems);

  if (displayed.length === 0) {
    return (
      <div className="text-center py-2">
        <p className="text-xs text-ink/50">No recent activity</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {displayed.map((item) => {
        const config = typeConfig[item.type];
        return (
          <li
            key={item.id}
            className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs ${config.bg}`}
          >
            <span
              className={`font-bold shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-white ${config.color.replace("text-", "bg-")}`}
            >
              {config.icon}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-ink font-medium truncate">{item.action}</p>
              {item.metadata?.detail && (
                <p className="text-ink/60 text-[10px] truncate mt-0.5">
                  {item.metadata.detail}
                </p>
              )}
            </div>
            <span className="text-ink/50 shrink-0 text-[10px]">
              {formatRelativeTime(item.timestamp)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
