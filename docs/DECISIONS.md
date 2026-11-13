# Design decisions

Short records of the decisions that shaped Playmaker, in the style of architecture decision records. Each has the
context, the decision and its consequences. Numbers come from the library's README, `docs/playmaker_content_eval.json`
and `docs/coach_model_lab.md` in `COMPUTER-VISION-PROJECT-LIBRARY/20-football-analytics`, and from the design spec
`docs/superpowers/specs/2026-11-09-playmaker-fan-game-design.md`.

---

## ADR-01. Static content and a tiny API, no models on the server

**Context.** The coach's models are fitted in Python (scikit-learn) and have a TypeScript port. Running Python on a server
would need a container or a large Lambda, cold starts and a second place where models can drift. Every daily moment
is known in advance.

**Decision.** Score everything offline and publish a versioned content release (`content-v{n}`). The app and the
public content are static files. The only dynamic part is `POST /api/pick`, which looks up precomputed answers and
records picks through a five-method `Store` interface.

**Consequences.** One source of truth per content version; published days never change. The server has no ML
dependencies and costs almost nothing at small scale. A model change requires a full content rebuild and a new
version, which makes model updates deliberate (see ADR-06).

---

## ADR-02. Answers stay server-side until the pick

**Context.** Anything sent to the browser can be read in developer tools. If moment files carried the scores or the
pro's pass, the game would be trivially solvable and the crowd statistics would be meaningless.

**Decision.** The builder splits each moment into a public file (positions, players, options) and an answer file
(scores, points, `share_top`, reasons, AI pick, pro pick, outcome, the 6 s replay after the pass). Only the API reads
answer files. Days later than UTC today + 1 are refused, by the API for picks and by the content route for day files.

**Consequences.** Enforced by the builder's `--validate` key scan, JSON Schemas (ajv contract test) and an e2e test
that a served moment contains no answer keys and that `/content/../answers/` returns 404. The reveal needs one
network round-trip; the first moment is prefetched to keep the start fast.

---

## ADR-03. Close-call scoring from 20 bootstrap refits

**Context.** The value model explains about 2 % of the variance of the next 15 s on held-out matches (skill 2.2 %, no
better than distance to goal at 1.9 %). Two options can be within noise of each other. Telling a player "wrong" in
that case would be false precision.

**Decision.** Each held-out match is also scored by 20 refits of the four models on whole-match resamples. An option
scores 100 when it is the main model's best or the best in at least 20 % of refits. Other options get partial credit
by rank. The UI calls the ranking "a model opinion, not the truth" and always shows the real outcome.

**Consequences.** Several options can score 100 (in the 300-moment audit set: 198 moments with one, 89 with two, 13
with three). The build is about 20 times more expensive, which is acceptable offline. Moments where one option wins
all 20 refits are dropped as "obvious" (about a third of candidates).

---

## ADR-04. A second, objective question: what did the pro do?

**Context.** The first question is scored by a weak model. Players need at least one answer that is plainly right or
wrong, and the reveal already knows the real pass.

**Decision.** After "What would you do?", ask "What did the pro actually do?" among the pass options. The guess is
sent with the pick, validated as an option of the moment, stored with the first answer (first answer wins for both),
and returned as `guess_right`. It is optional in the API so older clients keep working.

**Consequences.** Every moment has a model-free score. Stats, the done screen and the share text show "pro reads".
The API contract grew by one optional key, covered by handler tests.

---

## ADR-05. Anti-exploit filter and quadratic partial credit

**Context.** The content audit played the first 300 released moments with trivial strategies that only read public
geometry. "Shoot if possible, else the most advanced pass" averaged 85.8 points (56 % of 100s), the most advanced pass
81.7, the nearest teammate 75.1, all above playing like the pro (74.8). Every final-third moment offered a shot and the
shot scored 100 in 82 % of them.

**Decision.** Replay candidate fixes through the real daily selection first (`what_if` in the audit JSON), then apply
both of: (1) do not select moments where the shot, the most advanced pass or the nearest pass already scores 100
(pool 16,680 to 8,869 candidates); (2) partial credit `90 * ((R - r) / (R - 1))^2` instead of linear.

