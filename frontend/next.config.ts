import type { NextConfig } from "next";

// `npm run build` produces a static site in out/ that the FastAPI backend serves,
// so the whole app deploys as one service. `npm run dev` still works for local work.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true, // /edit/ -> edit/index.html, served as-is by FastAPI and the desktop app
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
