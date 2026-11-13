# Playmaker architecture

Playmaker is a daily football decision game. Each day has five frozen moments from real professional matches. For
each moment the player answers two questions: what should the ball carrier do (scored by an AI coach) and what did
the professional actually do (scored against the real pass). This document describes how the system is built, how
one round flows through it, and what is planned but not yet running.

Status (2026-11-12): runs locally (game, API, content). A **static demo** is live at
https://yandouziyassine.github.io/playmaker/ (section 9.4: it trades the server-side answers for static hosting). The
AWS deployment in section 12 is **planned, not deployed**.

Related sources:
- Design spec: `COMPUTER-VISION-PROJECT-LIBRARY/docs/superpowers/specs/2026-11-09-playmaker-fan-game-design.md`
- AI coach, content builder and audits: `COMPUTER-VISION-PROJECT-LIBRARY/20-football-analytics` (`coach/`,
  `coach/game/`, `docs/playmaker_content_eval.json`, `docs/coach_model_lab.md`)

## 1. System overview

```
 OFFLINE (Python library, 20-football-analytics)
 ┌──────────────────────────────────────────────────────────────┐
 │ open tracking + events (27 matches: 7 DFL Bundesliga /       │
 │ 2. Bundesliga, 20 SkillCorner A-League)                      │
 │   -> event/tracking sync -> candidate pass decisions          │
 │   -> coach scores, models held out per match                  │
 │   -> 20 bootstrap refits (close calls) -> points              │
 │   -> quality filters, anti-exploit filter, zone-stratified    │
 │      pool, daily sets                                          │
 │   -> schema validation + "no answers in public files" check   │
 └───────────────────────────────┬──────────────────────────────┘
                                 │  python -m coach.game.build
                                 v
 VERSIONED CONTENT RELEASE  content-v1/   (release.json: 117 days, 585 moments)
 ┌──────────────────────────────┬───────────────────────────────┐
 │ public/  days/<date>.json    │ answers/<moment>.json         │
 │          days/index.json     │   points, scores, share_top,  │
 │          moments/<id>.json   │   reasons, ai_pick, pro_pick, │
 │          sample.json         │   outcome, 6 s "after" replay │
 │  (positions, options only)   │  (server-side only)           │
 └──────────────┬───────────────┴───────────────┬───────────────┘
                │ GET /content/*                │ read by the API
                v                               v
 ┌──────────────────────────────┐   ┌────────────────────────────────┐
 │ STATIC APP (Vite + TS)       │   │ PICK API  POST /api/pick       │
 │ index: daily game (2D/3D)    │──>│ validate, first answer wins,   │
 │ replay: free play, 1 match   │<──│ rate limit (salted hash),      │
 │ lab: TV picture -> tactics   │   │ crowd split from 20 picks      │
 │ about                        │   │ returns the reveal             │
 │ history in localStorage      │   └────────────────────────────────┘
 └──────────────┬───────────────┘
                │ Lab only, all in the browser
                v
 ┌──────────────────────────────────────────────────────────────┐
 │ MediaPipe EfficientDet-Lite0 / Lite2 (local .tflite, wasm)   │
 │ -> persons + ball -> teams (k-means) -> pitch lines          │
 │ -> automatic calibration (or 4 taps)                         │
 │ -> DLT homography -> top-down map -> same coach engine (TS)  │
 └──────────────────────────────────────────────────────────────┘
```

Three properties drive the design:

1. **No model runs on the server.** The Python models score every option offline. The API only looks up
   precomputed answers. One content version is one source of truth; a model change ships as a new version and
   published days never change.
2. **Answers never reach the browser before the pick.** Public moment files carry positions, players and options
   only (section 3).
3. **The server is tiny.** One endpoint, one store interface (`api/src/types.ts: Store`) with five methods. Locally
   it is an in-memory map; on AWS it is planned as one DynamoDB table.

## 2. Data flow of one round

