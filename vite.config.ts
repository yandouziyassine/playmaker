import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  build: {
    outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 600, // the lazy three.js 3D chunk is ~540 kB (137 kB gzip)
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("app/index.html", import.meta.url)),
        lab: fileURLToPath(new URL("app/lab.html", import.meta.url)), // computer-vision lab (lazy MediaPipe detector)
      },
    },
  },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/content": "http://localhost:8787" } },
});
