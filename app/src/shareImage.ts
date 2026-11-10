/** 1080x1350 share card (portrait, Instagram-friendly). Spoiler-free: score, squares and streak only, no player data. */
export const CARD_W = 1080, CARD_H = 1350;
const C = {
  bg0: "#12391f", bg1: "#07170e", fg: "#f1faee", muted: "#a9c2b3", attack: "#ef476f",
  top: "#06d6a0", mid: "#ffd166", low: "#8d99ae",
};
const DISPLAY = `"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif`;

/** Same thresholds as the emoji squares: green 100, yellow 50+, grey below. */
export const tileColor = (p: number) => (p >= 100 ? C.top : p >= 50 ? C.mid : C.low);

export interface Rect { x: number; y: number; w: number; h: number }
/** Score tiles centred horizontally, all on one row. */
export function tileLayout(n: number, y = 930, size = 148, gap = 26, width = CARD_W): Rect[] {
  if (n <= 0) return [];
  const s = Math.min(size, Math.floor((width - 120 - gap * (n - 1)) / n));
  const x0 = Math.round((width - (n * s + (n - 1) * gap)) / 2);
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * (s + gap), y, w: s, h: s }));
}

export const streakLabel = (n: number) => (n > 0 ? `STREAK ${n} DAY${n === 1 ? "" : "S"}` : "");
export const shareFileName = (day: number) => `playmaker-day-${day}.png`;

export interface CardData { dayNumber: number; points: number[]; streak: number; site?: string }

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number) {
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

/** Faint vertical pitch (attack up), as a texture behind the text. */
function pitch(ctx: CanvasRenderingContext2D) {
  const m = 90, x0 = m, x1 = CARD_W - m, y0 = 60, y1 = CARD_H - 96, w = x1 - x0, cx = CARD_W / 2, cy = (y0 + y1) / 2;
  ctx.save();
  for (let i = 0; i < 10; i++) { // mowing stripes
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.018)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(x0, y0 + ((y1 - y0) / 10) * i, w, (y1 - y0) / 10);
  }
  ctx.strokeStyle = "rgba(241,250,238,0.10)"; ctx.lineWidth = 4;
  ctx.strokeRect(x0, y0, w, y1 - y0);
  ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, w * 0.14, 0, Math.PI * 2); ctx.stroke();
  const box = (y: number, dir: 1 | -1) => {
    const bw = w * 0.6, bh = 170, sw = w * 0.28, sh = 60;
    ctx.strokeRect(cx - bw / 2, dir === 1 ? y : y - bh, bw, bh);
    ctx.strokeRect(cx - sw / 2, dir === 1 ? y : y - sh, sw, sh);
  };
  box(y0, 1); box(y1, -1);
  ctx.restore();
}

export function drawShareCard(ctx: CanvasRenderingContext2D, d: CardData) {
  const g = ctx.createRadialGradient(CARD_W / 2, 0, 50, CARD_W / 2, 200, CARD_H);
  g.addColorStop(0, C.bg0); g.addColorStop(0.65, C.bg1); g.addColorStop(1, C.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  pitch(ctx);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const cx = CARD_W / 2;

  // brand: PLAY + MAKER (red), as in the top bar
  ctx.font = `800 92px ${DISPLAY}`;
  const a = "PLAY", b = "MAKER", wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
  ctx.textAlign = "left";
  ctx.fillStyle = C.fg; ctx.fillText(a, cx - (wa + wb) / 2, 220);
  ctx.fillStyle = C.attack; ctx.fillText(b, cx - (wa + wb) / 2 + wa, 220);
  ctx.textAlign = "center";
  ctx.fillStyle = C.muted; ctx.font = `700 50px ${DISPLAY}`;
  ctx.fillText(`DAY #${d.dayNumber}`, cx, 310);

  // the score
  const total = d.points.reduce((x, y) => x + y, 0), max = d.points.length * 100;
  ctx.font = `800 330px ${DISPLAY}`;
  const ts = String(total), wt = ctx.measureText(ts).width;
  ctx.font = `800 96px ${DISPLAY}`;
  const ms = `/${max}`, wm = ctx.measureText(ms).width;
  const left = cx - (wt + wm + 12) / 2;
  ctx.textAlign = "left";
  ctx.fillStyle = C.fg; ctx.font = `800 330px ${DISPLAY}`; ctx.fillText(ts, left, 700);
  ctx.fillStyle = C.muted; ctx.font = `800 96px ${DISPLAY}`; ctx.fillText(ms, left + wt + 12, 700);
  ctx.textAlign = "center";
  ctx.font = `600 40px ${DISPLAY}`; ctx.fillStyle = C.muted;
  ctx.fillText("FIVE REAL MOMENTS · ONE PICK EACH", cx, 800);

  // the five tiles
  tileLayout(d.points.length).forEach((r, i) => {
    ctx.fillStyle = tileColor(d.points[i]!); roundRect(ctx, r, 26); ctx.fill();
  });

  const st = streakLabel(d.streak);
  if (st) {
    ctx.font = `800 56px ${DISPLAY}`;
    const w = ctx.measureText(st).width + 90, r: Rect = { x: cx - w / 2, y: 1120, w, h: 84 };
    ctx.fillStyle = "rgba(239,71,111,0.16)"; roundRect(ctx, r, 42); ctx.fill();
    ctx.fillStyle = C.attack; ctx.fillText(st, cx, 1181);
  }
  if (d.site) { ctx.font = `600 36px ${DISPLAY}`; ctx.fillStyle = C.muted; ctx.fillText(d.site, cx, 1318); }
}

/** Renders the card on an offscreen canvas and returns it as a PNG file (null if the browser cannot). */
export async function shareCardFile(d: CardData): Promise<File | null> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W; canvas.height = CARD_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try { await document.fonts?.ready; } catch { /* no font loading API */ }
    drawShareCard(ctx, d);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return blob ? new File([blob], shareFileName(d.dayNumber), { type: "image/png" }) : null;
  } catch { return null; }
}

export interface ShareNav {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText(t: string): Promise<void> };
}
/** Image + text through the share sheet when files are supported, else text share, else clipboard. */
export async function shareScore(nav: ShareNav, text: string, file: File | null): Promise<"image" | "text" | "copied" | "none"> {
  let canFiles = false;
  try { canFiles = !!file && !!nav.share && !!nav.canShare?.({ files: [file] }); } catch { canFiles = false; }
  if (canFiles) { await nav.share!({ files: [file!], text }); return "image"; }
  if (nav.share) { await nav.share({ text }); return "text"; }
  if (nav.clipboard) { await nav.clipboard.writeText(text); return "copied"; }
  return "none";
}