**Consequences.** After the rebuild: pro 56.6, random 37.4, most advanced pass 59.2, shoot-if-possible 58.0, nearest
teammate 54.5, and no trivial strategy scores 100 on any released moment. The 117-day release passes the same audit
(best trivial 59.2, pro 54.8). The best trivial strategy is still slightly above the pro on average; documented, not
hidden. A smaller pool means the season length is limited by the build-up slots (117 days with a pool of 3,500).

---

## ADR-06. Not shipping the model-lab value and arrival change

**Context.** The model lab (27 matches, 18,308 passes, leave-one-match-out) found that ridge models with zone-by-context
terms improve the value model (MSE skill 4.1 % to 5.5 %) and the arrival model (8.9 % to 10.0 %), both with intervals
above zero. End to end, the coach score's Spearman with the next 15 s moved from 0.088 to 0.097, +0.008 [-0.003,
+0.021]: up in the Bundesliga (0.053 to 0.110), slightly down in the A-League (0.097 to 0.094). Six new pass features
improved log-loss but made the end-to-end score worse (-0.014 [-0.018, -0.009]).

**Decision.** Keep the current models. Reject the pass-model changes. Do not ship the value and arrival change yet.

**Consequences.** Shipping would require new context features at every valued point in Python and TypeScript, new
parity fixtures and a rebuild of all released days, for a gain the data cannot confirm. The change is first in line
when more matches are added. Judging models end to end, not on their own loss, is the rule this sets.

---

## ADR-07. TypeScript port of the coach with a 1e-6 parity test

**Context.** The coach must run in the browser for free play and the Lab, and it must agree with the Python that
built the daily content. Two implementations of the same formulas drift silently.

**Decision.** Keep the models linear (logistic and ridge with exported scaler and coefficients) and port features,
pitch control, advice and explanations to TypeScript. A fixture written by the library on 30 real frames is checked
in vitest: features, probabilities, values, scores and target points within 1e-6, ranking exact, explanation
contributions within 1e-9. The shipped `models.json` must equal the fixture's models.

**Consequences.** 64 parity tests. Gradient boosting and other non-portable models are effectively excluded from the
shipped coach, which the model lab also found were not better end to end. Parity guards the port, not the models'
quality, and covers one match.

---

## ADR-08. In-browser computer vision with MediaPipe, permissive licences only

**Context.** The Lab turns a TV picture into a tactical map. Server-side inference would cost money, add latency and
mean uploading user images. Many detection models and football datasets have non-commercial or unclear licences, and
the owner's rule is to show only permissively licensed material in public.

**Decision.** Use MediaPipe Tasks `ObjectDetector` with EfficientDet-Lite0 (Apache-2.0) in the browser. The `.tflite`
file is served by the app with its licence file; the wasm runtime is pinned to the installed npm version (a unit test
checks it). Everything after detection (tiling, NMS, team colours, line detection, homography, tracking) is written
from scratch in TypeScript without OpenCV. The demo scene is drawn by code, so no third-party image is shipped.

**Consequences.** No upload, no server cost, works on a phone. The model sees 320 x 320 px, so small players need a
tiled pass and the ball a finer one. Accuracy is lower than a large server model and has not been benchmarked on
labelled broadcast frames. The wasm runtime is loaded from jsDelivr at run time.

---

## ADR-09. AWS with a $20 lifetime cap and a kill switch (planned)

**Context.** The owner's rule is to use promotional AWS credits only and at most $20 in total, for ever, for this
project. Billing data lags up to about a day.

**Decision.** Serverless, pay-per-use stack (CloudFront, S3, API Gateway HTTP API, Lambda, DynamoDB on demand), defined
with CDK and deployed through GitHub OIDC. A dedicated account so the guard can watch total spend. Budget alerts at
$5, $10 and $15 actual and $15 forecast; at $15 actual a Lambda sets the API throttle to 0, disables CloudFront and
emails the owner. Hard ceilings that do not depend on billing: throttle 20 req/s (burst 40), 50 picks per network per
day, 14-day log retention, no always-on resources, no WAF.

