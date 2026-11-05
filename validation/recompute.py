"""Independent recomputation of the app's PPDA, team-shape, line-breaking and physical metrics in Python/numpy
from the same source data (events.json, positions.npz). Shares no code with the JS models: shapes use an exact
dynamic-programming 1-D k-means instead of Lloyd's algorithm, speeds are compared with the provider's official
speed column (S, km/h), PPDA is recounted straight from the event records. Writes recompute_results.json."""
import json, math, itertools
import numpy as np

ROOT = "/home/user/workspace/pressing-matters-studio"
A = json.load(open(f"{ROOT}/app/data/analysis.json"))
EV = json.load(open(f"{ROOT}/app/data/events.json"))
M = json.load(open(f"{ROOT}/app/data/match.json"))
JS = json.load(open(f"{ROOT}/validation/js_results.json"))
POS = np.load(f"{ROOT}/data/positions.npz")
PINFO = json.load(open(f"{ROOT}/data/positions.json"))["sections"]
SECTION = {1: "firstHalf", 2: "secondHalf"}
LENGTH = 105.0
dirHome = {int(k): v for k, v in A["dirHome"].items()}
out = {}

# ---------------------------------------------------------------- PPDA
def ball_at(period, frame):
    s = SECTION[period]
    return float(POS[f"{s}_ballX"][frame]), float(POS[f"{s}_ballY"][frame])

def event_x(e):
    if e.get("pos"): return e["pos"][0]
    return ball_at(e["period"], e["frame"])[0]

def is_open_pass(e): return e["kind"] == "Play" and e.get("FromOpenPlay") == "true"
def is_def_action(e, team):
    k = e["kind"]
    if k == "TacklingGame":
        return (e["WinnerTeam"] if e.get("WinnerRole") == "withoutBallControl" else e["LoserTeam"]) == team
    if k == "BallClaiming": return e.get("Team") == team and e.get("Type") == "InterceptedBall"
    if k == "Foul": return e.get("TeamFouler") == team
    return False

def ppda(team, period=None, frange=None):
    opp = "away" if team == "home" else "home"
    passes = actions = 0
    for e in EV:
        if "period" not in e or e.get("frame") is None: continue
        if period and e["period"] != period: continue
        if frange and not (frange[0] <= e["frame"] <= frange[1]): continue
        d = dirHome[e["period"]] * (1 if team == "home" else -1)
        depth = d * event_x(e) + LENGTH / 2            # distance from the pressing team's own goal line
        if depth < 0.4 * LENGTH: continue
        if is_open_pass(e) and e.get("Team") == opp: passes += 1
        elif is_def_action(e, team): actions += 1
    return {"passes": passes, "actions": actions, "ppda": passes / actions if actions else None}

ppda_rows = []
for team in ("home", "away"):
    mine = ppda(team); js = A["ppda"][team]["match"]
    ppda_rows.append({"team": team, "scope": "match", "py": mine, "js": js, "match": mine == {k: js[k] for k in ("passes", "actions", "ppda")} or (mine["passes"] == js["passes"] and mine["actions"] == js["actions"])})
    for h in (1, 2):
        mine = ppda(team, period=h); js = A["ppda"][team]["halves"][h - 1]
        ppda_rows.append({"team": team, "scope": f"half {h}", "py": mine, "js": js, "match": mine["passes"] == js["passes"] and mine["actions"] == js["actions"]})
# rolling windows
W, S = A["ppda"]["windowFrames"], A["ppda"]["stepFrames"]
roll_mismatch = 0; roll_n = 0
for r in A["ppda"]["rolling"]:
    for team in ("home", "away"):
        mine = ppda(team, period=r["period"], frange=(r["frame"] - W, r["frame"]))
        roll_n += 1
        if mine["passes"] != r[team]["passes"] or mine["actions"] != r[team]["actions"]: roll_mismatch += 1
out["ppda"] = {"rows": ppda_rows, "rolling_windows": roll_n, "rolling_mismatches": roll_mismatch,
               "definition": "opponent open-play passes starting >= 42 m from the pressing team's goal line / pressing team's tackles (player without ball control), interceptions and fouls in the same zone; events without coordinates use the tracked ball position"}
print("PPDA", [(r["team"], r["scope"], r["py"]["passes"], r["js"]["passes"], r["py"]["actions"], r["js"]["actions"], r["match"]) for r in ppda_rows], "rolling mismatches", roll_mismatch, "/", roll_n)

# ---------------------------------------------------------------- team shape (exact 1-D k-means by dynamic programming)
def optimal_kmeans_1d(vals, k):
    """Globally optimal partition of sorted 1-D values into k contiguous clusters minimising within-cluster SSE."""
    v = sorted(vals); n = len(v); k = min(k, n)
    pref = np.concatenate([[0], np.cumsum(v)]); pref2 = np.concatenate([[0], np.cumsum(np.square(v))])
    def sse(i, j):  # values v[i:j]
        c = j - i; s = pref[j] - pref[i]; return (pref2[j] - pref2[i]) - s * s / c
    best = None
    for cuts in itertools.combinations(range(1, n), k - 1):
        b = [0, *cuts, n]; cost = sum(sse(b[t], b[t + 1]) for t in range(k))
        if best is None or cost < best[0] - 1e-12: best = (cost, b)
    b = best[1]
    return [v[b[t]:b[t + 1]] for t in range(k)]

