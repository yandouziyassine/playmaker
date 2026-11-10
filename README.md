# Playmaker

A daily football decision game. Five real moments from professional matches: you have the ball, pick the pass. Then
see the AI coach's pick and its reasons, what the pro did, what happened in the next 15 seconds, and how other players
chose.

The AI coach, its data and its honest benchmark live in
[COMPUTER-VISION-PROJECT-LIBRARY / 20-football-analytics](https://github.com/yandouziyassine/COMPUTER-VISION-PROJECT-LIBRARY/tree/main/20-football-analytics)
(design: `docs/superpowers/specs/2026-11-09-playmaker-fan-game-design.md`).

## How it works

- **Content** is built offline by the library (`python -m coach.game.build`): every moment is scored by models trained
  without its match, plus 20 refits on resampled matches for the close-call rule. Public files carry no answers;
  answers stay server-side until you pick.
- **API** (`api/`): `POST /api/pick` validates the pick, keeps the first pick per player and moment, rate-limits per
  network (salted hash, never the IP), and returns the reveal and the crowd split (from 20 picks).
- **Game** (`app/`): Vite + TypeScript, canvas 2D, phone first; streak and history in the browser.

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
