import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "dist",
      emptyOutDir: false,
      rollupOptions: {
        input: { main: resolve(__dirname, "electron/main.ts") },
        output: { entryFileNames: "main.js" },
      },
    },
  },
  preload: {
    build: {
      outDir: "dist",
      emptyOutDir: false,
      rollupOptions: {
        input: { preload: resolve(__dirname, "electron/preload.ts") },
        output: { format: "cjs", entryFileNames: "preload.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "renderer"),
    plugins: [react()],
    base: "./",
    build: {
      outDir: resolve(__dirname, "dist", "renderer"),
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(__dirname, "renderer/index.html"),
      },
    },
  },
});
