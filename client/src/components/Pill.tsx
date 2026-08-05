import React from "react";

export const CATEGORY_COLOR: Record<string, string> = {
  Smoke: "bg-signal-soft text-signal border-signal/30",
  Regression: "bg-ink/10 text-ink border-ink/30",
  Functional: "bg-signal-soft text-signal border-signal/30",
  "Edge Case": "bg-warn-soft text-warn border-warn/40",
  Negative: "bg-alert-soft text-alert border-alert/30",
  API: "bg-indigo-100 text-indigo-800 border-indigo-300",
};

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const toneClass = {
    neutral: "bg-ink/5 text-ink/70 border-ink/15",
    good: "bg-signal-soft text-signal border-signal/30",
    bad: "bg-alert-soft text-alert border-alert/30",
    warn: "bg-warn-soft text-warn border-warn/40",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-display text-[10.5px] font-bold uppercase tracking-wide ${toneClass}`}
    >
      {children}
    </span>
  );
}
