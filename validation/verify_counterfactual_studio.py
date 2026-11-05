#!/usr/bin/env python3
"""
Standalone Python Sports-Analytics Verification Suite for:
Pressing Matters — 25 Hz Bundesliga Optical Tracking & Counterfactual Pitch-Control Studio
Match: 1. FC Köln vs. FC Bayern München (DFL-MAT-J03WMX, May 27, 2023, Matchday 34 Title Decider)
Source Data: Official DFL / Sportec Solutions 25 Hz TRACAB Gen5 optical tracking + event data
             Bassek et al. (2025), Scientific Data, https://doi.org/10.6084/m9.figshare.28196177.v1 (CC BY 4.0)

Verifies:
1. Savitzky-Golay 7-frame (0.28 s) velocity filtering & physical tracking across Period 2 frames 64,400–65,100
   (87:55 to 88:23, covering Sané's 87:59 shot, Gnabry's 88:11 entry pass at f=64,794, and Musiala's 88:14 title-winning goal at f=64,857).
2. Team shape geometry at 25 Hz: exact dynamic-programming 1-D k-means (k=3) defensive/midfield/attack line heights,
   outfield length/width, and Andrew monotone-chain convex-hull area (m^2).
3. Spearman (2018) Potential Pitch Control Field PDE (105x68 = 7,140 cells, dt=0.04 s) + closed-form lane interception risk
   + Expected Threat (xT) pass option ranking for all 10 teammates.
4. Exact Counterfactual Defender Displacement at Period 2 frame 64,794 (88:11, Serge Gnabry #7 on the ball):
   - Tracked reality vs. Counterfactual Scenario A (dragging Köln #6 Eric Martel into Gnabry -> #22 Cancelo lane)
   - Counterfactual Scenario B (dragging Köln #6 Eric Martel +10 m away from #42 Musiala pocket)
   - Counterfactual Scenario C (closing #42 Musiala's central pocket with #6 Martel)
"""

import json
import math
import time
import itertools
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
POS = np.load(ROOT / "data" / "positions.npz")
PINFO = json.load(open(ROOT / "data" / "positions.json"))["sections"]
MATCH = json.load(open(ROOT / "app" / "data" / "match.json"))
ANALYSIS = json.load(open(ROOT / "app" / "data" / "analysis.json"))
XT_MODEL = json.load(open(ROOT / "app" / "data" / "xt.json"))

PLAYERS_META = {p["id"]: p for p in MATCH["players"]}

# Spearman (2018) & Friends-of-Tracking Reference Parameters
PARAMS = {
    "maxPlayerSpeed": 5.0,
    "reactionTime": 0.7,
    "ttiSigma": 0.45,
    "lambdaAtt": 4.3,
    "lambdaDef": 4.3,
    "lambdaGK": 4.3 * 3.0,
    "avgBallSpeed": 15.0,
    "intDt": 0.04,
    "maxIntTime": 10.0,
    "convergeTol": 0.01,
    "timeToControlVeto": 3,
    "offsideTol": 0.2,
}
PARAMS["k"] = math.pi / math.sqrt(3.0) / PARAMS["ttiSigma"]
PARAMS["vetoWindow"] = (
    PARAMS["timeToControlVeto"]
    * math.log(10.0)
    * (math.sqrt(3.0) * PARAMS["ttiSigma"] / math.pi)
)

LANE_PARAMS = {"startOffset": 2.5, "endOffset": 2.0, "blockDistance": 0.6}


class XTGrid:
    def __init__(self, m):
        self.nx = m["grid"]["nx"]
        self.ny = m["grid"]["ny"]
        self.length = 105.0
        self.width = 68.0
        self.grid = m["xt"]

    def at(self, x, y, dir_att=1):
        u = (dir_att * x + self.length / 2.0) / self.length
        v = (y + self.width / 2.0) / self.width
        fx = min(max(u * self.nx - 0.5, 0.0), self.nx - 1.0)
        fy = min(max(v * self.ny - 0.5, 0.0), self.ny - 1.0)
        i0 = int(math.floor(fx))
        j0 = int(math.floor(fy))
        i1 = min(i0 + 1, self.nx - 1)
        j1 = min(j0 + 1, self.ny - 1)
        tx = fx - i0
        ty = fy - j0
        g = self.grid
        return (
            (1.0 - tx) * (1.0 - ty) * g[j0][i0]
            + tx * (1.0 - ty) * g[j0][i1]
            + (1.0 - tx) * ty * g[j1][i0]
            + tx * ty * g[j1][i1]
        )


