/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1c2b2d",
        paper: "#f6f4ee",
        signal: "#3f6b5e",
        "signal-soft": "#e3ebe6",
        alert: "#b3492e",
        "alert-soft": "#f5e3dd",
        warn: "#a3721f",
        "warn-soft": "#f2e6cd",
        line: "#d9d4c6",
      },
      fontFamily: {
        display: ["'IBM Plex Mono'", "monospace"],
        body: ["'Inter'", "system-ui", "sans-serif"],
      },
      boxShadow: {
        panel: "0 1px 2px rgba(28,43,45,0.06), 0 8px 24px rgba(28,43,45,0.08)",
      },
    },
  },
  plugins: [],
};
