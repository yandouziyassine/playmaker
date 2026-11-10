import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fsDeps } from "./fsAnswers.ts";
import { handlePick } from "./handler.ts";

const root = path.resolve(process.env.PLAYMAKER_CONTENT ?? "content");
const pub = path.join(root, "public");
const deps = fsDeps(root);

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/pick") {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 2048) break; }
    const r = await handlePick(body, req.socket.remoteAddress ?? "", deps);
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/content/")) {
    const f = path.normalize(path.join(pub, url.pathname.slice("/content/".length)));
    if (!f.startsWith(pub + path.sep) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
    const day = /days[\\/](\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1];
    if (day && day > deps.today() && day > new Date(Date.parse(deps.today()) + 86400000).toISOString().slice(0, 10)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(f));
    return;
  }
  res.writeHead(404).end();
}).listen(8787, () => console.log(`dev API on http://localhost:8787 (content ${root})`));
