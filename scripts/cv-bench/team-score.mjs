// Team-label scoring of a clip run against the synthetic ground truth, matched in IMAGE space: each tracked box's feet
// (bottom centre) to the true feet projected with the true homography (gt.json H: pitch -> image px). The pitch-space
// matching of clip-run.mjs (5 m gate) pairs a detection with a neighbour of the other team whenever the calibration is a
// metre off, which reads as a team error; image matching scores the colour labels themselves.
//   node scripts/cv-bench/team-score.mjs report.json [--data scripts/cv-bench/clip-data]   (report.json: clip-run.mjs --out)
// Exported: teamScore(run, gt) for clip-run.mjs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const applyH = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };

/**
 * frameAcc: share of matched outfield-player boxes (role "player") labelled with their true team (after the best A/B
 * mapping; "other" counts as wrong); trackAcc: share of tracks (>= 3 matched frames, mostly an outfield player) whose most
 * shown label is that player's team; trackMix: share of track frames on a different true team than the track's main one
 * (tracker identity mixing); keeper / ref: label counts {other, own, opp}; others: "other" labels among all tracked boxes.
 */
export function teamScore(run, gt) {
  const rows = [];
  let boxes = 0, others = 0;
  run.frames.forEach((f, k) => {
    const g = gt.frames[Math.min(gt.frames.length - 1, Math.round(f.t * gt.fps))];
    if (f.status !== "ok" || g.view !== "wide") return;
    const seen = f.players.filter((p) => p.box && Number.isFinite(p.box.h));
    boxes += seen.length; others += seen.filter((p) => p.team === "other").length;
    const vis = g.players.filter((p) => p.inFrame > 0.5).map((p) => ({ ...p, img: applyH(g.H, p.pos[0], p.pos[1]) }));
    const cand = [];
    seen.forEach((s, i) => vis.forEach((v, j) => {
      const d = Math.hypot(s.box.x + s.box.w / 2 - v.img[0], s.box.y + s.box.h - v.img[1]);
      if (d <= Math.max(6, 0.35 * s.box.h)) cand.push({ i, j, d });
    }));
    cand.sort((a, b) => a.d - b.d);
    const ui = new Set(), uj = new Set();
    for (const c of cand) {
      if (ui.has(c.i) || uj.has(c.j)) continue;
      ui.add(c.i); uj.add(c.j);
      const s = seen[c.i], v = vis[c.j];
      rows.push({ k, id: s.id, label: s.team, gid: v.id, role: v.role, team: v.team });
    }
  });
  const pl = rows.filter((r) => r.role === "player");
  const direct = pl.filter((r) => r.label === r.team).length, swapped = pl.filter((r) => r.label !== "other" && r.label !== r.team).length;
  const map = direct >= swapped ? [0, 1] : [1, 0]; // true team -> our label
  const ok = (r) => r.label === map[r.team];
  const frameAcc = pl.filter(ok).length / pl.length;
  const byTrack = new Map();
  for (const r of rows) { if (!byTrack.has(r.id)) byTrack.set(r.id, []); byTrack.get(r.id).push(r); }
  let tN = 0, tOk = 0, mixed = 0, inTracks = 0;
  for (const rs of byTrack.values()) {
    if (rs.length < 3) continue;
    const gid = mode(rs.map((r) => r.gid)), main = rs.find((r) => r.gid === gid);
    const mainTeam = mode(rs.map((r) => r.team));
    mixed += rs.filter((r) => r.team !== mainTeam).length; inTracks += rs.length;
    if (main.role !== "player") continue;
    tN++;
    if (mode(rs.map((r) => String(r.label))) === String(map[main.team])) tOk++;
  }
  const roleCounts = (role) => {
    const rs = rows.filter((r) => r.role === role), c = { other: 0, own: 0, opp: 0 };
    for (const r of rs) c[r.label === "other" ? "other" : role !== "ref" && r.label === map[r.team] ? "own" : "opp"]++;
    return c;
  };
  return { matched: rows.length, players: pl.length, frameAcc, playersOther: pl.filter((r) => r.label === "other").length,
    tracks: tN, trackAcc: tN ? tOk / tN : NaN, trackMix: inTracks ? mixed / inTracks : NaN,
    keeper: roleCounts("keeper"), ref: roleCounts("ref"), others, boxes };
}

function mode(xs) {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best = xs[0], bn = -1;
  for (const [x, n] of c) if (n > bn) { best = x; bn = n; }
  return best;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const i = args.indexOf("--data");
  const gt = JSON.parse(readFileSync(join(i >= 0 ? args[i + 1] : join(here, "clip-data"), "gt.json"), "utf8"));
  const { run } = JSON.parse(readFileSync(args[0], "utf8"));
  console.log(JSON.stringify(teamScore(run, gt), null, 1));
}
