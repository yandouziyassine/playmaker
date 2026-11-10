import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 600 }, // the lazy three.js 3D chunk is ~540 kB (137 kB gzip)
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/content": "http://localhost:8787" } },
});