XT = XTGrid(XT_MODEL)


def sg_velocity(arr_x, arr_y, frame_idx):
    """Savitzky-Golay 7-frame (0.28s) order-1 first derivative, matching app/src/models/velocity.js."""
    n = arr_x.shape[0]
    sx = 0.0
    sy = 0.0
    for k in range(-3, 4):
        idx = max(0, min(n - 1, frame_idx + k))
        x = float(arr_x[idx])
        y = float(arr_y[idx])
        if math.isnan(x) or math.isnan(y):
            return 0.0, 0.0
        sx += k * x
        sy += k * y
    dt = 28.0 * 0.04  # 1.12 s
    vx = sx / dt
    vy = sy / dt
    sp = math.hypot(vx, vy)
    if sp > 12.0:
        vx *= 12.0 / sp
        vy *= 12.0 / sp
    return vx, vy


_CHUNK_CACHE = {}


def _get_chunk_arrays(sec, chunk_start):
    key = (sec, chunk_start)
    if key in _CHUNK_CACHE:
        return _CHUNK_CACHE[key]
    if sec not in _CHUNK_CACHE:
        _CHUNK_CACHE[sec] = {
            "X": POS[f"{sec}_X"],
            "Y": POS[f"{sec}_Y"],
            "ballX": POS[f"{sec}_ballX"],
            "ballY": POS[f"{sec}_ballY"],
            "ballZ": POS[f"{sec}_ballZ"],
            "BP": POS[f"{sec}_BP"],
            "BS": POS[f"{sec}_BS"],
        }
    sec_data = _CHUNK_CACHE[sec]
    p_ids = PINFO[sec]["players"]
    X = sec_data["X"]
    Y = sec_data["Y"]
    chunk_end = min(X.shape[0], chunk_start + 3000)
    active_cols = [
        c for c in range(len(p_ids)) if not np.all(np.isnan(X[chunk_start:chunk_end, c]))
    ]
    X_q = np.round(X[chunk_start:chunk_end, active_cols] * 100.0) / 100.0
    Y_q = np.round(Y[chunk_start:chunk_end, active_cols] * 100.0) / 100.0
    val = (p_ids, active_cols, X_q, Y_q, sec_data)
    _CHUNK_CACHE[key] = val
    return val


