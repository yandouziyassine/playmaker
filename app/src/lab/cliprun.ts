// Video clip mode, the browser loop: seeks through a local video file at CLIP.fps, runs the VIDEO-mode detector on each
// frame (720p processing size; adaptive tiling: the full tiled scan every CLIP.fullScanEvery frames, the tiles around
// predicted players it would miss in between), keeps the homography with autocal.ts (full search on the first frame and
// after a cut or a poor fit, then the centre circle, then the previous homography moved by the camera motion; seeded
// refinement in between) and tracks players with ktrack.ts (Kalman + Hungarian + colour, re-identification after a pause
// or a cut) and the ball with ball.ts. Nothing leaves the device: the file is read through an object URL. Pure parts:
// clip.ts, ktrack.ts.
import { applyH, invert3, orientH, type Mat3, type Pt } from "./homography.ts";
import { detectVideoFrame, detectVideoFrameFocus, loadDetector, loadVideoDetector, type DetectRun } from "./detector.ts";
import { feet, toPitch } from "./players.ts";
import { classifyFeat, fitTeamModel, grassModel, labelClip, labToRgb, torsoFeature, type ClipDet, type ColourFeat, type RGB, type TeamLabel, type TeamModel } from "./teams.ts";
import { stepTracks, trackVelocity, watchResidual, START_WATCH, type CalWatch, type Track } from "./live.ts";
import { focusTiles, fullScanDue, kStep, newTracker, suspend, trackPos, uncovered, velOf, type KTracker } from "./ktrack.ts";
import { ballGround, pickBall, stepBall, trackBox, type BallTrack } from "./ball.ts";
import { fitQuality, LINE_SIDE, scanLines } from "./lines.ts";
import { pitchLines } from "./landmarks.ts";
import { autoCalibrate, centreCircleCalibrate, pickFour, polishCalibration, propagateCalibration, refineCalibration, residualOf, type AutoCal } from "./autocal.ts";
import { CLIP, classifyFrame, frameTimes, processingSize, type ClipFrame, type ClipPlayer, type Signature, signature } from "./clip.ts";

export type ClipRun = {
  frames: ClipFrame[]; w: number; h: number; fps: number; duration: number; capped: boolean;
  teamRgb: RGB[]; separation: number; totalMs: number; cancelled: boolean;
  /** team model: refits after cuts; detections labelled "other" (keepers, referees, bad crops) after the final vote. */
  teamRefits: number; otherDets: number;
};
export type ClipProgress = { done: number; total: number; frame: ClipFrame | null };

/**
 * Switches of the loop (the benchmark compares them; the app uses the defaults): tracker "kalman" (ktrack.ts) or "nn"
 * (the live mode's nearest neighbour); fullScanEvery: adaptive tiling period (1 = the full tiled scan on every frame);
 * motion / circle / polish: the calibration additions; dump: keep each frame's raw detections (benchmark replay).
 */