def hull_area(pts):
    pts = sorted(set(map(tuple, pts)))
    if len(pts) < 3: return 0.0
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0: lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0: upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return abs(sum(hull[i][0] * hull[(i + 1) % len(hull)][1] - hull[(i + 1) % len(hull)][0] * hull[i][1] for i in range(len(hull)))) / 2

def shape_py(players, d):
    out_ = [p for p in players if not p["gk"]]
    depths = [d * p["x"] for p in out_]
    by_depth = {}
    for p, dep in zip(out_, depths): by_depth.setdefault(round(dep, 9), []).append(p)
    clusters = optimal_kmeans_1d(depths, 3)
    lines = []
    for cl in clusters:
        members = []
        for dep in cl: members.append(by_depth[round(dep, 9)].pop(0))
        lines.append({"depth": float(np.mean(cl)), "members": sorted(m["id"] for m in members), "yMin": min(m["y"] for m in members), "yMax": max(m["y"] for m in members), "count": len(members)})
    lines.sort(key=lambda l: l["depth"])
    ys = [p["y"] for p in out_]
    return {"defensiveLineHeight": lines[0]["depth"] + LENGTH / 2, "lastDefenderHeight": min(depths) + LENGTH / 2, "length": max(depths) - min(depths),
            "width": max(ys) - min(ys), "hullArea": hull_area([(p["x"], p["y"]) for p in out_]), "lineGaps": [lines[i + 1]["depth"] - lines[i]["depth"] for i in range(len(lines) - 1)], "lines": lines}

shape_rows = []; same_partition = 0; maxdiff = {"defensiveLineHeight": 0, "length": 0, "width": 0, "hullArea": 0}
for s in JS["shapes"]:
    mine = shape_py(s["players"], s["dir"])
    parts_js = [sorted(l["members"]) for l in s["lines"]]; parts_py = [l["members"] for l in mine["lines"]]
    same = parts_js == parts_py; same_partition += same
    for k in maxdiff: maxdiff[k] = max(maxdiff[k], abs(mine[k] - s[k]))
    shape_rows.append({"period": s["period"], "frame": s["frame"], "team": s["team"], "samePartition": same, "defLine": [round(s["defensiveLineHeight"], 2), round(mine["defensiveLineHeight"], 2)],
                       "length": [round(s["length"], 2), round(mine["length"], 2)], "width": [round(s["width"], 2), round(mine["width"], 2)], "hull": [round(s["hullArea"], 1), round(mine["hullArea"], 1)]})
out["shape"] = {"frames": len(shape_rows), "samePartition": same_partition, "maxAbsDiff": maxdiff, "rows": shape_rows,
                "method": "exact dynamic-programming 1-D k-means (k=3) on outfield depth; Andrew monotone-chain hull"}
print("SHAPE frames", len(shape_rows), "same partition", same_partition, "max diffs", maxdiff)

# ---------------------------------------------------------------- line-breaking passes
def breaks_py(b):
    d = b["dirDef"]
    sh = shape_py(b["defenders"], d)
    d0, d1 = d * b["start"][0], d * b["end"][0]
    through, around = [], []
    names = ["defence", "midfield", "attack"] if len(sh["lines"]) == 3 else [f"line {i+1}" for i in range(len(sh["lines"]))]
    for name, l in zip(names, sh["lines"]):
        if l["count"] < 2: continue
        if d0 > l["depth"] + 1.0 and d1 < l["depth"] - 1.0:
            t = (d0 - l["depth"]) / (d0 - d1); cy = b["start"][1] + t * (b["end"][1] - b["start"][1])
            (through if l["yMin"] - 1.0 <= cy <= l["yMax"] + 1.0 else around).append(name)
    return sorted(through), sorted(around)

br_match = 0; br_rows = []
for b in JS["breaks"]:
    t, a = breaks_py(b)
    ok = t == sorted(b["through"]) and a == sorted(b["around"])
    br_match += ok
    if not ok: br_rows.append({"id": b["id"], "period": b["period"], "frame": b["frame"], "js": [b["through"], b["around"]], "py": [t, a]})
n_through_js = sum(1 for b in JS["breaks"] if b["through"]); n_def_js = sum(1 for b in JS["breaks"] if "defence" in b["through"])
n_through_py = sum(1 for b in JS["breaks"] if breaks_py(b)[0]); n_def_py = sum(1 for b in JS["breaks"] if "defence" in breaks_py(b)[0])
out["lineBreaks"] = {"passes": len(JS["breaks"]), "identical": br_match, "mismatches": br_rows, "throughCount": [n_through_js, n_through_py], "defenceLineCount": [n_def_js, n_def_py]}
print("LINE BREAKS identical", br_match, "/", len(JS["breaks"]), "through", n_through_js, n_through_py, "defence", n_def_js, n_def_py, "mismatches", len(br_rows))

