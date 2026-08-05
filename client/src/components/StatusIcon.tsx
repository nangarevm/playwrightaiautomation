// Small inline status icons used to give upload/generation pills a lightweight
// animated state (spinner while in-flight, check when done) instead of plain
// text swaps. No new dependency -- just SVG + Tailwind's built-in animate-spin.
export function Spinner({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function CheckIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 010 1.415l-7.4 7.4a1 1 0 01-1.415 0l-3.6-3.6a1 1 0 111.415-1.414l2.892 2.892 6.693-6.693a1 1 0 011.415 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}
