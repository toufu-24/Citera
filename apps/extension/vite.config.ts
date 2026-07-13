import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  envDir: resolve(import.meta.dirname, "../.."),
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: mode === "development",
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "popup.html"),
        options: resolve(import.meta.dirname, "options.html"),
        "service-worker": resolve(import.meta.dirname, "src/background/service-worker.ts"),
        "content-script": resolve(import.meta.dirname, "src/content/content-script.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "service-worker" || chunk.name === "content-script"
            ? "[name].js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
