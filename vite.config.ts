import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    worker: { format: "es" },
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    server: {
      strictPort: true,
      proxy: {
        "/v1": {
          target: env.EZPZ_API_URL || "http://127.0.0.1:4173",
          changeOrigin: true,
        },
      },
    },
    preview: {
      proxy: {
        "/v1": {
          target: env.EZPZ_API_URL || "http://127.0.0.1:4173",
          changeOrigin: true,
        },
      },
    },
  };
});
