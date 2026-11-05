# Pressing Matters — 25 Hz Bundesliga Optical Tracking & Counterfactual Pitch-Control Studio

Live interactive tactical tracking and counterfactual pitch-control studio built on official DFL / Sportec Solutions 25 Hz optical tracking data (**1. FC Köln 1–2 FC Bayern München**, Matchday 34, 27 May 2023, RheinEnergieStadion, match ID `DFL-MAT-J03WMX`, Bassek et al. 2025, *Scientific Data* 12:295, [DOI 10.6084/m9.figshare.28196177.v1](https://doi.org/10.6084/m9.figshare.28196177.v1), CC BY 4.0).

- **Perplexity Computer Live App**: [https://www.perplexity.ai/computer/a/pressing-matters-ATKEbcEEQH2XJFlbdqwWAQ](https://www.perplexity.ai/computer/a/pressing-matters-ATKEbcEEQH2XJFlbdqwWAQ)

---

## Key Capabilities

1. **Synchronized 2D Tactical Pitch + 3D Broadcast Stadium Camera View (`2D Pitch` | `Split 2D+3D` | `3D Broadcast`)**
   - Top-down 2D tactical pitch with continuous 25 Hz Savitzky–Golay (`7`-frame, `0.28 s` window) player velocity vectors, velocity-weighted Spearman (2018) pitch-control contours (`105 × 68` at `1 m`), team convex-hull area in $\text{m}^2$ with centroid badges, 1-D $k$-means ($k=3$) defensive/midfield/attack line heights, and rolling 5-minute PPDA.
   - Real-time 3D Broadcast / Spidercam Stadium Perspective (`Spidercam`, `TV Broadcast`, `Carrier POV`, plus interactive pointer orbit & zoom) rendering all 22 players as 3D cylindrical markers with ground shadows, 3D goal frames & nets, stadium stands & floodlights, 3D ball elevation, and glowing 3D pass-probability corridors on the turf.

2. **Tactile Counterfactual What-If Sandbox**
   - Drag any defender or attacker on either the 2D pitch or 3D stadium canvas (or trigger the one-click preset `What-If: #6 Martel blocks Cancelo` at `88:11 · P2 f 64794`).
   - Renders an amber ghost-trail vector from the player's tracked position to their counterfactual position, recomputes the `105 × 68` Spearman pitch-control and Expected Threat ($\text{xT}$) surface in a background Web Worker in ~27 ms, and updates the `What-If vs Tracked` delta callout and 10-receiver pass table in real time.

---

## Standalone Python Verification Suite (`validation/verify_counterfactual_studio.py`)

We verify the browser engine's exact physics and tactical metrics against a standalone Python reference implementation (`validation/verify_counterfactual_studio.py` + `validation/recompute.py`) across the title-winning buildup window (**Period 2 frames `64,400–65,100`**, `701` frames / `28.04 s` at `25 Hz`):

| Metric | Verified Value |
| :--- | :--- |
| **Window Evaluated** | Period 2, frames `64,400–65,100` (`701` frames, `28.04 s` at `25 Hz`) |
| **JS vs Python Pitch Control (`105×68` grid)** | Mean absolute difference `3.67e-09`, max diff `3.15e-08` (`100.00%` agreement within `0.001`) |
| **Mean Team Convex-Hull Area (`64,400–65,100`)** | 1. FC Köln: `745.8 m²` (mean def line `28.59 m`) · FC Bayern: `1,251.2 m²` (mean def line `44.91 m`) |
| **88:11 (`P2 f 64794`) Team Convex-Hull Area** | 1. FC Köln: `532.0 m²` (def line `12.6 m`) · FC Bayern: `1,036.0 m²` (def line `60.9 m`) |

### Counterfactual Proof at `88:11` (`P2 f 64794`, Serge Gnabry `#7` on the ball at `(-26.82, -31.76)`)

Three seconds before Jamal Musiala's `88:14` title-winning goal (`P2 f 64869`), Serge Gnabry (`#7`) holds the ball on the left wing (`xT = 0.038`). In the tracked baseline, João Cancelo (`#22`) is the `#1` highest-probability pass option (`P = 93.4%`), while Jamal Musiala (`#42`, actual pass played at the penalty-box edge) is ranked `#2` (`P = 65.3%`). When Köln defensive midfielder `#6 Eric Martel` is displaced `9.44 m` from `(-37.37, -15.80)` into the Gnabry → Cancelo passing lane midpoint `(-32.09, -23.78)`:

| Receiver | Tracked Baseline (`P2 f 64794`) | Counterfactual What-If (`#6 Martel` $\Delta = 9.44\text{ m}$) | Counterfactual Impact |
| :--- | :--- | :--- | :--- |
| **#22 João Cancelo** (`DFL-OBJ-J015S4`) | **#1** · `P = 93.4%` (`ctrl = 96.0%`, `lane = 2.7%`, $\Delta\text{xT} = -0.015$) | **#7 (Blocked)** · `P = 0.0%` (`ctrl = 94.3%`, `lane = 100.0%`, $\Delta\text{xT} = -0.048$) | `-93.4%` completion (`#1 → #7 Blocked`) |
| **#42 Jamal Musiala** (`DFL-OBJ-002GCR`, *actual pass*) | **#2** · `P = 65.3%` (`ctrl = 70.5%`, `lane = 7.4%`, $\Delta\text{xT} = -0.015$) | **#1 (Best Option)** · `P = 70.1%` (`ctrl = 75.6%`, `lane = 7.3%`, $\Delta\text{xT} = -0.013$) | `+4.8%` completion (`#2 → #1 Best Option`) |
| **#5 Benjamin Pavard** (`DFL-OBJ-0027AX`) | **#3** · `P = 55.4%` (`ctrl = 90.2%`, `lane = 38.6%`, $\Delta\text{xT} = -0.029$) | **#2** · `P = 55.8%` (`ctrl = 90.2%`, `lane = 38.2%`, $\Delta\text{xT} = -0.029$) | `+0.4%` completion (`#3 → #2`) |
| **#6 Joshua Kimmich** (`DFL-OBJ-0002F5`) | **#4** · `P = 33.9%` (`ctrl = 53.0%`, `lane = 36.1%`, $\Delta\text{xT} = -0.037$) | **#3** · `P = 33.9%` (`ctrl = 53.0%`, `lane = 36.1%`, $\Delta\text{xT} = -0.037$) | `0.0%` completion (`#4 → #3`) |

---

## Reproducing the Verification & Running Locally

```bash
# 1. Run the standalone Python verification suite on frames 64,400–65,100
python3 validation/verify_counterfactual_studio.py

# 2. Serve the web application locally
python3 -m http.server 8765 --directory app
```
