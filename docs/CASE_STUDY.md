# Case study: Playmaker, a daily football game built on an AI coach

*Yassine Yandouzi, November 2026*

**Play the demo: https://yandouziyassine.github.io/playmaker/** (a static build: 30 days that cycle, picks scored in
your browser; see "A static demo" below for what that trades away).

## The problem

In my computer vision library I had built an AI coach for football: given one tracking frame (22 players and the
ball), it ranks what the player on the ball can do (pass to each teammate, carry, shoot) in expected goals, with
reasons. It was evaluated on held-out matches and benchmarked against two published methods, expected threat (xT) and
VAEP. But it only existed as numbers in a README and a replay demo.

I wanted to turn it into something people use, and to answer a practical question: what has to be true about a model
before you can score people with it? The result is Playmaker. Every day, five real moments from professional matches.
You have the ball: pick the pass, then guess what the professional actually did. The reveal shows the coach's pick and
reasons, the pro's pass, what happened in the next 15 seconds and how other players chose.

## Approach

- **Offline (Python).** A content builder scores every pass decision of 27 open matches (7 Bundesliga / 2. Bundesliga
  matches from DFL / Sportec Solutions, 20 A-League matches from SkillCorner), always with models trained **without**
  that match. It refits the four models 20 times on resampled matches to expose close calls, applies quality filters,
  and writes a versioned release: public files with positions and options only, and answer files that stay on the
  server.
- **Online (TypeScript).** A static Vite app and one endpoint, `POST /api/pick`, which validates the pick, keeps the
  first answer per player and moment, rate-limits per network with a salted hash, and returns the reveal.
- **The same coach in the browser.** I ported the engine to TypeScript and test it against Python on 30 real frames
  to within 1e-6, so free play and the Lab compute exactly what the content pipeline computed.

## What I found

### The model is weak, so the scoring has to be humble

The value model explains about **2 % of the variance** of what happens in the next 15 seconds on held-out Bundesliga
matches (skill 2.2 %), no better than distance to goal (1.9 %). Goals are rare and the data is small. Telling someone
"wrong, 0 points" on that basis would be dishonest.

So the scoring is built around uncertainty. An option scores 100 if it is the main model's best **or** the best in at
least 20 % of the 20 bootstrap refits; the others get partial credit by rank. The reveal labels the ranking "a model
opinion, not the truth" and always shows what really happened.

I then checked whether points mean anything. Over all 16,680 candidate moments, for the option the professional
chose, points correlate with the net xG of the next 15 seconds at **Spearman +0.08** [0.07, 0.09]. Passes scored 0-49
are clearly followed by less (+0.0024 net xG vs +0.0087 for 100-point passes), but 100 and 50-99 overlap. The ordering
is right; the signal per moment is weak. The "About the AI" page says so in plain words.

### The audit found an exploit, and I fixed it

I wrote an audit that plays the released days with trivial strategies that read only the public geometry. The first
release failed it:

| Strategy (300 released moments) | Before | After the fix |
|---|---:|---:|
| Shoot if possible, else most advanced pass | 85.8 (56 % of 100s) | 58.0 (0 %) |
| Pass to the most advanced teammate | 81.7 | 59.2 (0 %) |
| Pass to the nearest teammate | 75.1 | 54.5 (0 %) |
| Play like the pro | 74.8 | 56.6 |
| Random option | 50.9 | 37.4 |

A player who never looked at the defence beat the professionals. The cause was the shot: every final-third moment
offered one and it scored 100 in 82 % of them, while the pro never shot by construction (the moments are pass
decisions). I replayed candidate fixes through the real daily selection first, then applied two: moments where the
shot, the most advanced pass or the nearest pass already scores 100 are not selected (pool 16,680 to 8,869
candidates), and partial credit falls quadratically with rank. After the rebuild **no trivial strategy reaches 100 on
any released moment**. The longer 117-day release (585 moments) passes the same audit: pro 54.8, most advanced pass
59.2, shoot-if-possible 57.6, random 37.5. The best trivial strategy is still slightly above the pro on average, which I
state openly; scoring 100 now requires reading the defenders.

Checking disagreements had already found an earlier blind spot: the coach put completed cut-backs at a median
percentile of 4 %, where xT and VAEP put them in their top 1 %. A separate arrival value for pass targets moved them to
99.1 % on the A-League (n = 54), and the coach score's correlation with what followed went from slightly negative to
+0.086 (A-League) and +0.083 (Bundesliga) on held-out passes.

### Measuring the Lab without labelled TV pictures

The Lab detects players in a TV picture, but I had no permissively licensed, labelled broadcast frames to measure it
on, and TV screenshots cannot be published. So I built the ground truth myself: a renderer draws broadcast-like
frames from the **real tracking data** of the free-play match (CC BY 4.0) through a virtual camera, in wide, zoomed
and behind-the-goal views. The camera is known, so every player's box, feet point and team are exact. The Lab's real
detection code then runs on those frames in Chromium.

The first run showed what I suspected: on 60 frames (1,133 players) the pipeline found **43.5 %** of the players, and
only **28.8 %** of the small ones (under 40 px tall), because a wide shot shrunk to the model's 320 px input makes a
player a few pixels tall. Square tiles of 384 px with 25 % overlap, a lower score threshold inside tiles, a better
duplicate filter and a feet correction brought the default to **69.9 % recall** (small players **61.9 %**) with
precision **up**, 80.6 % to **85.9 %**. EfficientDet-Lite2 as an optional "accurate" model reaches **80.1 %** recall,
**94.0 %** precision and **73.4 %** on small players, at about twice the time. Lite0 stays the default (see
DECISIONS.md, ADR-14).