```
 browser                                   dev server / API                     content
 ───────                                   ────────────────                     ───────
 GET /content/days/index.json  ─────────>  static file                  <────  public/days/
 GET /content/days/<local date>.json ───>  404 if date > UTC today + 1  <────  public/days/
 for each of the 5 moments:
   GET /content/moments/<id>.json ──────>  static file (no answers)     <────  public/moments/
   animate ~3 s of lead-up, then
   Q1 "What would you do?"  -> option k (pass to a teammate, carry, shot)
   Q2 "What did the pro do?" -> guess g (pass options only)
   POST /api/pick {player, moment, option, guess} ─>  handlePick()      <────  answers/<id>.json
   <── {points, among_best, pro_instinct, ai_pick, pro_pick, outcome,
        reasons, all_points, crowd | null, after, guess, guess_right, repeat}
   reveal: points, AI pick + reasons, pro pick, outcome in 15 s, crowd split,
   every option's points on the pitch, replay of the real 6 s after the pass
   record the moment in localStorage (points, zone, pick kind, guess_right)
 after moment 5: recap, streak (live days only), stats, 1080 x 1350 share card
```

- The player id is a random UUID v4 created in the browser (`crypto.randomUUID()`) and kept in localStorage. There
  is no account, email, name or cookie. If storage is blocked, history falls back to memory for the session.
- The client asks for the day of its **local** date. The server accepts any day up to **UTC today + 1**, so every
  time zone gets its own "today" without exposing days further ahead.
- The first moment of the day is fetched while the intro is shown (`getMoment` is memoised).

## 3. Why answers stay server-side

Anything shipped to the browser can be read in the network tab. If the moment file contained the scores or the pro's
pass, the game would be solved by anyone who opens developer tools, and the crowd statistics would mean nothing.
So the content builder splits every moment in two:

| File | Contains | Served |
|---|---|---|
| `public/moments/<id>.json` | league, teams, minute, scoreline, players, lead-up positions, ball, options `{k, kind, player?, angle?, to}`, credit line | yes, `GET /content/moments/<id>.json` |
| `answers/<id>.json` | per option `score, p, share_top, points, reasons`; `ai_pick`, `pro_pick`, `outcome {kind, net_xg_15s}`, 6 s `after` replay, `models {content_version, trained_without, refits}` | never; read only by the API |

Checks that enforce this:
- Library: `python -m coach.game.build --validate` (schemas + no answer fields in public files).
- `tests/contract.test.ts`: fixture content validated against the release JSON Schemas with ajv.
- e2e `public content never exposes answers`: `/content/../answers/x.json` returns 404 and a served moment contains
  none of `points`, `pro_pick`, `share_top`, `reasons`, `after`.
- The dev server normalises paths and refuses anything outside `public/`.

## 4. The coach engine

The coach ranks what the ball carrier can do in one tracking frame: a pass to each teammate, a carry in five
directions, or a shot. Everything is expressed in expected goals (xG).

| Part | Model | Notes |
|---|---|---|
| Pitch control | closed form | reaction 0.7 s, max speed 5 m/s, logistic on the arrival-time gap (sigma 0.45 s) |
| Pass success p | logistic regression, 9 features | distance, direction, lane defenders, receiver space, passer pressure, target control, target position |
| Possession value V | ridge regression | expected net xG in the next 15 s at a ball position |
| Arrival value | ridge regression, same basis | value of a pass target if the pass arrives (the cut-back fix); pass options only |
| Shot | logistic regression | the provider's xG is used where it exists |
| Advice | formula | `score = p * V(target) - (1 - p) * V_opp(loss point) - V(now)`; a shot scores `xG - V(now)` |

Linear models were kept on purpose: the browser runs the exact same formulas. The weights are exported by the library
(`coach/export.py`) to `app/public/coach/models.json` (StandardScaler + coefficients). `app/src/coach/` is a
TypeScript port of the features, pitch control, advice and explanations (exact logistic contributions turned into
"helps / hurts" phrases).

