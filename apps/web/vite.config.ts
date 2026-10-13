import { resolve } from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { buildInfo } from "./build-info.js";

export default defineConfig({
  plugins: [
    buildInfo(),
    VitePWA({
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{css,html,js,svg,webmanifest}"],
      },
      injectRegister: false,
      manifest: {
        background_color: "#1b1d1f",
        description: "A private offline-first scratchpad.",
        display: "standalone",
        icons: [
          {
            purpose: "any monochrome",
            sizes: "any",
            src: "/jotter.svg",
            type: "image/svg+xml",
          },
        ],
        name: "Jotter",
        scope: "/",
        share_target: {
          action: "/share",
          enctype: "application/x-www-form-urlencoded",
          method: "POST",
          params: { text: "text", title: "title", url: "url" },
        },
        short_name: "Jotter",
        start_url: "/",
        theme_color: "#1b1d1f",
      },
      srcDir: "src",
      strategies: "injectManifest",
    }),
  ],
  build: {
    outDir: resolve(import.meta.dirname, process.env.JOTTER_WEB_DIST ?? "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      },
    },
  },
});