The limit is stated next to the numbers: these are synthetic renders, not TV pictures. Real broadcasts have blur,
graphics, compression and crowds that my renderer does not model, so I expect lower numbers on real footage, and I
have not measured that.

The same scene also tests the new **automatic calibration**: the painted lines are grouped by vanishing point,
matched to the pitch model one line family at a time, and solved as a homography in about 50-110 ms in the browser.
On the synthetic scene the fit is sub-pixel; the tests require the penalty-box corners within 2 px, also with two lines
missing. No more four careful taps.

### A static demo

To let anyone play without the server, the demo on GitHub Pages ships 30 days of content **with their answer files**
and scores each pick in the browser with the API's own result code, so the points are identical. Days cycle so there
is always a "today". The price is the property section 3 of the architecture was built for: anyone can read the
answers in the network tab, and there are no crowd stats. For a portfolio demo that is acceptable and said in the
README; the real service keeps answers on the server until you pick (DECISIONS.md, ADR-12).

### A better model on paper, not shipped

A model lab over all 27 matches (18,308 passes, leave-one-match-out, intervals from resampling whole matches):

- **Pass model:** six new features improved log-loss (+0.009 [+0.007, +0.011]), but the coach score of the pro's pass
  then tracked what followed **worse** (Spearman -0.014 [-0.018, -0.009]): better completion odds, worse advice.
  Gradient boosting gained 2.5 times more on a leak-check table than on the standard one, a sign it was learning the
  labelling, and it cannot run in the browser. Rejected.
- **Value and arrival models:** ridge with zone-by-context terms was better on its own metric (pooled value skill
  4.1 % to 5.5 %, arrival 8.9 % to 10.0 %, intervals above zero). End to end, the coach's Spearman moved from 0.088 to
  0.097, +0.008 [-0.003, +0.021]: up in the Bundesliga, slightly down in the A-League, not distinguishable from zero.

I did not ship it. It would need new features in Python and TypeScript, new parity fixtures and a rebuild of every
released day, for a gain the data cannot confirm. It is the first change to make when more matches are added.

## What I built

- **The daily game:** five moments, two questions each, a reveal with reasons, outcome, crowd split (from 20 picks)
  and a replay of the real 6 seconds after the pass; streaks, stats by pitch zone and pick type, an archive, a share
  card. A 3D view in three.js (a lazy chunk) with three cameras (player's eyes, a TV-style stadium camera, a tactical
  view); the camera glides between modes with frame-rate independent smoothing, and you tap a teammate to pass.
- **Free play:** a full Bundesliga match in 2D or 3D with "ask the coach" on the ball carrier.
- **The Lab:** from a TV screenshot or a phone pointed at the TV, players and ball are detected in the browser with
  MediaPipe EfficientDet-Lite0 (tiled passes for small players, a finer pass for the ball), teams split by shirt colour
  with k-means in CIELAB, pitch lines found with a from-scratch Hough pipeline, **automatic calibration** from those
  lines (or four taps snapped to line intersections), and a DLT homography maps everyone onto the pitch. The real
  coach then suggests the carrier's best options. Live mode tracks players and estimates velocities. Lite2 is an
  optional, more accurate detector.
- **A CV benchmark** built from renders of real tracking data (above), run with `npm run cv:bench`.
- **Offline play:** a service worker keeps the app and today's five; answers given offline are scored when back
  online.
- **French and English**, WCAG AA contrast, keyboard play, phone first.
- **A live static demo** on GitHub Pages, deployed from `main` by a workflow.
- **Tests:** about 300 unit, parity, API and contract tests and 11 Playwright end-to-end tests (a full day, 3D picking,
  keyboard play, French, offline play, no answers in public content), all in CI.
- **An AWS plan** for the full service with a $20 lifetime cap and a kill switch at $15. Not deployed yet: the account
  and credits must be checked first.

## What I would do next

1. Deploy behind the cap, run a two-week private beta, and measure completion and return rates.
2. Add matches and re-run the model lab; ship the zone-by-context models only if the end-to-end gain becomes
   distinguishable from zero.
3. Use the crowd's picks as data: where do players agree with the pros more than the coach does?
4. Measure the Lab on permissively licensed, labelled **real** broadcast frames, to see how far the synthetic
   benchmark is from TV pictures.

## Skills shown

- Leak-free model evaluation: leave-one-match-out, bootstrap refits, match-level confidence intervals, leak checks.
- Turning model uncertainty into a product rule, and auditing a scoring system for exploits.
- Rejecting a model change that improved its own metric but not the end goal.
- Porting ML inference across languages with numerical parity tests (Python to TypeScript, 1e-6).
- In-browser computer vision: tiled object detection, colour clustering, line detection, automatic homography
  calibration from vanishing points, tracking.
- Building an exact-ground-truth benchmark when no licensed labelled data exists, and reporting its limits.
- TypeScript, Vite, three.js, a small validated API, JSON Schema contracts, Playwright, GitHub Actions.
- Cost-bounded cloud design (lifetime budget, kill switch) and privacy by default (no accounts, hashed IPs).
