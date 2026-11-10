import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";
import { swPlugin } from "./app/src/offline/vitePlugin.ts";

// `npm run dev:phone`: HTTPS with a local self-signed certificate on the LAN, so a phone on the same Wi-Fi can open the
// game and the Lab's live camera (browsers only allow getUserMedia in a secure context).
export default defineConfig(({ mode }) => ({
  root: "app",
  plugins: [...(mode === "phone" ? [basicSsl()] : []), swPlugin()], // swPlugin: /sw.js, build only (offline play)
  build: {
    outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 600, // the lazy three.js 3D chunk is ~540 kB (137 kB gzip)
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("app/index.html", import.meta.url)),
        lab: fileURLToPath(new URL("app/lab.html", import.meta.url)), // computer-vision lab (lazy MediaPipe detector)
        replay: fileURLToPath(new URL("app/replay.html", import.meta.url)), // free play: a full match with the coach
        about: fileURLToPath(new URL("app/about.html", import.meta.url)), // shares the design tokens, so it is built too
      },
    },
  },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/content": "http://localhost:8787" } },
}));