**Parity.** `app/test/coach-parity.test.ts` loads a fixture written by the library's `coach/parity_fixtures.py` on 30
real tracking frames from both halves of one Bundesliga match (J03WOH, models trained without it). For every frame it
checks pass, value and shot features, p, value, score, loss value and target point within **1e-6**, the option
ranking exactly, explanation contributions within 1e-9, and the phrase table and phrases (except options flagged as
fragile, with at least 90 % compared by text). It also checks that the shipped `models.json` equals the fixture's
models, so a weight update without a new fixture fails the test. In the library, the fast content scorer equals the
reference `advice.options` within 1e-12 (`tests/test_20_game.py`).

The same engine runs in three places: the free-play replay (one full Bundesliga match, "ask the coach" on the ball
carrier), the Lab (one calibrated picture), and offline in Python for the daily content.

## 5. Content pipeline (offline)

`python -m coach.game.build` in `20-football-analytics/coach/game/` (`moments.py`, `refits.py`, `scoring.py`,
`quality.py`, `days.py`, `build.py`).

1. **Candidates.** Every synced pass decision of the 27 open matches: 16,680 candidates. Options are the coach's
   options at the release frame.
2. **Held-out models per match.** Each match is scored with models trained without it, so the coach never "remembers"
   the answer. `answers/<id>.json` records `trained_without`.
3. **Close calls from 20 bootstrap refits.** For each held-out match, the pass, value, arrival and shot models are
   refitted 20 times on whole-match resamples of the training matches. `share_top(o)` is the fraction of refits in
   which option o has the highest score.
4. **Points (0-100).** 100 if o is the main model's best option or `share_top(o) >= 0.2` ("among the best"; several
   options can share it). Otherwise partial credit by rank r among the R non-100 options, falling quadratically:
   `90 * ((R - r) / (R - 1))^2`. In the released 300-moment audit set, 198 moments have one option at 100, 89 have two
   and 13 have three, out of about 15 options per moment.
5. **Quality filters.** 9-11 tracked players per side (a red card leaves 10), ball within 2 m of the carrier, no
   position jump over 1.5 m per frame in the 3 s lead-up. Moments where one option is best in all 20 refits
   ("obvious") are dropped; this removes about a third.
6. **Anti-exploit filter.** Moments where the shot, the most advanced pass or the nearest pass already scores 100 are
   not selected (pool 16,680 -> 8,869 candidates). See the content audit below and `DECISIONS.md`.
7. **Zone-stratified pool.** Interest is ranked **within each zone** (percentiles of the options' score spread and of
   the stakes, bonuses for cut-backs, AI-vs-pro disagreements and shots that followed) and the pool is filled 1 : 2 : 2
   (own third : midfield : final third) like the daily slots. Ranked on raw spread, 92 % of the pool was in the final
   third and only 8 days could be built.
8. **Daily sets.** 5 moments: one build-up, two midfield, two final third; distinct matches; at least one followed by
   a shot or goal; ordered by difficulty.
9. **Reveal data.** 6 s of real tracking after the release (A-League ball gaps of up to 6 frames interpolated), the
   scoreline at the moment, and the coach's top reasons with their sign (+ raises the success chance, - lowers it,
   = a value term).

Current release: `content-v1`, start 2026-12-01, **117 days, 585 moments** (pool 3,500), generated by library commit
`407ec77`. The audit script `python -m coach.game.evaluate_content` reads the candidate cache and the release without
fitting models and reports (a) whether points relate to what happened and (b) what trivial strategies score. On the
117-day release: playing like the pro 54.8, random 37.5, most advanced pass 59.2, shoot-if-possible 57.6, nearest
teammate 52.0, and no trivial strategy scores 100 on any released moment.

## 6. API contract

`POST /api/pick` (`api/src/handler.ts`, `validate.ts`, `result.ts`).

**Request** (JSON, at most 1,024 characters):

```json
{ "player": "<uuid v4>", "moment": "<id>", "option": 3, "guess": 7 }
```

- `player`: lower-case UUID v4. `moment`: `[A-Za-z0-9-]{1,64}`. `option`, `guess`: integers 0..63.
- Exactly the keys `{player, moment, option}` or `{guess, moment, option, player}`; any other key is rejected.
  `guess` (the answer to "what did the pro do?") is optional for older clients; when present it must be an integer,
  not `null`.