**Consequences.** Expected cost $0-1 per month at 1,000 players a day (estimate). Restarting after the kill switch is
manual. **Not deployed yet:** the connected account blocks S3 and CloudFormation, and the credits and owner's go must
be confirmed first.

---

## ADR-10. Privacy by default: no accounts, salted IP hashes

**Context.** A daily game needs to stop repeated answers and abuse, but collecting personal data would need consent
flows and storage obligations.

**Decision.** A random UUID v4 in localStorage identifies the player. Streak and history stay in the browser. The rate
limit keys on a salted SHA-256 hash of the source IP and the UTC date; the IP is never stored. The crowd split is shown
as shares and only from 20 picks.

**Consequences.** No sign-up friction, little to protect. Clearing storage resets the history. Fake ids can inflate
crowd counts, bounded by the per-network cap.

---

## ADR-11. French and English from the start

**Context.** The owner works in English and French. Adding a language late usually means hunting hard-coded strings.

**Decision.** A small dependency-free i18n module: typed dictionaries (`en.ts`, `fr.ts` share one key type), plural
forms, `Intl` number formatting, an EN | FR switch saved in the browser, and the coach's phrases translated by pattern.

**Consequences.** A missing French key is a type error. Covered by 14 unit tests and 3 French e2e tests (a full moment
in French with the guided tour, tour skip, the saved language choice on the about page).

---

## ADR-12. A static demo that ships the answers

**Context.** The full service needs the pick API to keep answers secret (ADR-02), but it is not deployed (ADR-09). A
portfolio project needs a link anyone can open today, at no cost and with no server to run.

**Decision.** A separate static build (`VITE_DEMO=1`, GitHub Pages, deployed from `main` by
`.github/workflows/pages.yml`) with 30 days of a release, answer files included. `app/src/demo.ts` maps today's date
onto the 30 days cyclically and scores a pick in the browser with the API's own `buildResult`, keeping the first answer
per moment in that browser. The real build and API are unchanged.

**Consequences.** Free, always up, same points as the server. But the answers are readable in the network tab, so the
demo cannot be a fair competition; there are no crowd stats and no rate limit. The README says so (the About page does not yet).
The full service still keeps answers server-side.

---

## ADR-13. A CV benchmark rendered from real tracking data

**Context.** The Lab's detector needed numbers, not impressions. Labelled broadcast datasets are mostly
non-commercial or research-only, and TV screenshots are copyrighted, so neither can be used or shown in a public repo.

**Decision.** Render broadcast-like frames from the real, CC BY 4.0 tracking of the free-play match through a known
virtual camera (`scripts/cv-bench/render.mjs`), so the ground truth (boxes, feet, teams, ball) is exact, and run the
Lab's real pipeline on them in Chromium (`run.mjs` -> `results.json`). Tune tiling and thresholds only against it.

**Consequences.** Reproducible, licence-safe numbers that moved the default from 43.5 % to 69.9 % person recall and
28.8 % to 61.9 % on small players, with precision up from 80.6 % to 85.9 %. Every number is labelled synthetic: the
renderer has no motion blur, graphics, compression or real crowds, so the Lab has **not** been measured on real TV
pictures and real recall is expected to be lower. There is a risk of tuning to the renderer; the settings were kept
simple (tile size, overlap, one threshold) to limit it.

---

## ADR-14. EfficientDet-Lite0 by default, Lite2 as an option

**Context.** On the benchmark, Lite2 is clearly better (person recall 80.1 % vs 69.9 %, precision 94.0 % vs 85.9 %,
small players 73.4 % vs 61.9 %), but it is a 12 MB model with a 448 px input: roughly twice the time per frame in the
benchmark run (median 7.3 s vs 3.1 s on headless CPU) and more on a phone, where the Lab also runs live.

**Decision.** Keep Lite0 as the default (faster first load, usable live on a phone) and offer Lite2 as an "accurate"
choice in the Lab's detector menu, remembered in the browser. Both are Apache-2.0 and served from the app; the
benchmark reports both.

**Consequences.** The default is the fast path most visitors take; anyone analysing a single picture can switch to
the better model. Two models to keep in the benchmark and the tests.
