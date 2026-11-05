"""Parse DFL/Sportec position XML (IDSSE dataset, CC BY 4.0) into compact numpy arrays.

Output: positions.npz with, per game section, frame ids, timestamps and per-object
X/Y (metres, pitch-centred coordinates as delivered), plus official D/S/A columns
and ball Z / BallPossession / BallStatus.
"""
import sys, json, time
import numpy as np
from lxml import etree

src = sys.argv[1]
out = sys.argv[2]

t0 = time.time()
sections = {}  # section -> {object_id: {N:[],X:[],Y:[],...}}
meta = {}
context = etree.iterparse(src, events=("start", "end"), huge_tree=True)
cur = None
for ev, el in context:
    if ev == "start" and el.tag == "FrameSet":
        sec = el.get("GameSection"); team = el.get("TeamId"); pid = el.get("PersonId")
        cur = {"section": sec, "team": team, "pid": pid, "N": [], "X": [], "Y": [], "S": [], "A": [], "D": [], "M": [], "T0": None,
               "Z": [], "BP": [], "BS": []}
    elif ev == "end" and el.tag == "Frame" and cur is not None:
        cur["N"].append(int(el.get("N")))
        cur["X"].append(float(el.get("X"))); cur["Y"].append(float(el.get("Y")))
        cur["S"].append(float(el.get("S", "nan"))); cur["A"].append(float(el.get("A", "nan"))); cur["D"].append(float(el.get("D", "nan")))
        cur["M"].append(int(el.get("M", "0")))
        if cur["T0"] is None: cur["T0"] = el.get("T")
        if cur["team"] == "BALL":
            cur["Z"].append(float(el.get("Z", "nan"))); cur["BP"].append(int(el.get("BallPossession", "0"))); cur["BS"].append(int(el.get("BallStatus", "0")))
        el.clear()
    elif ev == "end" and el.tag == "FrameSet":
        sections.setdefault(cur["section"], {})[cur["pid"]] = cur
        cur = None
        el.clear()
    elif ev == "end" and el.tag == "PitchSize":
        meta["pitch"] = (float(el.get("X")), float(el.get("Y")))

print("parsed in", round(time.time() - t0, 1), "s; sections:", list(sections.keys()))
arrays = {}
summary = {"pitch": meta.get("pitch"), "sections": {}}
for sec, objs in sections.items():
    ball = [o for o in objs.values() if o["team"] == "BALL"][0]
    N = np.array(ball["N"], dtype=np.int64)
    n0, n1 = N.min(), N.max()
    assert np.all(np.diff(N) == 1), "ball frames not contiguous"
    nf = n1 - n0 + 1
    players = [o for o in objs.values() if o["team"] not in ("BALL", "referee")]
    pids = [p["pid"] for p in players]
    X = np.full((nf, len(players)), np.nan, dtype=np.float32); Y = X.copy(); S = X.copy(); A = X.copy(); D = X.copy()
    for j, p in enumerate(players):
        idx = np.array(p["N"]) - n0
        X[idx, j] = p["X"]; Y[idx, j] = p["Y"]; S[idx, j] = p["S"]; A[idx, j] = p["A"]; D[idx, j] = p["D"]
    arrays[f"{sec}_N"] = N; arrays[f"{sec}_X"] = X; arrays[f"{sec}_Y"] = Y; arrays[f"{sec}_S"] = S; arrays[f"{sec}_A"] = A; arrays[f"{sec}_D"] = D
    arrays[f"{sec}_ballX"] = np.array(ball["X"], dtype=np.float32); arrays[f"{sec}_ballY"] = np.array(ball["Y"], dtype=np.float32)
    arrays[f"{sec}_ballZ"] = np.array(ball["Z"], dtype=np.float32); arrays[f"{sec}_ballS"] = np.array(ball["S"], dtype=np.float32)
    arrays[f"{sec}_BP"] = np.array(ball["BP"], dtype=np.int8); arrays[f"{sec}_BS"] = np.array(ball["BS"], dtype=np.int8)
    summary["sections"][sec] = {"first_frame": int(n0), "last_frame": int(n1), "frames": int(nf), "t0": ball["T0"], "players": pids,
                                "teams": [p["team"] for p in players], "referees": [o["pid"] for o in objs.values() if o["team"] == "referee"]}
np.savez_compressed(out, **arrays)
json.dump(summary, open(out.replace(".npz", ".json"), "w"), indent=1)
print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "players" and kk != "teams"} for k, v in summary["sections"].items()}, indent=1))
print("done in", round(time.time() - t0, 1), "s")