**Processing**
1. Parse and validate -> 400 `invalid request`.
2. Look up the answer and the moment's publication day; unknown moment or day later than UTC today + 1 -> 404.
3. `option` and `guess` must be option keys of that moment -> 400 `invalid option`.
4. **First answer wins.** If a pick already exists for (player, moment), return the stored result with
   `repeat: true`, including the stored guess. A different second answer cannot change the score.
5. **Rate limit.** Only for a new pick: `bumpRate(ipHash(ip) + "#" + UTC date)`; above 50 picks per network per day
   -> 429. The IP is hashed with a salt (SHA-256, truncated) and never stored. Locally the salt is a fixed dev
   string; the plan is a daily salt derived from a secret in SSM Parameter Store.
6. `putPickIfAbsent` (conditional write); only a fresh pick increments the crowd counter for its option. A race
   between two identical requests resolves to the first stored pick.

**Response 200** (`PickResult`): `option, points, among_best, pro_instinct, ai_pick, pro_pick, outcome, reasons,
all_points, after, crowd, repeat, guess, guess_right`.
- `crowd` is `{k: share}` only when the moment has at least **20** picks (`CROWD_MIN`), else `null`. Shares, not
  counts, are shown.
- `guess_right` is `null` when no guess was sent.

**Errors**: 400 invalid body or option, 404 unknown or future moment, 429 daily limit.

`api/src/dev.ts` is a Node HTTP server on :8787 serving `POST /api/pick` and `GET /content/*` (same future-day rule
for day files). The Lambda handler planned for AWS reuses `handlePick` with a DynamoDB `Store`.

## 7. Lab: from a TV picture to tactics (in the browser)

`app/lab.html`, `app/src/lab/`. Everything runs on the device; the picture or camera stream is not uploaded.

| Step | Implementation |
|---|---|
| Detection | MediaPipe Tasks `ObjectDetector` with **EfficientDet-Lite0** by default (320 px input) or **Lite2** as an "accurate" option (448 px input, 12 MB), both float16 `.tflite`, Apache-2.0, served from `app/public/lab/`; wasm runtime from jsDelivr pinned to `@mediapipe/tasks-vision@1.2.2`, CPU (XNNPACK) by default. Loaded lazily. |
| Tiled scan | The model sees 320 x 320 px, so small players in a wide shot are lost. A full-image pass plus **square tiles of 384 source px with 25 % overlap** (448 px for Lite2), so a 30 px player stays about 30 px; persons kept at score >= 0.25 in tiles (0.3 on the full frame); boxes mapped back to source pixels; greedy NMS that also drops boxes mostly inside a better one (tile-cut duplicates); a feet correction for the box bottom. Tuned on the benchmark (section 8); the old full frame + 3 x 2 grid stays as `LEGACY_SETTINGS` for comparison. |
| Ball pass | Ball-only pass on finer 6 x 4 tiles (~256 px tiles on a 1280 px picture, magnified to 320 px), skipping tiles with less than 15 % grass (crowd, sky). "sports ball" kept at score >= 0.18, then filtered by aspect ratio, size, head-zone overlap with players and on-pitch position. |
| Teams | Torso crop of each box, mean colour ignoring grass pixels, CIELAB, deterministic k-means (k = 2, farthest-point init). A colour far from both centres (> max(2.5 x median distance, 18 Lab units)) is "other" (referee, keeper). Separation below 15 Lab units is reported as unreliable. |
| Pitch lines | White-line mask (thin bright stripes on grass, player boxes excluded) -> sequential Hough transform with least-squares refit on each line's inliers, then removal of those points and repeat -> line intersections on painted runs. Written from scratch, no OpenCV. (The commit history calls this "RANSAC lines"; the code is a vote-refit-remove loop with the same aim: robust lines from noisy pixels.) |
| Auto-calibration | `autocal.ts`, no taps. The detected lines are split into two pencils by vanishing point (goal-line-parallel and touchline-parallel; the horizon joins the two points). Within a pencil the model lines map to the pencil parameter by a 1-D affine map, so two line correspondences give a family hypothesis, scored against the detected paint. The best family pairs give 4 line correspondences, solved by DLT and scored by the mean distance of all reprojected model lines (arcs and circle included) plus the paint left unexplained; the winner is refined by least squares on all inlier intersections. Both halves are searched; ranked alternatives are offered ("Other solution") when a view is ambiguous. About **50-110 ms** in the browser. On the synthetic scene the fit is sub-pixel (the Lab reports 0.0 px mean distance to the painted lines) and the unit tests require the box corners within 2 px, also with two lines missing. Dragging a point refines the fit live. |
| Manual calibration | The user taps 4 landmarks (default: the corners of the right penalty box); each tap snaps to the nearest detected intersection within a radius. A collinear-triple check rejects degenerate input. |
| Homography | Normalised DLT (Hartley), own Gaussian elimination; least squares for more than 4 points. Pitch lines are reprojected onto the picture and a fit-quality score samples the distance transform of the line mask along them. |
| Map and coach | Feet (box bottom-centre) -> pitch metres; automatic carrier (nearest player within 3 m of the ball); attacking direction from the deepest players; top-down map; the same TypeScript coach gives the top 3 options with reasons. One picture has no velocities, so the coach sees a frozen frame. |
| Live camera | Rear camera, VIDEO-mode detector, adaptive throttle (detector uses about half the time, 100-1000 ms interval), team centroids fixed after calibration with decaying votes so labels do not flip, greedy nearest-neighbour tracking with alpha-beta smoothing (gate 4 m, speeds capped at 9 m/s, reported after 3 hits), a one-target ball tracker; freeze, calibrate, and ask the coach with the estimated velocities. Needs HTTPS (`npm run dev:phone`). |

