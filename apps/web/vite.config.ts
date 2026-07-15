import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      injectRegister: "auto",
      registerType: "autoUpdate",
      manifest: {
        name: "Citera — 論文ライブラリ",
        short_name: "Citera",
        description: "論文、PDF、メモをどの端末からでも整理できる個人向けライブラリ",
        theme_color: "#17211b",
        background_color: "#f4f0e8",
        display: "standalone",
        start_url: "/library",
        scope: "/",
        icons: [
          { src: "/favicon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/favicon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/favicon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        categories: ["education", "productivity"],
        shortcuts: [
          { name: "ライブラリ", short_name: "ライブラリ", url: "/library" },
          { name: "設定", short_name: "設定", url: "/settings" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,woff2,png,svg,ico,bcmap,ttf,pfb}"],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router"],
          "offline-vendor": ["dexie"],
          "markdown-vendor": ["dompurify", "marked"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
