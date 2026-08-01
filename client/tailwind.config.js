/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1c2b2d",
        paper: "#f6f4ee",
        signal: "#3f6b5e",
        alert: "#b3492e",
        line: "#d9d4c6",
      },
      fontFamily: {
        display: ["'IBM Plex Mono'", "monospace"],
        body: ["'Inter'", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