# ---------------------------------------------------------------- speeds vs the official S column (km/h), and vs JS velocities
sp = JS["speeds"]; sec = SECTION[sp["period"]]; start = sp["start"]
players = PINFO[sec]["players"]
X, Y, S = POS[f"{sec}_X"], POS[f"{sec}_Y"], POS[f"{sec}_S"]
speed_rows = []
for pid, js_speed in sp["data"].items():
    col = players.index(pid); n = len(js_speed)
    x = X[start:start + n, col].astype(float); y = Y[start:start + n, col].astype(float)
    # independent Savitzky–Golay derivative: least-squares slope over a 7-frame window (numpy), edges by clamped index
    k = np.arange(-3, 4)
    idx = np.clip(np.arange(n)[:, None] + k[None, :], 0, n - 1)
    vx = (x[idx] * k).sum(1) / (28 * 0.04); vy = (y[idx] * k).sum(1) / (28 * 0.04)
    v_py = np.minimum(np.hypot(vx, vy), 12.0)
    v_js = np.array(js_speed); v_off = S[start:start + n, col].astype(float) / 3.6
    ok = ~np.isnan(v_off) & ~np.isnan(v_js)
    speed_rows.append({"player": pid, "frames": int(ok.sum()), "js_vs_py_maxAbs": float(np.nanmax(np.abs(v_js - v_py))),
                       "js_vs_official_rmse": float(np.sqrt(np.mean((v_js[ok] - v_off[ok]) ** 2))), "js_vs_official_medianAbs": float(np.median(np.abs(v_js[ok] - v_off[ok]))),
                       "js_vs_official_corr": float(np.corrcoef(v_js[ok], v_off[ok])[0, 1]), "mean_js": float(v_js[ok].mean()), "mean_official": float(v_off[ok].mean())})
print("SPEEDS", [(r["player"][-6:], round(r["js_vs_py_maxAbs"], 4), round(r["js_vs_official_rmse"], 3), round(r["js_vs_official_corr"], 4)) for r in speed_rows])

# total distance per player from the official speed column vs the app's integrated distance
dist_rows = []
for pid, ph in A["physical"].items():
    total = 0.0; frames = 0
    for per in (1, 2):
        sec = SECTION[per]; pl = PINFO[sec]["players"]
        if pid not in pl: continue
        s = POS[f"{sec}_S"][:, pl.index(pid)].astype(float) / 3.6
        s = s[~np.isnan(s)]; total += s.sum() * 0.04; frames += len(s)
    dist_rows.append({"player": pid, "frames_official": frames, "frames_js": ph["frames"], "km_official": round(total / 1000, 3), "km_js": round(ph["distance"] / 1000, 3), "ratio": round(ph["distance"] / total, 4) if total else None})
ratios = [r["ratio"] for r in dist_rows if r["ratio"]]
out["physical"] = {"speeds": speed_rows, "distance": dist_rows, "ratio_mean": float(np.mean(ratios)), "ratio_min": float(np.min(ratios)), "ratio_max": float(np.max(ratios)),
                   "note": "official S column (km/h) from the provider; app speeds are a 7-frame Savitzky–Golay derivative of positions, clamped at 12 m/s"}
print("DISTANCE ratio js/official mean %.4f min %.4f max %.4f" % (out["physical"]["ratio_mean"], out["physical"]["ratio_min"], out["physical"]["ratio_max"]))

# ---------------------------------------------------------------- pass model calibration on this match
ps = [p for p in A["passes"] if p.get("openPlay") and p.get("endProb") is not None]
ok = [p for p in ps if p["success"]]; bad = [p for p in ps if not p["success"]]
bins = [0, 0.2, 0.4, 0.6, 0.8, 1.01]; cal = []
for i in range(5):
    b = [p for p in ps if bins[i] <= p["endProb"] < bins[i + 1]]
    if b: cal.append({"bin": f"{bins[i]:.1f}–{min(bins[i+1],1):.1f}", "n": len(b), "completion": round(sum(p["success"] for p in b) / len(b), 3)})
out["passModel"] = {"openPlayPasses": len(ps), "completed": len(ok), "failed": len(bad), "meanP_completed": round(float(np.mean([p["endProb"] for p in ok])), 3), "meanP_failed": round(float(np.mean([p["endProb"] for p in bad])), 3),
                    "meanControl_completed": round(float(np.mean([p["endControl"] for p in ok])), 3), "meanControl_failed": round(float(np.mean([p["endControl"] for p in bad])), 3), "calibration": cal}
print("PASS MODEL", out["passModel"])

json.dump(out, open(f"{ROOT}/validation/recompute_results.json", "w"), indent=1)
print("written recompute_results.json")
