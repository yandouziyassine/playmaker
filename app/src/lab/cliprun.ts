// Video clip mode, the browser loop: seeks through a local video file at CLIP.fps, runs the VIDEO-mode detector on each
// frame (720p processing size), keeps the homography with autocal.ts (full search on the first frame and after a cut or a
// poor fit, seeded refinement every CLIP.refineEvery frames) and tracks players and the ball with live.ts / ball.ts.
// Nothing leaves the device: the file is read through an object URL. Pure parts: clip.ts.
import { invert3, orientH, type Mat3 } from "./homography.ts";
import { detectVideoFrame, loadDetector, loadVideoDetector } from "./detector.ts";
import { feet, toPitch } from "./players.ts";
import { meanColour, splitTeams, torsoBox, type RGB, type TeamLabel } from "./teams.ts";
import { assignTeam, fixCentroids, stepTracks, trackVelocity, watchResidual, START_WATCH, type CalWatch, type Centroids, type Track } from "./live.ts";
import { ballGround, pickBall, stepBall, trackBox, type BallTrack } from "./ball.ts";
import { fitQuality, LINE_SIDE, scanLines } from "./lines.ts";
import { pitchLines } from "./landmarks.ts";
import { autoCalibrate, pickFour, refineCalibration, residualOf, type AutoCal } from "./autocal.ts";
import { CLIP, classifyFrame, frameTimes, processingSize, type ClipFrame, type ClipPlayer, type Signature, signature } from "./clip.ts";

export type ClipRun = {
  frames: ClipFrame[]; w: number; h: number; fps: number; duration: number; capped: boolean;
  teamRgb: RGB[]; separation: number; totalMs: number; cancelled: boolean;
};
export type ClipProgress = { done: number; total: number; frame: ClipFrame | null };

