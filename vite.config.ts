import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/content": "http://localhost:8787" } },
});