A synthetic broadcast-like scene drawn by code (`scene.ts`) lets the Lab be tried without a third-party image.

## 8. Lab benchmark: renders of real tracking data

There is no permissively licensed set of labelled broadcast frames to measure the Lab on, and TV screenshots cannot
be published. So the benchmark makes its own frames (`scripts/cv-bench/`):

- `render.mjs` draws broadcast-like frames in headless Chromium from the **real player tracking** of the free-play
  match (Bassek et al. 2025, DFL / Sportec, CC BY 4.0) through a virtual pinhole camera in three views (wide, zoom,
  behind the goal), with figures, grass texture, blur and noise. The camera is known, so the ground truth is exact:
  every player's projected box, feet point, occlusion, team, and the ball.
- `run.mjs` runs the Lab's **real pipeline** (`app/src/lab/bench.ts` -> `detector.ts`, `teams.ts`, `players.ts`) on
  those frames in Chromium and writes `scripts/cv-bench/results.json`. Matching is greedy at IoU 0.5; "small" means
  under 40 px tall.

60 frames, 1,133 players (737 small):

| Pipeline | Person recall | Precision | Recall, small | Recall, wide view | Ball found | Median feet error |
|---|---:|---:|---:|---:|---:|---:|
| Before (full frame + 3 x 2 grid, Lite0) | 43.5 % | 80.6 % | 28.8 % | 33.6 % | 48 % | 0.15 m |
| **Default** (Lite0, 384 px tiles, threshold 0.25) | **69.9 %** | **85.9 %** | **61.9 %** | 64.4 % | 53 % | 0.14 m |
| Option: Lite2 (448 px tiles) | 80.1 % | 94.0 % | 73.4 % | 77.1 % | 63 % | 0.19 m |

In `results.json` the default row is the config labelled `default-t25`; the row labelled `default` there is the same
tiling at a 0.3 tile threshold (63.3 % recall, 88.3 % precision), measured before the threshold was lowered. The
headless-CPU timings of the run (median 3.1 s per frame for the default, 7.3 s for Lite2, 2.4 s before) are not phone
timings. Team purity stays at about 98-99 %.

**What this does not show:** these are synthetic renders, not TV pictures. Real broadcasts add motion blur, graphics,
compression, crowds and lighting that the renderer does not model, so real-world recall is expected to be lower. The
Lab has not been measured on labelled real broadcast frames.

## 9. Game client: 3D, offline, languages, static demo

### 9.1 3D view and camera modes

