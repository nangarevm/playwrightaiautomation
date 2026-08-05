export interface TabDef<T extends string> {
  key: T;
  label: string;
}

// Shared segmented tab-bar used by the hub pages (Library/Reports/Settings) and the
// step tracker on Run -- one visual pattern for "several existing pages/steps grouped
// under one nav entry" instead of each hub re-inventing tab markup.
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
      {tabs.map((t) => (
        <button
          key={t.key}
          data-testid={`tab-${t.key}`}
          className={`rounded-full px-3.5 py-1.5 font-medium transition-colors ${
            active === t.key ? "bg-ink text-paper" : "text-ink/60 hover:text-ink"
          }`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
