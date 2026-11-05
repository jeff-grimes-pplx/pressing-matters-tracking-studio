"""Train an Expected Threat (xT) grid from the open Wyscout event dataset (Pappalardo et al. 2019, CC BY 4.0).

Model (Singh 2018): xT(z) = s(z)·g(z) + m(z)·Σ_w T(z→w)·xT(w), iterated to convergence.
  s(z)  share of ball actions from zone z that are shots;  m(z) share that are moves (passes)
  g(z)  goals / shots from z;  T(z→w)  completed moves from z ending in w / all move attempts from z (failed moves terminate the chain)
Grid: 12 columns along the attacking direction x 8 rows (same layout as the widely used open 12x8 grid).
Moves = all Wyscout Pass events (eventId 8, every sub-type incl. crosses); completion = tag 1801.
Shots = Shot events (eventId 10); goal = tag 101. Coordinates are Wyscout percentages, attacking left→right.
"""
import json, sys, time, glob, hashlib
import numpy as np

SRC = "/home/user/workspace/pressing-matters-studio/data/wyscout"
NX, NY = 12, 8
def zone(x, y):
    i = min(max(int(x / 100 * NX), 0), NX - 1); j = min(max(int(y / 100 * NY), 0), NY - 1)
    return i, j

shots = np.zeros((NY, NX)); goals = np.zeros((NY, NX)); moves = np.zeros((NY, NX)); moves_ok = np.zeros((NY, NX))
T = np.zeros((NY, NX, NY, NX))
counts = {"events": 0, "passes": 0, "passes_ok": 0, "shots": 0, "goals": 0, "files": []}
t0 = time.time()
for f in sorted(glob.glob(f"{SRC}/events_*.json")):
    evs = json.load(open(f))
    counts["files"].append({"file": f.split("/")[-1], "events": len(evs)})
    for e in evs:
        counts["events"] += 1
        tags = {t["id"] for t in e.get("tags", [])}
        pos = e.get("positions", [])
        if not pos: continue
        i0, j0 = zone(pos[0]["x"], pos[0]["y"])
        if e["eventId"] == 10:  # shot
            shots[j0, i0] += 1; counts["shots"] += 1
            if 101 in tags: goals[j0, i0] += 1; counts["goals"] += 1
        elif e["eventId"] == 8:  # pass
            moves[j0, i0] += 1; counts["passes"] += 1
            if 1801 in tags and len(pos) > 1:
                i1, j1 = zone(pos[1]["x"], pos[1]["y"])
                moves_ok[j0, i0] += 1; T[j0, i0, j1, i1] += 1; counts["passes_ok"] += 1
    del evs
    print(f, "done", round(time.time() - t0), "s", flush=True)

total = shots + moves
s = np.divide(shots, total, out=np.zeros_like(shots), where=total > 0)
m = np.divide(moves, total, out=np.zeros_like(moves), where=total > 0)
g = np.divide(goals, shots, out=np.zeros_like(goals), where=shots > 0)
Tn = np.divide(T, moves[:, :, None, None], out=np.zeros_like(T), where=moves[:, :, None, None] > 0)  # denominator: ALL move attempts, so failed moves end the chain
xt = np.zeros((NY, NX)); history = []
for it in range(1, 101):
    new = s * g + m * np.einsum("jiwv,wv->ji", Tn, xt)
    delta = float(np.abs(new - xt).max()); xt = new; history.append(delta)
    if it == 5: xt5 = xt.copy()
    if delta < 1e-7: break
print("iterations", it, "final delta", delta)
# comparison with the published open 12x8 grid (not redistributed; fetched for validation only)
ref = np.array(json.load(open(f"{SRC}/open_xt_12x8_v1.json")))
assert ref.shape == (NY, NX)
corr = float(np.corrcoef(ref.ravel(), xt.ravel())[0, 1]); corr5 = float(np.corrcoef(ref.ravel(), xt5.ravel())[0, 1])
mae = float(np.abs(ref - xt).mean()); mae5 = float(np.abs(ref - xt5).mean())
# monotonicity check: xT should increase towards the opponent goal along the centre rows
centre = xt[3:5].mean(0)
mono = bool(np.all(np.diff(centre) >= 0))
out = {
    "model": "Expected Threat (Singh 2018), 12x8 grid, attacking left->right, trained on the open Wyscout event dataset",
    "source": {"dataset": "Pappalardo et al. (2019) Soccer match event dataset, figshare collection 4415000, item 7770599 (events.zip)",
               "license": "CC BY 4.0", "doi": "10.6084/m9.figshare.7770599.v1", "sha256_events_zip": open("/home/user/workspace/pressing-matters-studio/data/wyscout/../sha256.txt").read().split()[0] if False else None},
    "counts": counts, "iterations": it, "convergence": history, "grid": {"nx": NX, "ny": NY},
    "xt": np.round(xt, 6).tolist(), "xt_5iter": np.round(xt5, 6).tolist(),
    "shot_prob": np.round(s, 5).tolist(), "goal_prob": np.round(g, 5).tolist(), "move_prob": np.round(m, 5).tolist(),
    "validation": {"reference": "open_xt_12x8_v1 (Singh, karun.in) fetched 2026-10-14, used only for comparison", "pearson_r_converged": corr, "pearson_r_5iter": corr5,
                   "mae_converged": mae, "mae_5iter": mae5, "centre_rows_non_decreasing_towards_goal": mono,
                   "max_cell": {"ours": float(xt.max()), "reference": float(ref.max())}},
}
json.dump(out, open("/home/user/workspace/pressing-matters-studio/app/data/xt.json", "w"), separators=(",", ":"))
json.dump(out, open("/home/user/workspace/pressing-matters-studio/validation/xt_training.json", "w"), indent=1)
print(json.dumps(out["validation"], indent=1)); print("counts", {k: v for k, v in counts.items() if k != "files"})
np.set_printoptions(precision=3, suppress=True, linewidth=150); print(xt)
