import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Production deploys must never ingest a developer's ignored `.env.local`.
  // Public production values are supplied explicitly by `build:production`,
  // while server secrets remain runtime-only Cloudflare Worker secrets.
  envDir: process.env.ICHEF_PRODUCTION_BUILD === "1" ? false : undefined,
  server: { port: 3007 },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
  ],
});
