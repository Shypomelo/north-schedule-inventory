import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        page: "var(--bg-page)",
        sidebar: "var(--bg-sidebar)",
        card: "var(--bg-card)",
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        "theme-border": "var(--border)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
        },
        danger: "var(--danger)",
        success: "var(--success)",
        warning: "var(--warning)",
      },
    },
  },
  plugins: [],
};
export default config;