/** Seeks the video and waits for the frame (seeked event; a stuck seek gives up after 4 s). */
export function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) { resolve(); return; }
    const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
    const timer = setTimeout(done, 4000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

const POLY = pitchLines();

/** Analyses the clip already loaded in `video` (metadata ready). Cancelling keeps the frames analysed so far. */
export async function analyseClip(video: HTMLVideoElement, opts: { tiled: boolean; signal?: AbortSignal; onProgress?: (p: ClipProgress) => void; fps?: number }): Promise<ClipRun> {
  const fps = opts.fps ?? CLIP.fps;
  await loadVideoDetector();
  if (opts.tiled) await loadDetector();
  const size = processingSize(video.videoWidth, video.videoHeight);
  const work = document.createElement("canvas");
  work.width = size.w; work.height = size.h;
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  const lineCanvas = document.createElement("canvas");
  const lk = Math.min(1, LINE_SIDE / Math.max(size.w, size.h));
  lineCanvas.width = Math.round(size.w * lk); lineCanvas.height = Math.round(size.h * lk);
  const lctx = lineCanvas.getContext("2d", { willReadFrequently: true })!;
  const times = frameTimes(video.duration, fps);
  const frames: ClipFrame[] = [];
  const t00 = performance.now();

  let prevSig: Signature | null = null;
  let H: Mat3 | null = null, sol: AutoCal | null = null, cal4: ClipFrame["cal"] = null;
  let needFull = true, sinceRefine = 0, lastOkT = -Infinity;
  let watch: CalWatch = START_WATCH;
  let tracks: Track[] = [], nextId = 1, cents: Centroids | null = null, ball: BallTrack | null = null;
  let teamRgb: RGB[] = [[230, 230, 230], [40, 40, 40]], separation = 0;
  const resetTracks = () => { tracks = []; ball = null; };

  for (let i = 0; i < times.length; i++) {
    if (opts.signal?.aborted) break;
    const t = times[i]!;
    await seekTo(video, t);
    if (opts.signal?.aborted) break;
    const f0 = performance.now();
    wctx.drawImage(video, 0, 0, size.w, size.h);
    const data = wctx.getImageData(0, 0, size.w, size.h);
    const sig = signature(data, 6);
    const kind = classifyFrame(prevSig, sig);
    prevSig = sig;
    const frame: ClipFrame = { t, status: "ok", cut: kind === "cut", rating: null, fit: null, players: [], ball: null, ballBox: null, ballScore: 0, cal: null, ms: 0 };
    if (kind !== "same" || i === 0) { resetTracks(); needFull = true; watch = START_WATCH; }
    if (kind === "noPitch") {
      frame.status = "noPitch"; frame.ms = performance.now() - f0;
      frames.push(frame); opts.onProgress?.({ done: i + 1, total: times.length, frame });
      continue;
    }
    const run = await detectVideoFrame(work, opts.tiled);
    // painted lines (players masked out) on a <= 640 px copy
    lctx.drawImage(work, 0, 0, lineCanvas.width, lineCanvas.height);
    const scan = scanLines(lctx.getImageData(0, 0, lineCanvas.width, lineCanvas.height), lk,
      run.persons.map((p) => ({ x: p.box.x * lk, y: p.box.y * lk, w: p.box.w * lk, h: p.box.h * lk })));
    // calibration upkeep: residual watch on the current homography; full search when needed, else a periodic refinement
    if (H && !needFull) {
      watch = watchResidual(watch, residualOf(scan, H));
      if (watch.moved) needFull = true;
      else if (++sinceRefine >= CLIP.refineEvery) {
        sinceRefine = 0;
        const r = refineCalibration(scan, H);
        if (r && r.rating !== "poor") { H = r.H; sol = r; cal4 = pickFour(r, size.w, size.h) ?? cal4; }
      }
    }
    if (needFull) {
      const res = autoCalibrate(scan);
      if (res.best && res.best.rating !== "poor") {
        H = res.best.H; sol = res.best; cal4 = pickFour(res.best, size.w, size.h); needFull = false; sinceRefine = 0;
        watch = watchResidual(START_WATCH, residualOf(scan, H)); // same shot: the tracks carry on (pitch coordinates)
      } else { H = null; sol = null; cal4 = null; }
    }
    const q = H ? fitQuality(scan, H, POLY) : null;
    frame.rating = q?.rating ?? (H ? sol?.rating ?? null : null);
    frame.fit = q?.mean ?? null;
    const i2pRaw = H ? invert3(H) : null;
    if (!H || !i2pRaw || !cal4 || frame.rating === "poor") {
      // no usable calibration: tracking pauses and the next frame searches again
      frame.status = "poorCal"; needFull = true; // tracks wait (up to TRACK.maxDt), then restart
      frame.ms = performance.now() - f0;
      frames.push(frame); opts.onProgress?.({ done: i + 1, total: times.length, frame });
      continue;
    }
    const c4 = { x: cal4.pts.reduce((a, p) => a + p.x, 0) / 4, y: cal4.pts.reduce((a, p) => a + p.y, 0) / 4 };
    const i2p = orientH(i2pRaw, c4);
    frame.cal = cal4;
    // teams: centroids fixed on the first calibrated frame with enough players, so labels do not flip
    const colours = run.persons.map((p) => meanColour(data, torsoBox(p.box)));
    if (!cents) {
      cents = fixCentroids(colours.filter((c): c is RGB => !!c));
      if (cents) { teamRgb = cents.rgb.slice(0, 2); separation = cents.separation; }
    }
    let labels: TeamLabel[];
    if (cents) labels = colours.map((c) => (c ? assignTeam(c, cents!) : "other"));
    else {
      const valid = colours.map((c, k) => ({ c, k })).filter((x): x is { c: RGB; k: number } => !!x.c);
      const split = splitTeams(valid.map((v) => v.c));
      labels = colours.map(() => "other");
      valid.forEach((v, k) => { labels[v.k] = split.labels[k]!; });
    }
    const raw = run.persons.map((p) => toPitch(i2p, feet(p.box)));
    const idx = raw.map((p, k) => (p ? k : -1)).filter((k) => k >= 0);
    if (t - lastOkT > CLIP.maxGap) resetTracks(); // a long pause: velocities and identities are stale
    const dt = Number.isFinite(lastOkT) ? t - lastOkT : 1 / fps;
    lastOkT = t;
    const res = stepTracks(tracks, idx.map((k) => ({ p: raw[k]!, team: labels[k]! })), dt, nextId);
    tracks = res.tracks; nextId = res.nextId;
    const players: ClipPlayer[] = idx.map((k, j) => { const tr = res.byDet[j]!; return { id: tr.id, team: tr.team, p: tr.p, v: trackVelocity(tr), box: run.persons[k]!.box }; });
    for (const tr of tracks) if (tr.misses > 0) players.push({ id: tr.id, team: tr.team, p: tr.p, v: trackVelocity(tr), box: null });
    frame.players = players.sort((a, b) => a.id - b.id);
    // the ball: best candidate (crowd filter), smoothed in image px, mapped to the ground under it
    ball = stepBall(ball, pickBall(run.balls, run.persons, i2p, size.w), dt, size.w);
    if (ball && (ball.hits >= 2 || ball.misses === 0)) {
      const box = trackBox(ball);
      frame.ballBox = box; frame.ballScore = ball.score;
      frame.ball = toPitch(i2p, ballGround(box));
    }
    frame.ms = performance.now() - f0;
    frames.push(frame);
    opts.onProgress?.({ done: i + 1, total: times.length, frame });
  }
  return {
    frames, w: size.w, h: size.h, fps, duration: video.duration, capped: video.duration > CLIP.maxSec,
    teamRgb, separation, totalMs: performance.now() - t00, cancelled: !!opts.signal?.aborted,
  };
}

