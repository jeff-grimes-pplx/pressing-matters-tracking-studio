# Validation — Pressing Matters (A7)

All numbers below are produced by the scripts in this folder (`run_js.mjs`, `pc_scenes.mjs` + `pc_reference.py`, `recompute.py`, the Playwright drag test → `performance.json`, `build_validation_json.py`). Generated 2026-11-05T22:37:51Z.

## Pitch control vs reference implementation

Reference: `Metrica_PitchControl.py` from Friends-of-Tracking `LaurieOnTracking` (MIT), run unmodified on identical inputs (positions, velocities, ball, GK flags, default parameters, offside rule).

| Check | Result |
|---|---|
| Real scenes compared | 44 (passes, shots, kick-offs) × 7140 cells = 314,160 cells |
| Max abs difference (cells where the reference total ≤ 1) | 3.0e-08 |
| Mean abs difference | 7.9e-09 |
| Offside decisions identical | 44/44 scenes |
| Cells where the reference scheme overshoots (att + def > 1) | 93 of 314,160 (reference total up to 1.13); app guards the step there, max difference 0.037 |
| Sum check att + def (12 frames × 7140 cells) | min 0.99, max 1.00, cells below the 0.99 convergence level: 0 |
| Point-mirror symmetry (x,y,v → −x,−y,−v) | max |Δ| 0.0e+00 |
| Analytic sanity | attacker standing on target: 1.000; defender on target: 0.000; equidistant midpoint: 0.496 |
| Speed | app 23.4 ms per 1 m surface (Node) vs reference 4.0 s |

Per-scene table: `pc_reference_results.json`.

## PPDA (independent Python recount from events.json)

| Team | Scope | Passes allowed | Defensive actions | PPDA | Identical |
|---|---|---|---|---|---|
| Köln | match | 381 / 381 | 72 / 72 | 5.29 | yes |
| Köln | half 1 | 247 / 247 | 36 / 36 | 6.86 | yes |
| Köln | half 2 | 134 / 134 | 36 / 36 | 3.72 | yes |
| Bayern | match | 292 / 292 | 70 / 70 | 4.17 | yes |
| Bayern | half 1 | 155 / 155 | 35 / 35 | 4.43 | yes |
| Bayern | half 2 | 137 / 137 | 35 / 35 | 3.91 | yes |

Rolling 5-minute windows: 388/388 identical. Definition: opponent open-play passes starting >= 42 m from the pressing team's goal line / pressing team's tackles (player without ball control), interceptions and fouls in the same zone; events without coordinates use the tracked ball position.

## Team shape and line-breaking passes

Independent method: exact dynamic-programming 1-D k-means (globally optimal, k = 3) on outfield depth plus a monotone-chain hull. The app uses the same exact formulation (an earlier Lloyd's-algorithm version matched in only 135/240 team-frames and was replaced).

| Check | Result |
|---|---|
| Team-frames compared | 240 (120 in-play frames × 2 teams) |
| Identical line partition | 240/240 |
| Max abs difference def-line height / length / width / hull | 0.0e+00 m / 0.0e+00 m / 0.0e+00 m / 4.5e-13 m² |
| Line-breaking classification identical | 983/983 passes |
| Through-line passes / through the defensive line | 212 / 56 (Python: 212 / 56) |

## Physical metrics vs the provider's speed column

| Player | Frames | App vs numpy SG max |Δ| | App vs official S: RMSE (m/s) | median |Δ| (m/s) | r |
|---|---|---|---|---|---|
| DFL-OBJ-0002DR | 3000 | 5.0e-05 | 0.046 | 0.014 | 0.9974 |
| DFL-OBJ-0002F5 | 3000 | 5.0e-05 | 0.057 | 0.013 | 0.9990 |
| DFL-OBJ-00012X | 3000 | 5.0e-05 | 0.057 | 0.016 | 0.9988 |
| DFL-OBJ-0028BD | 3000 | 5.0e-05 | 0.044 | 0.013 | 0.9995 |

Whole-match distance (app velocities integrated) / (official speed column integrated): mean 0.9984, range 0.9965–1.0012 over 32 players. Per-player table in `recompute_results.json`.

## Expected threat grid

Own 12×8 grid trained on the open Wyscout event data; compared with the published open grid (Singh 2018): Pearson r = 0.998, MAE = 0.0014, 48 iterations. Details: `xt_training.json`.

## Pass model calibration on this match

P = (1 − lane risk) × control at target, evaluated at the actual end point of each of the 881 open-play passes (723 completed, 158 failed).

| Model P | n | Completion rate |
|---|---|---|
| 0.0–0.2 | 193 | 52% |
| 0.2–0.4 | 69 | 54% |
| 0.4–0.6 | 86 | 77% |
| 0.6–0.8 | 98 | 90% |
| 0.8–1.0 | 435 | 99% |

Mean P: completed 0.713, failed 0.203 (control-only term: 0.831 vs 0.369). Reading: P separates completed from failed passes and is monotone with the completion rate, but it under-predicts below 0.4 (most low-P passes still arrive, e.g. short passes under light pressure), so the app labels it a success score, not a calibrated probability.

## Performance (browser)

Hardware: 2-core Intel(R) Xeon(R) Processor @ 2.90GHz sandbox, headless Chromium via Playwright, 1440×900, 1 m grid (7140 cells). Each test drags a defender across the pitch with real pointer events; every event triggers a worker recomputation.

| Test | Recomputations | Worker compute median / p95 (ms) | Value surface median (ms) | Round trip median / p95 / max (ms) | Updates per s | Render fps during drag |
|---|---|---|---|---|---|---|
| control-1x | 89 | 13.8 / 27.0 | 0.0 | 26.9 / 40.7 / 47.0 | 14.9 | 51.7 |
| value-1x | 89 | 13.2 / 16.4 | 3.7 | 24.1 / 33.2 / 46.2 | 14.9 | 63.7 |
| control-4x | 89 | 13.7 / 24.0 | 0.0 | 105.9 / 127.2 / 157.4 | 4.6 | 14.9 |
| control-1x-sane | 89 | 20.1 / 25.5 | 0.0 | 25.7 / 40.2 / 58.4 | 15.7 | 56.0 |

Round trip = main-thread postMessage → worker compute → result received (includes structured-clone transfer). The 4× test applies Chrome DevTools CPU throttling to the page's main thread. Numbers are from the sandbox CPU, not a laptop; a modern laptop core is faster single-threaded.
