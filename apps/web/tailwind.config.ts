import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        apex: {
          navy: "#001639",
          "navy-light": "#002255",
          "navy-dark": "#000e24",
          indigo: "#6366f1",
          "indigo-light": "#818cf8",
          "indigo-dark": "#4f46e5",
          slate: "#1e293b",
          "slate-light": "#334155",
          muted: "#94a3b8",
          surface: "#0f172a",
          card: "#1a2332",
          border: "#2d3a4d",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