export type ClipLoopOpts = { tracker: "kalman" | "nn"; fullScanEvery: number; motion: boolean; circle: boolean; polish: boolean; dump?: boolean };
export const CLIP_LOOP: ClipLoopOpts = { tracker: "kalman", fullScanEvery: CLIP.fullScanEvery, motion: true, circle: true, polish: true };

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
export async function analyseClip(video: HTMLVideoElement, opts: { tiled: boolean; signal?: AbortSignal; onProgress?: (p: ClipProgress) => void; fps?: number; loop?: Partial<ClipLoopOpts> }): Promise<ClipRun> {
  const fps = opts.fps ?? CLIP.fps;
  const lo: ClipLoopOpts = { ...CLIP_LOOP, ...((globalThis as { __clipLoop?: Partial<ClipLoopOpts> }).__clipLoop ?? {}), ...(opts.loop ?? {}) };
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
  let tracks: Track[] = [], nextId = 1, prov: TeamModel | null = null, ball: BallTrack | null = null;
  // every tracked detection's torso feature, for the final clip-wide team labelling (labelClip)
  const cdets: ClipDet[] = [], cplayers: ClipPlayer[] = [];
  let seg = 0;
  let kt: KTracker = newTracker();
  let teamRgb: RGB[] = [[230, 230, 230], [40, 40, 40]], separation = 0;
  let sinceFull = Infinity, lastGood: Mat3 | null = null;
  // a cut or a pause: motion is stale; the Kalman tracker keeps the identities aside for re-identification
  const resetTracks = () => { tracks = []; ball = null; kt = suspend(kt); sinceFull = Infinity; };

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
    // the previous homography of the same shot, for the motion propagation
    if (kind !== "same" || i === 0) { resetTracks(); needFull = true; watch = START_WATCH; lastGood = null; if (i > 0) seg++; }
    const Hprev: Mat3 | null = lastGood;
    if (kind === "noPitch") {
      frame.status = "noPitch"; frame.ms = performance.now() - f0; H = null;
      frames.push(frame); opts.onProgress?.({ done: i + 1, total: times.length, frame });
      continue;
    }
    // detection: the full tiled scan, or (adaptive tiling) the full-frame pass + the tiles around predicted players it missed
    let run: DetectRun;
    const full = !opts.tiled || fullScanDue(sinceFull, lo.fullScanEvery, !Hprev || kt.tracks.length === 0);
    if (full) { run = await detectVideoFrame(work, opts.tiled); sinceFull = 1; } else {
      const Hp = Hprev!; // not forced: a previous homography of this shot exists
      const preds: Pt[] = [];
      for (const tr of kt.tracks) { const q = applyH(Hp, trackPos(tr)); if (q) preds.push({ x: q.x, y: q.y - 0.02 * size.h }); }
      run = await detectVideoFrameFocus(work, (plan, persons) => focusTiles(plan, uncovered(preds, persons.map((p) => p.box))));
      sinceFull++;
    }
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
    const adopt = (c: AutoCal) => {
      H = c.H; sol = c; cal4 = pickFour(c, size.w, size.h); needFull = false; sinceRefine = 0;
      watch = watchResidual(START_WATCH, residualOf(scan, c.H)); // same shot: the tracks carry on (pitch coordinates)
    };
    if (needFull) {
      const res = autoCalibrate(scan);
      if (res.best && res.best.rating !== "poor") adopt(lo.polish ? polishCalibration(scan, res.best) : res.best);
      else { H = null; sol = null; cal4 = null; }
    }
    let q = H ? fitQuality(scan, H, POLY) : null;
    if (!H || !q || q.rating === "poor") {
      // midfield view: the centre circle; else the previous homography moved by the camera motion (same shot)
      const c = (lo.circle ? centreCircleCalibrate(scan) : null) ?? (lo.motion && Hprev ? propagateCalibration(scan, Hprev) : null);
      if (c) { adopt(c); q = fitQuality(scan, c.H, POLY); }
    }
    frame.rating = q?.rating ?? (H ? sol?.rating ?? null : null);
    frame.fit = q?.mean ?? null;
    const i2pRaw = H ? invert3(H) : null;
    if (!H || !i2pRaw || !cal4 || frame.rating === "poor") {
      // no usable calibration: tracking pauses and the next frame searches again
      frame.status = "poorCal"; needFull = true; H = null; // tracks wait (up to CLIP.maxGap), then restart
      frame.ms = performance.now() - f0;
      frames.push(frame); opts.onProgress?.({ done: i + 1, total: times.length, frame });
      continue;
    }
    lastGood = H;
    const c4 = { x: cal4.pts.reduce((a, p) => a + p.x, 0) / 4, y: cal4.pts.reduce((a, p) => a + p.y, 0) / 4 };
    const i2p = orientH(i2pRaw, c4);
    frame.cal = cal4;
    // teams: grass-masked torso features (grass range of this frame); provisional labels for the tracker from a model
    // fitted on the first calibrated frame with enough players; the final labels come from labelClip after the loop
    const grass = grassModel(data);
    const feats: (ColourFeat | null)[] = run.persons.map((p) => torsoFeature(data, p.box, grass));
    if (!prov) {
      prov = fitTeamModel(feats.filter((c): c is ColourFeat => !!c));
      if (prov) { teamRgb = prov.centres.map(labToRgb); separation = prov.separation; }
    }
    const labels: TeamLabel[] = feats.map((c) => (c && prov ? classifyFeat(c, prov).team : "other"));
    const raw = run.persons.map((p) => toPitch(i2p, feet(p.box)));
    const idx = raw.map((p, k) => (p ? k : -1)).filter((k) => k >= 0);
    if (t - lastOkT > CLIP.maxGap) resetTracks(); // a long pause: velocities are stale (identities wait for re-identification)
    const dt = Number.isFinite(lastOkT) ? t - lastOkT : 1 / fps;
    lastOkT = t;
    const dumped = lo.dump ? idx.map((k) => ({ p: raw[k], team: labels[k], lab: feats[k]?.lab ?? null, feat: feats[k], box: run.persons[k]!.box, id: 0 })) : null;
    if (dumped) (frame as ClipFrame & { dets?: unknown }).dets = dumped;
    let players: ClipPlayer[];
    if (lo.tracker === "kalman") {
      const res = kStep(kt, idx.map((k) => ({ p: raw[k]!, team: labels[k]!, lab: feats[k]?.lab ?? null })), t);
      kt = res.tracker;
      players = idx.map((k, j) => { const tr = res.byDet[j]!; return { id: tr.id, team: tr.team, p: trackPos(tr), v: velOf(tr), box: run.persons[k]!.box }; });
      for (const tr of kt.tracks) if (tr.misses > 0) players.push({ id: tr.id, team: tr.team, p: trackPos(tr), v: velOf(tr), box: null });
    } else {
      const res = stepTracks(tracks, idx.map((k) => ({ p: raw[k]!, team: labels[k]! })), dt, nextId);
      tracks = res.tracks; nextId = res.nextId;
      players = idx.map((k, j) => { const tr = res.byDet[j]!; return { id: tr.id, team: tr.team, p: tr.p, v: trackVelocity(tr), box: run.persons[k]!.box }; });
      for (const tr of tracks) if (tr.misses > 0) players.push({ id: tr.id, team: tr.team, p: tr.p, v: trackVelocity(tr), box: null });
    }
    idx.forEach((k, j) => {
      const feat = feats[k], id = players[j]!.id;
      if (dumped) dumped[j]!.id = id;
      if (feat) { cdets.push({ id, seg, frame: i, feat, x: raw[k]!.x, good: frame.rating === "good" }); cplayers.push(players[j]!); }
    });
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
  // final team labels: one model for the clip (best frames), nearest centroid per detection, weighted vote per track (a
  // detection that is clearly something else than its track keeps its own label)
  const lab = labelClip(cdets);
  if (lab.model) {
    teamRgb = lab.model.centres.map(labToRgb); separation = lab.model.separation;
    for (const f of frames) for (const p of f.players) p.team = lab.byTrack.get(p.id) ?? p.team;
    cplayers.forEach((p, k) => { p.team = lab.final[k]!; });
  }
  const otherDets = frames.reduce((a, f) => a + f.players.filter((p) => p.box && p.team === "other").length, 0);
  return {
    teamRefits: lab.refits, otherDets,
    frames, w: size.w, h: size.h, fps, duration: video.duration, capped: video.duration > CLIP.maxSec,
    teamRgb, separation, totalMs: performance.now() - t00, cancelled: !!opts.signal?.aborted,
  };
}
