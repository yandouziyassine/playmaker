import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig, type Plugin } from "vite";
import { swPlugin } from "./app/src/offline/vitePlugin.ts";

/** Static demo build only (VITE_DEMO=1): the game page fetches demo.json, then the demo chunk maps today onto the demo's
 *  days, then the day file, then its first moment, one round trip after the other. This puts all of them on the first
 *  round trip: a preload for demo.json and a modulepreload for the demo chunk, plus a tiny inline script that does the
 *  same date mapping as app/src/demo.ts (with demo.json baked in at build time) and preloads the day file and its first
 *  moment (relative URLs, so it works under any base path). A wrong guess only wastes a preload. */
function demoPreload(): Plugin {
  let base = "/";
  return {
    name: "playmaker-demo-preload",
    apply: "build",
    configResolved(c) { base = c.base; },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (process.env.VITE_DEMO !== "1" || path.basename(ctx.filename) !== "index.html") return html;
        const dir = "demo/content";
        if (!fs.existsSync(`${dir}/demo.json`)) return html;
        const info = JSON.parse(fs.readFileSync(`${dir}/demo.json`, "utf8")) as { start: string; days: number };
        const first: Record<string, string> = {};
        for (const f of fs.readdirSync(`${dir}/days`)) {
          if (!/^\d{4}-\d\d-\d\d\.json$/.test(f)) continue;
          const d = JSON.parse(fs.readFileSync(`${dir}/days/${f}`, "utf8")) as { moments?: string[] };
          if (d.moments?.[0]) first[f.slice(0, 10)] = d.moments[0];
        }
        const chunk = Object.values(ctx.bundle ?? {}).find((c) => c.type === "chunk" && c.facadeModuleId?.endsWith("/src/demo.ts"));
        const script = `(function(){try{var I=${JSON.stringify(info)},M=${JSON.stringify(first)},q=new URLSearchParams(location.search),d=q.get("date"),t=q.get("today");` +
          `if(!t){var n=new Date(),p=function(x){return String(x).padStart(2,"0")},u=function(s){return Date.parse(s+"T00:00:00Z")};` +
          `t=n.getFullYear()+"-"+p(n.getMonth()+1)+"-"+p(n.getDate());var k=Math.max(1,I.days),o=Math.floor((u(t)-u(I.start))/864e5);` +
          `t=new Date(u(I.start)+(((o%k)+k)%k)*864e5).toISOString().slice(0,10)}d=d||t;` +
          `var a=function(h){var l=document.createElement("link");l.rel="preload";l.as="fetch";l.crossOrigin="anonymous";l.href=h;document.head.appendChild(l)};` +
          `a("content/days/"+d+".json");if(M[d])a("content/moments/"+M[d]+".json")}catch(e){}})()`;
        const tags = [
          '<link rel="preload" href="content/demo.json" as="fetch" crossorigin />',
          ...(chunk ? [`<link rel="modulepreload" crossorigin href="${base}${chunk.fileName}" />`] : []),
          `<script>${script}</script>`,
        ].join("\n  ");
        return html.replace("</head>", `  ${tags}\n</head>`);
      },
    },
  };
}

// `npm run dev:phone`: HTTPS with a local self-signed certificate on the LAN, so a phone on the same Wi-Fi can open the
// game and the Lab's live camera (browsers only allow getUserMedia in a secure context).
const API = `http://localhost:${process.env.PLAYMAKER_API_PORT ?? 8787}`;

export default defineConfig(({ mode }) => ({
  root: "app",
  plugins: [...(mode === "phone" ? [basicSsl()] : []), swPlugin(), demoPreload()], // swPlugin: /sw.js, build only (offline play)
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
  // PLAYMAKER_API_PORT: the dev API on another port (several checkouts side by side; api/src/dev.ts reads it too)
  server: { port: 5173, proxy: { "/api": API, "/content": API } },
}));
