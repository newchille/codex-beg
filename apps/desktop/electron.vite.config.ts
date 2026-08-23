import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: { build: { rollupOptions: { input: "electron/main.ts" } } },
  preload: {
    build: {
      rollupOptions: {
        input: "electron/preload.ts",
        output: { format: "cjs", entryFileNames: "preload.cjs" },
      },
    },
  },
  renderer: {
    root: "renderer",
    plugins: [react()],
    base: "./",
    build: { outDir: "../dist", emptyOutDir: false },
  },
});