`app/src/view3d/` is a lazy three.js chunk (about 540 kB, 137 kB gzip) with a fallback to 2D without WebGL. Three
cameras: **player's eyes** (from the carrier's head, drag to look), **stadium** (TV-style, 16 m behind the near
touchline and 24 m up, panning with the ball) and **tactical** (high and tilted, most of the pitch in view); dragging
orbits and the wheel zooms. Switching mode or moment does not cut: the aim point and heading close their gap with
frame-rate independent exponential smoothing (`1 - exp(-dt / tau)`, tau 0.5-0.6 s), player positions between
tracking frames are interpolated, and a large jump of the focus snaps instead of sweeping across the pitch. The choice
is remembered; reduced motion is respected. Tap targets (teammates, carry chevrons, the goal) are ray-picked with
large hit areas. Free play has the same 3D view.

### 9.2 Offline play

`app/src/offline/`: a service worker (production builds only) precaches the game shell and caches days and moments;
today's five are prefetched. Answers given offline are queued in localStorage and sent when the network is back (on
`online`, on the next load and on a backoff timer); the server's "first answer wins" makes a resend safe. `/api/*` is
never cached; the 3D chunk and the Lab are network only. A "new version available" toast replaces silent swaps.

### 9.3 French and English

Typed dictionaries (`app/src/i18n/`; the Lab's strings in their own dictionaries, loaded with the Lab), plural forms,
`Intl` number formats, the coach's phrases translated by pattern, an EN | FR switch saved in the browser. See ADR-11.

### 9.4 Static demo (GitHub Pages)

`npm run demo:content -- <content-vN>` packages the first 30 days of a release (public files **and** answer files)
into `demo/content/`; `npm run demo:build` builds the app with `VITE_DEMO=1` under `/playmaker/` with relative URLs and
copies the content next to it. `.github/workflows/pages.yml` deploys it from `main`.

In demo mode (`app/src/demo.ts`) there is no server. Today's date is mapped onto the 30 days cyclically, so there is
always a "today". A pick fetches the moment's answer file and is scored in the browser by the API's own `buildResult`
(`api/src/result.ts`), so the points are the same as on the server; the first answer per moment wins in that browser;
there are no crowd stats and no rate limit. **Trade-off:** in the demo the answers are public, so anyone who opens
the network tab can read them. The full service (section 3) keeps answers server-side until the pick; the README
says so. See ADR-12.

## 10. Testing strategy

| Layer | Tool | Count (2026-11-10) | What it covers |
|---|---|---:|---|
| Unit, app | vitest | 96 | 3D geometry and picking (22), replay (17), i18n (14), stats (14), coach (11), storage (7), share card and text (8), keyboard (2), pitch (1) |
| Unit, Lab | vitest | 57 | homography (DLT recovers a known transform to 1e-6), landmarks, colours and k-means teams, players, tiles and NMS, wasm version pin, synthetic scene (19); lines and snapping (13); live tracking and throttle (17); ball (8) |
| Parity | vitest | 64 | Python vs TypeScript coach on 30 real frames (1e-6), explanations (1e-9) |
| API | vitest | 12 | validation (4), handler (7): scoring, pro guess, first answer wins for pick and guess, crowd from 20 picks, 400/404/429; fs answers (1) |
| Contract | vitest + ajv | 1 | all fixture content files against the release JSON Schemas |
| End to end | Playwright, Pixel 7 profile, reduced motion | 9 | a full day with both questions, reveal and recap; tap a teammate in 2D; tap a teammate in **3D**; keyboard play (arrows / Tab / Enter); launch-day intro; public content never exposes answers; one moment in **French** with the guided first moment; tour skip; EN / FR switch persisted |

Total on 2026-11-10: **230 vitest tests in 20 files** (96 + 57 + 64 + 12 + 1), **9 Playwright tests**. The Lab
auto-calibration and benchmark helpers, the 3D camera modes and offline play added tests since: 305 vitest tests in 29
files and 11 Playwright tests (including offline play) on 2026-11-12. The e2e suite starts the dev API on a 117-day content fixture (`tests/fixtures/content`)
with `PLAYMAKER_TODAY=2026-12-01`.

The content builder and the audits are tested on the library side with pytest (for example
`tests/test_20_game.py`, which also checks the fast scorer against `advice.options` to 1e-12).

## 11. CI

`.github/workflows/ci.yml`, on every push and pull request, Ubuntu, Node 24, read-only token:
`npm ci` -> `tsc --noEmit` -> `vitest run` -> `npm run build` (4 pages: game, Lab, replay, about; three.js is a lazy
chunk of about 540 kB, 137 kB gzip) -> Playwright Chromium install -> `npm run e2e`.

## 12. Planned AWS deployment (not deployed)

From the design spec, section 3 and 5. Nothing below exists yet.

```
 CloudFront (one HTTPS address, security headers, price class 100)
   /            -> S3 app bucket (built game)
   /content/*   -> S3 content bucket public/ (private, Origin Access Control)
                   + CloudFront Function: no day file later than UTC today + 1
   /api/*       -> API Gateway HTTP API (throttle 20 req/s, burst 40)
                   -> Lambda (Node, TypeScript, handlePick), answers/ cached in memory
                   -> DynamoDB, one table, on-demand, TTL
                        MOMENT#<id>  / OPTION#<k>      n (atomic ADD)
                        PLAYER#<uuid>/ PICK#<moment>   conditional put, expires after 400 days
                        RATE#<iphash>#<date> / RATE    count, expires after 1 day
```

- Infrastructure as code with AWS CDK; deploy from GitHub Actions with OIDC (no stored AWS keys); post-deploy smoke
  test (today's day loads, a pick returns a result, a repeated pick returns the same).
- **$20 lifetime cap** (owner rule): at most $20 of AWS credit in total, ever. The AWS account is used for Playmaker
  only, so the guard watches the whole account. Budget alerts at $5, $10 and $15 actual and $15 forecast. **Kill
  switch at $15 actual** (billing data lags up to about 24 h, so the stop comes $5 early): the budget's SNS topic
  triggers a Lambda that sets the API throttle to 0, disables the CloudFront distribution and emails the owner.
  Restarting is a manual decision.
- Hard ceilings independent of billing: API throttle, 50 picks per network per day, log retention 14 days, no
  always-on resource (no NAT, EC2, RDS or WAF).
- Expected cost at 1,000 players a day: $0-1 per month (spec estimate, not measured).
- Before any resource is created: check the account (the connected account is a training account whose policy blocks
  S3 and CloudFormation), read the remaining credits and their expiry, and get the owner's explicit go.

## 13. Known limits

- **Only the static demo is deployed.** It ships the answers (section 9.4) and has no crowd stats. Locally, picks,
  crowd counts and rate counters live in memory and are lost on restart.
- **The value model is weak.** It explains about 2 % of the variance of the next 15 s on held-out Bundesliga matches
  and is no better than distance to goal. Points relate to what followed only weakly (Spearman +0.08). The game says
  "the AI's opinion", not "the right answer".
- **The pro rarely scores 100** (5 % of the 300-moment audit set): the coach plays bolder than professionals, and the
  interest ranking favours disagreements.
- **Content is mostly A-League** (257 of 300 moments in the first 60-day release), because of the distinct-match rule
  and the 20 vs 7 match split.
- **Crowd counts can be inflated** by fake player ids; mitigated by the per-network cap, the 20-pick threshold and
  shares only. No accounts.
- **Lab:** one picture has no velocities; the ball's ground point is wrong when it is in the air; similar kits break
  the colour split; the homography assumes a flat pitch; auto-calibration needs enough painted lines (a midfield view
  with few lines can be ambiguous). The detection benchmark (section 8) uses synthetic renders of real tracking: the
  Lab has **not** been measured on real TV pictures. The MediaPipe wasm runtime is loaded from a CDN.
- **Parity covers one match** (30 frames). It guards the port, not the models' quality.
- **Failed-pass targets are inferred** in the Bundesliga data (outcome-informed), so the pass model's headline AUC is
  an upper bound (leak check 0.77-0.81 vs 0.838).
