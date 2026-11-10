# Playmaker

A daily football decision game. Five real moments from professional matches: you have the ball, pick the pass. Then
see the AI coach's pick and its reasons, what the pro did, what happened in the next 15 seconds, and how other players
chose.

The AI coach, its data and its honest benchmark live in
[COMPUTER-VISION-PROJECT-LIBRARY / 20-football-analytics](https://github.com/yandouziyassine/COMPUTER-VISION-PROJECT-LIBRARY/tree/main/20-football-analytics)
(design: `docs/superpowers/specs/2026-11-09-playmaker-fan-game-design.md`).

## What you play

- **Five real moments a day** from open professional tracking data (Bundesliga, 2. Bundesliga, A-League). Watch 3 s of
  real play, then two questions: **What would you do?** (scored by the AI coach, close calls get full points) and
  **What did the pro actually do?** (objective: the real pass).
- **The reveal**: your points, the AI's pick with what helped and hurt, the pro's pick, what happened next, the crowd
  split, every option's score on the pitch, and a replay of the real 6 seconds after the pass.
- **2D or 3D**: a three.js "player's eyes" view from the ball carrier's head; tap teammates in either view.
- **Your stats** (by pitch zone and pick type, pro reads, an insight line), streaks, past days, a share image.
- **Lab: from a TV picture to tactics**: detect players in your own broadcast screenshot in the browser (MediaPipe
  EfficientDet-Lite0, Apache-2.0), split teams by shirt colour, calibrate the pitch with 4 taps (homography, lines
  reprojected onto the picture), see the shape from above, then ask the real AI coach for the carrier's best options.

## How it works

- **Content** is built offline by the library (`python -m coach.game.build`): every moment is scored by models trained
  without its match, plus 20 refits on resampled matches for the close-call rule. Public files carry no answers;
  answers stay server-side until you pick. A content audit (`python -m coach.game.evaluate_content`) checks that no
  trivial strategy (always shoot, most advanced pass, nearest teammate) beats the game: after the fix none reaches 100
  on any released moment (best 59 points vs 57 for playing like the pro).
- **API** (`api/`): `POST /api/pick` validates the pick and the pro guess, keeps the first answer per player and
  moment, rate-limits per network (salted hash, never the IP), and returns the reveal and the crowd split (from 20
  picks).
- **Game** (`app/`): Vite + TypeScript, canvas 2D, lazy three.js chunk for 3D, phone first; history in the browser.
- **Coach engine** (`app/src/coach/`): TypeScript port of the library's models, equal to Python within 1e-6
  (`app/test/coach-parity.test.ts`).

## Run locally

```bash
npm install
npm run content:link -- <path to content-v1>
PLAYMAKER_TODAY=2026-12-01 npm run dev     # API + content on :8787
npm run dev:app                           # game on :5173
npm test && npm run e2e
```

## Data credits

Bundesliga tracking and event data: Bassek et al. (2025), DFL / Sportec Solutions, CC BY 4.0.
Tracking and event data: SkillCorner open data (MIT). Code: MIT.