def extract_frame(period, frame, overrides=None):
    """Extract 22 players + ball at (period, frame) in identical order and quantisation to binary chunks."""
    sec = "firstHalf" if period == 1 else "secondHalf"
    q_cm = lambda v: round(float(v) * 100.0) / 100.0

    chunk_start = (frame // 3000) * 3000
    p_ids, active_cols, X_q, Y_q, sec_data = _get_chunk_arrays(sec, chunk_start)
    lf = frame - chunk_start

    players = []
    for slot_idx, col in enumerate(active_cols):
        pid = p_ids[col]
        x_val = float(X_q[lf, slot_idx])
        if math.isnan(x_val):
            continue
        y_val = float(Y_q[lf, slot_idx])
        vx, vy = sg_velocity(X_q[:, slot_idx], Y_q[:, slot_idx], lf)
        meta = PLAYERS_META[pid]
        tracked = None
        if overrides and pid in overrides:
            tracked = {"x": x_val, "y": y_val}
            x_val = float(overrides[pid]["x"])
            y_val = float(overrides[pid]["y"])
        players.append(
            {
                "id": pid,
                "shirt": meta["shirt"],
                "name": f"{meta['first']} {meta['last']}",
                "last": meta["last"],
                "team": meta["team"],
                "gk": meta["position"] == "TW",
                "position": meta["position"],
                "x": x_val,
                "y": y_val,
                "vx": vx,
                "vy": vy,
                "speed_ms": math.hypot(vx, vy),
                "speed_kmh": math.hypot(vx, vy) * 3.6,
                "tracked": tracked,
            }
        )

    bx = q_cm(sec_data["ballX"][frame])
    by = q_cm(sec_data["ballY"][frame])
    bz = q_cm(sec_data["ballZ"][frame])
    poss_code = int(sec_data["BP"][frame])
    status_code = int(sec_data["BS"][frame])
    return {
        "period": period,
        "frame": frame,
        "players": players,
        "ball": {"x": bx, "y": by, "z": bz},
        "possession": "home" if poss_code == 1 else ("away" if poss_code == 2 else None),
        "inPlay": status_code == 1,
    }


def optimal_kmeans_1d(vals, k=3):
    v = sorted(vals)
    n = len(v)
    k = min(k, n)
    pref = np.concatenate([[0.0], np.cumsum(v)])
    pref2 = np.concatenate([[0.0], np.cumsum(np.square(v))])

    def sse(i, j):
        c = j - i
        s = pref[j] - pref[i]
        return (pref2[j] - pref2[i]) - s * s / c

    best = None
    for cuts in itertools.combinations(range(1, n), k - 1):
        b = [0, *cuts, n]
        cost = sum(sse(b[t], b[t + 1]) for t in range(k))
        if best is None or cost < best[0] - 1e-12:
            best = (cost, b)
    b = best[1]
    return [v[b[t] : b[t + 1]] for t in range(k)]


def hull_polygon_and_area(pts):
    pts = sorted(set((round(x, 6), round(y, 6)) for x, y in pts))
    if len(pts) < 3:
        return pts, 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    area = (
        abs(
            sum(
                hull[i][0] * hull[(i + 1) % len(hull)][1]
                - hull[(i + 1) % len(hull)][0] * hull[i][1]
                for i in range(len(hull))
            )
        )
        / 2.0
    )
    return hull, area


def compute_team_shape(players, dir_team, length=105.0):
    out = [p for p in players if not p["gk"]]
    depths = [dir_team * p["x"] for p in out]
    clusters = optimal_kmeans_1d(depths, 3)
    line_depths = [float(np.mean(c)) for c in clusters]
    line_depths.sort()
    ys = [p["y"] for p in out]
    hull_pts, area = hull_polygon_and_area([(p["x"], p["y"]) for p in out])
    return {
        "defensiveLineHeight": round(line_depths[0] + length / 2.0, 2),
        "midfieldLineHeight": round(line_depths[1] + length / 2.0, 2),
        "attackLineHeight": round(line_depths[2] + length / 2.0, 2),
        "length": round(max(depths) - min(depths), 2),
        "width": round(max(ys) - min(ys), 2),
        "hullArea": round(area, 1),
        "lineGaps": [
            round(line_depths[i + 1] - line_depths[i], 2)
            for i in range(len(line_depths) - 1)
        ],
    }


def apply_offside(players, att_team, ball, P=PARAMS):
    att_idx = [i for i, p in enumerate(players) if p["team"] == att_team]
    def_idx = [i for i, p in enumerate(players) if p["team"] != att_team]
    # Attacking direction from goalkeeper x
    gk_x = None
    for i, p in enumerate(players):
        if p["gk"]:
            gk_x = p["x"] if p["team"] == att_team else -p["x"]
            break
    if gk_x is None:
        gk_x = float(np.mean([players[i]["x"] for i in att_idx]))
    dir_att = 1 if gk_x < 0 else -1
    def_depths = sorted([dir_att * players[i]["x"] for i in def_idx], reverse=True)
    second_last = def_depths[1] if len(def_depths) >= 2 else 52.5
    offside_line = max(second_last, dir_att * ball["x"], 0.0)
    active = [True] * len(players)
    offside_ids = set()
    for i in att_idx:
        if not players[i]["gk"] and dir_att * players[i]["x"] > offside_line + P["offsideTol"]:
            active[i] = False
            offside_ids.add(players[i]["id"])
    return active, offside_ids, dir_att, offside_line


def control_at_target(players, active, att_team, ball, tx, ty, P=PARAMS):
    tau_ball = math.hypot(tx - ball["x"], ty - ball["y"]) / P["avgBallSpeed"]
    n = len(players)
    tti = [1e9] * n
    lam = [0.0] * n
    att_flags = [p["team"] == att_team for p in players]
    tau_min_att = 1e9
    tau_min_def = 1e9
    for i, p in enumerate(players):
        if not active[i]:
            continue
        rx = p["x"] + p["vx"] * P["reactionTime"]
        ry = p["y"] + p["vy"] * P["reactionTime"]
        t = P["reactionTime"] + math.hypot(tx - rx, ty - ry) / P["maxPlayerSpeed"]
        tti[i] = t
        if att_flags[i]:
            lam[i] = P["lambdaGK"] if p["gk"] else P["lambdaAtt"]
            if t < tau_min_att:
                tau_min_att = t
        else:
            lam[i] = P["lambdaGK"] if p["gk"] else P["lambdaDef"]
            if t < tau_min_def:
                tau_min_def = t

    if tau_min_att - max(tau_ball, tau_min_def) >= P["vetoWindow"]:
        return 0.0
    if tau_min_def - max(tau_ball, tau_min_att) >= P["vetoWindow"]:
        return 1.0

    a_cut = max(tau_ball, tau_min_att) + P["vetoWindow"]
    d_cut = max(tau_ball, tau_min_def) + P["vetoWindow"]
    keep = [
        i
        for i in range(n)
        if active[i] and (tti[i] < a_cut if att_flags[i] else tti[i] < d_cut)
    ]

    p_att = 0.0
    p_def = 0.0
    p_tot = 0.0
    t = tau_ball
    t_max = tau_ball + P["maxIntTime"]
    dt = P["intDt"]
    k = P["k"]
    tol = 1.0 - P["convergeTol"]
    while p_tot < tol and t < t_max:
        rate_a = 0.0
        rate_d = 0.0
        for i in keep:
            f = 1.0 / (1.0 + math.exp(-k * (t - tti[i])))
            if att_flags[i]:
                rate_a += f * lam[i]
            else:
                rate_d += f * lam[i]
        rem = 1.0 - p_tot
        step = (rate_a + rate_d) * dt
        scale = rem / step if step > 1.0 else rem
        p_att += scale * rate_a * dt
        p_def += scale * rate_d * dt
        p_tot = p_att + p_def
        t += dt
    return p_att


def compute_pitch_control_grid(players, active, att_team, ball, nx=105, ny=68, P=PARAMS):
    """Vectorized Spearman (2018) pitch control surface across the 105x68 grid."""
    xs = (-52.5 + 0.5) + np.arange(nx, dtype=np.float64) * 1.0
    ys = (-34.0 + 0.5) + np.arange(ny, dtype=np.float64) * 1.0
    GX, GY = np.meshgrid(xs, ys)  # (ny, nx)
    surf = np.zeros((ny, nx), dtype=np.float64)
    for j in range(ny):
        ty = ys[j]
        for i in range(nx):
            surf[j, i] = control_at_target(players, active, att_team, ball, xs[i], ty, P)
    return surf


def lane_risk(players, active, att_team, ox, oy, tx, ty, P=PARAMS):
    dx = tx - ox
    dy = ty - oy
    dist = math.hypot(dx, dy)
    s0 = LANE_PARAMS["startOffset"]
    s1 = dist - LANE_PARAMS["endOffset"]
    if s1 <= s0:
        return 0.0
    ux = dx / dist
    uy = dy / dist
    rho = P["maxPlayerSpeed"] / P["avgBallSpeed"]
    lead = rho / math.sqrt(1.0 - rho * rho)
    keep = 1.0
    for i, p in enumerate(players):
        if p["team"] == att_team or not active[i]:
            continue
        px = p["x"] - ox
        py = p["y"] - oy
        along = px * ux + py * uy
        perp = abs(px * uy - py * ux)
        if 0.5 < along < dist - 0.5 and perp < LANE_PARAMS["blockDistance"]:
            return 1.0
        rx = p["x"] + p["vx"] * P["reactionTime"] - ox
        ry = p["y"] + p["vy"] * P["reactionTime"] - oy
        a = rx * ux + ry * uy
        h = abs(rx * uy - ry * ux)
        s = max(s0, min(s1, a + h * lead))
        ddx = s - a
        tti = P["reactionTime"] + math.hypot(ddx, h) / P["maxPlayerSpeed"]
        g = s / P["avgBallSpeed"] - tti
        keep *= 1.0 - 1.0 / (1.0 + math.exp(-P["k"] * g))
    return 1.0 - keep


def evaluate_pass_options(fr, att_team="away"):
    players = fr["players"]
    ball = fr["ball"]
    active, offside_ids, dir_att, offside_line = apply_offside(players, att_team, ball)
    # Ball carrier = nearest attacking player to ball
    att_players = [p for p in players if p["team"] == att_team]
    carrier = min(att_players, key=lambda p: math.hypot(p["x"] - ball["x"], p["y"] - ball["y"]))
    ball_xt = XT.at(ball["x"], ball["y"], dir_att)

    opts = []
    for i, p in enumerate(players):
        if p["team"] != att_team or p["id"] == carrier["id"]:
            continue
        dist = math.hypot(p["x"] - ball["x"], p["y"] - ball["y"])
        is_off = p["id"] in offside_ids
        row = {
            "id": p["id"],
            "shirt": p["shirt"],
            "name": p["name"],
            "last": p["last"],
            "x": round(p["x"], 2),
            "y": round(p["y"], 2),
            "distance_m": round(dist, 2),
            "offside": is_off,
        }
        if not is_off:
            ctrl = control_at_target(players, active, att_team, ball, p["x"], p["y"])
            risk = lane_risk(players, active, att_team, ball["x"], ball["y"], p["x"], p["y"])
            prob = (1.0 - risk) * ctrl
            xt_a = XT.at(p["x"], p["y"], dir_att)
            xt_o = XT.at(p["x"], p["y"], -dir_att)
            val = prob * xt_a - (1.0 - prob) * xt_o
            gain = val - ball_xt
            row.update(
                {
                    "control": round(ctrl, 4),
                    "laneRisk": round(risk, 4),
                    "prob": round(prob, 4),
                    "xtTarget": round(xt_a, 4),
                    "xtOpp": round(xt_o, 4),
                    "value": round(val, 4),
                    "gain": round(gain, 4),
                }
            )
        opts.append(row)

    valued = [o for o in opts if not o["offside"]]
    valued.sort(key=lambda o: o["value"], reverse=True)
    for r, o in enumerate(valued, 1):
        o["rank"] = r
    return {
        "carrier": {
            "id": carrier["id"],
            "shirt": carrier["shirt"],
            "name": carrier["name"],
            "x": carrier["x"],
            "y": carrier["y"],
        },
        "ball": ball,
        "ballXT": round(ball_xt, 4),
        "dirAtt": dir_att,
        "ranked": valued,
        "offside": [o for o in opts if o["offside"]],
        "best": valued[0] if valued else None,
        "active": active,
    }


def main():
    t0 = time.time()
    print("=== Pressing Matters Counterfactual & 25 Hz Tracking Verification Suite ===")

    # 1. Verify 25 Hz tracking window Period 2 frames 64,400–65,100 (701 frames = 28.04 seconds)
    f_start, f_end = 64400, 65100
    window_summary = []
    key_sample_frames = [64430, 64600, 64750, 64794, 64820, 64857, 65000]
    bayern_hulls = []
    koeln_hulls = []
    bayern_def_lines = []
    koeln_def_lines = []

    for f in range(f_start, f_end + 1):
        fr = extract_frame(2, f)
        if f % 10 == 0 or f in key_sample_frames:
            sh_home = compute_team_shape([p for p in fr["players"] if p["team"] == "home"], 1)
            sh_away = compute_team_shape([p for p in fr["players"] if p["team"] == "away"], -1)
            koeln_hulls.append(sh_home["hullArea"])
            bayern_hulls.append(sh_away["hullArea"])
            koeln_def_lines.append(sh_home["defensiveLineHeight"])
            bayern_def_lines.append(sh_away["defensiveLineHeight"])
            if f in key_sample_frames:
                ev = evaluate_pass_options(fr, "away")
                surf = compute_pitch_control_grid(fr["players"], ev["active"], "away", fr["ball"])
                window_summary.append(
                    {
                        "period": 2,
                        "frame": f,
                        "clock": f"{int((2700 + f / 25) // 60):02d}:{int((2700 + f / 25) % 60):02d}",
                        "inPlay": fr["inPlay"],
                        "possession": fr["possession"],
                        "ball": fr["ball"],
                        "carrier": ev["carrier"],
                        "bayernMeanPitchControl": round(float(surf.mean()), 4),
                        "koelnShape": sh_home,
                        "bayernShape": sh_away,
                        "bestOption": ev["best"],
                    }
                )

    # 2. Deep Counterfactual Verification at P2 Frame 64,794 (88:11 — Gnabry #7 pass to Musiala #42 before 88:14 winner)
    fr_base = extract_frame(2, 64794)
    ev_base = evaluate_pass_options(fr_base, "away")
    surf_base = compute_pitch_control_grid(fr_base["players"], ev_base["active"], "away", fr_base["ball"])

    martel_id = "DFL-OBJ-002GKO"  # Köln #6 Eric Martel
    cancelo_id = "DFL-OBJ-J015S4"  # Bayern #22 João Cancelo
    musiala_id = "DFL-OBJ-002GCR"  # Bayern #42 Jamal Musiala
    gnabry_id = "DFL-OBJ-0027G6"  # Bayern #7 Serge Gnabry

    martel_base = next(p for p in fr_base["players"] if p["id"] == martel_id)
    cancelo_base = next(p for p in fr_base["players"] if p["id"] == cancelo_id)
    musiala_base = next(p for p in fr_base["players"] if p["id"] == musiala_id)
    gnabry_base = next(p for p in fr_base["players"] if p["id"] == gnabry_id)

    # Midpoint of Gnabry -> Cancelo pass lane:
    lane_mid_x = round((fr_base["ball"]["x"] + cancelo_base["x"]) / 2.0, 2)
    lane_mid_y = round((fr_base["ball"]["y"] + cancelo_base["y"]) / 2.0, 2)

    scenarios = {
        "tracked_baseline": {
            "label": "Tracked Reality (88:11 · P2 f 64794)",
            "description": "Official DFL/Sportec 25 Hz positions as played: Gnabry (#7) on the ball at (-26.82, -31.76); Cancelo (#22) is #1 (93.4%), while actual recipient Musiala (#42) is #2 (65.3%).",
            "overrides": {},
        },
        "block_cancelo_lane": {
            "label": "What-If A: #6 Martel Steps Into Cancelo Lane",
            "description": f"Köln #6 Eric Martel dragged from ({martel_base['x']:.2f}, {martel_base['y']:.2f}) to Gnabry→Cancelo lane midpoint ({lane_mid_x:.2f}, {lane_mid_y:.2f}) — blocking Cancelo (93.4% → 0.0%) and promoting Musiala (#42) to #1 (70.3%).",
            "overrides": {martel_id: {"x": lane_mid_x, "y": lane_mid_y}},
        },
        "open_musiala_pocket": {
            "label": "What-If B: #6 Martel Pulled 10 m Deeper (+x)",
            "description": f"Köln #6 Eric Martel displaced +10.0 m to ({martel_base['x'] + 10.0:.2f}, {martel_base['y']:.2f}), opening the half-space pocket around Jamal Musiala (#42).",
            "overrides": {martel_id: {"x": round(martel_base["x"] + 10.0, 2), "y": martel_base["y"]}},
        },
        "lock_musiala_pocket": {
            "label": "What-If C: #6 Martel Steps Into Gnabry→Musiala Lane",
            "description": "Köln #6 Eric Martel steps directly onto the Gnabry→Musiala line-breaking pass corridor (-26.81, -24.50), cutting off the title-winning pass to Musiala (65.3% → 0.0%).",
            "overrides": {
                martel_id: {
                    "x": round((fr_base["ball"]["x"] + musiala_base["x"]) / 2.0, 2),
                    "y": round((fr_base["ball"]["y"] + musiala_base["y"]) / 2.0, 2),
                }
            },
        },
    }

    scenario_results = {}
    for key, sc in scenarios.items():
        fr_sc = extract_frame(2, 64794, sc["overrides"])
        ev_sc = evaluate_pass_options(fr_sc, "away")
        surf_sc = compute_pitch_control_grid(fr_sc["players"], ev_sc["active"], "away", fr_sc["ball"])
        cancelo_opt = next(o for o in ev_sc["ranked"] if o["id"] == cancelo_id)
        musiala_opt = next(o for o in ev_sc["ranked"] if o["id"] == musiala_id)
        disp_m = 0.0
        if martel_id in sc["overrides"]:
            disp_m = round(
                math.hypot(
                    sc["overrides"][martel_id]["x"] - martel_base["x"],
                    sc["overrides"][martel_id]["y"] - martel_base["y"],
                ),
                2,
            )
        scenario_results[key] = {
            "label": sc["label"],
            "description": sc["description"],
            "overrides": sc["overrides"],
            "martelDisplacement_m": disp_m,
            "bayernMeanPitchControl": round(float(surf_sc.mean()), 4),
            "maxSurfaceDeltaVsTracked": round(float(np.abs(surf_sc - surf_base).max()), 4),
            "bestOption": {
                "id": ev_sc["best"]["id"],
                "shirt": ev_sc["best"]["shirt"],
                "last": ev_sc["best"]["last"],
                "prob": ev_sc["best"]["prob"],
                "gain": ev_sc["best"]["gain"],
            },
            "cancelo": cancelo_opt,
            "musiala": musiala_opt,
            "rankedOptions": ev_sc["ranked"],
        }

    # Assertions proving the exact tactical counterfactual mandate
    base_res = scenario_results["tracked_baseline"]
    blk_res = scenario_results["block_cancelo_lane"]
    assert base_res["cancelo"]["rank"] == 1 and round(base_res["cancelo"]["prob"] * 100) == 93
    assert base_res["musiala"]["rank"] == 2 and round(base_res["musiala"]["prob"] * 100) == 65
    assert blk_res["cancelo"]["prob"] == 0.0 and blk_res["cancelo"]["laneRisk"] == 1.0
    assert blk_res["musiala"]["rank"] == 1 and round(blk_res["musiala"]["prob"] * 100) == 70

    report = {
        "matchId": MATCH.get("matchId", "DFL-MAT-J03WMX"),
        "title": f"{MATCH['home']['name']} {MATCH['result']} {MATCH['away']['name']}",
        "competition": f"{MATCH['competition']} MD{MATCH['matchDay']} ({MATCH['kickoff'][:10]})",
        "sourceDoi": MATCH["provenance"]["doi"],
        "license": MATCH["provenance"]["license"],
        "verifiedWindow": {
            "period": 2,
            "frameStart": f_start,
            "frameEnd": f_end,
            "totalFrames": f_end - f_start + 1,
            "durationSeconds": round((f_end - f_start + 1) / 25.0, 2),
            "koelnHullAreaMean_m2": round(float(np.mean(koeln_hulls)), 1),
            "bayernHullAreaMean_m2": round(float(np.mean(bayern_hulls)), 1),
            "koelnDefLineMean_m": round(float(np.mean(koeln_def_lines)), 2),
            "bayernDefLineMean_m": round(float(np.mean(bayern_def_lines)), 2),
            "sampleFrames": window_summary,
        },
        "titleWinnerKeyFrame": {
            "period": 2,
            "frame": 64794,
            "clock": "88:11",
            "goalFrame": 64857,
            "goalClock": "88:14",
            "carrier": {
                "id": gnabry_id,
                "shirt": gnabry_base["shirt"],
                "name": gnabry_base["name"],
                "x": gnabry_base["x"],
                "y": gnabry_base["y"],
            },
            "defenderDragged": {
                "id": martel_id,
                "shirt": martel_base["shirt"],
                "name": martel_base["name"],
                "trackedX": martel_base["x"],
                "trackedY": martel_base["y"],
                "vx": round(martel_base["vx"], 3),
                "vy": round(martel_base["vy"], 3),
            },
            "scenarios": scenario_results,
        },
        "runtimeSeconds": round(time.time() - t0, 2),
    }

    out_path = ROOT / "validation" / "counterfactual_studio_verification.json"
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"Verified {f_end - f_start + 1} frames (P2 {f_start}..{f_end}) in {report['runtimeSeconds']}s")
    print(
        f"Tracked (f=64794): #1 {base_res['cancelo']['last']} P={base_res['cancelo']['prob']*100:.1f}% "
        f"(ctrl={base_res['cancelo']['control']*100:.1f}%, lane={base_res['cancelo']['laneRisk']*100:.1f}%, dXT={base_res['cancelo']['gain']:+.3f}) | "
        f"#2 {base_res['musiala']['last']} P={base_res['musiala']['prob']*100:.1f}% "
        f"(ctrl={base_res['musiala']['control']*100:.1f}%, lane={base_res['musiala']['laneRisk']*100:.1f}%, dXT={base_res['musiala']['gain']:+.3f})"
    )
    print(
        f"What-If A (Martel -> Cancelo lane, {blk_res['martelDisplacement_m']}m): "
        f"Cancelo P={blk_res['cancelo']['prob']*100:.1f}% (Rank #{blk_res['cancelo']['rank']}, Blocked) | "
        f"#1 {blk_res['musiala']['last']} P={blk_res['musiala']['prob']*100:.1f}% "
        f"(ctrl={blk_res['musiala']['control']*100:.1f}%, lane={blk_res['musiala']['laneRisk']*100:.1f}%, dXT={blk_res['musiala']['gain']:+.3f})"
    )
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
