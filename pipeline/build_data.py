"""Build the app data package from the parsed IDSSE match (CC BY 4.0).

Outputs (app/data):
  match.json   metadata: teams, kits, players, periods, chunk index, provenance
  events.json  all match events mapped to tracking frames, pitch-centred metres
  track/pP_CCC.bin  Int16 little-endian tracking chunks (centimetres)
"""
import json, sys, math, struct, hashlib, datetime as dt
import numpy as np
from lxml import etree

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/home/user/workspace/pressing-matters-studio"
DATA = f"{ROOT}/data"; OUT = f"{ROOT}/app/data"
CHUNK = 3000  # frames per chunk (120 s at 25 Hz)
FPS = 25

pos = np.load(f"{DATA}/positions.npz"); pmeta = json.load(open(f"{DATA}/positions.json"))
mi = etree.parse(f"{DATA}/J03WMX_matchinfo.xml").getroot()
gen = mi.find(".//General"); env = mi.find(".//Environment")

teams = {}
players = []
for t in mi.findall(".//Teams/Team"):
    role = "home" if t.get("Role") == "home" else "away"
    teams[role] = {"id": t.get("TeamId"), "name": t.get("TeamName"), "lineup": t.get("LineUp"),
                   "kit": {"main": t.get("PlayerShirtMainColor"), "secondary": t.get("PlayerShirtSecondaryColor"), "number": t.get("PlayerShirtNumberColor"), "type": t.get("PlayerShirtType")}}
    for p in t.findall(".//Player"):
        players.append({"id": p.get("PersonId"), "team": role, "shirt": int(p.get("ShirtNumber")), "first": p.get("FirstName"), "last": p.get("LastName"),
                        "short": p.get("Shortname"), "position": p.get("PlayingPosition"), "starting": p.get("Starting") == "true"})
team_by_id = {teams[r]["id"]: r for r in teams}
player_by_id = {p["id"]: p for p in players}

def parse_time(s):
    return dt.datetime.fromisoformat(s)

periods = []
section_order = [("firstHalf", 1), ("secondHalf", 2)]
for sec, pid in section_order:
    m = pmeta["sections"][sec]
    t0 = parse_time(m["t0"])
    X = pos[f"{sec}_X"]; Y = pos[f"{sec}_Y"]
    slots = m["players"]
    slot_team = [team_by_id[t] for t in m["teams"]]
    # attack direction: which side is the home GK on at kickoff
    gk_home = [i for i, s in enumerate(slots) if slot_team[i] == "home" and player_by_id[s]["position"] == "TW"]
    home_gk_x = float(np.nanmean(X[:250, gk_home[0]]))
    home_attacks_right = home_gk_x < 0
    nf = m["frames"]
    nchunks = math.ceil(nf / CHUNK)
    chunks = []
    for c in range(nchunks):
        a, b = c * CHUNK, min(nf, (c + 1) * CHUNK)
        present = [i for i in range(len(slots)) if np.any(~np.isnan(X[a:b, i]))]
        n = b - a; ns = len(present)
        buf = np.full((n, ns * 2 + 5), -32768, dtype=np.int16)
        for k, i in enumerate(present):
            xs = X[a:b, i]; ys = Y[a:b, i]
            ok = ~np.isnan(xs)
            buf[ok, 2 * k] = np.round(xs[ok] * 100).astype(np.int16)
            buf[ok, 2 * k + 1] = np.round(ys[ok] * 100).astype(np.int16)
        bx = pos[f"{sec}_ballX"][a:b]; by = pos[f"{sec}_ballY"][a:b]; bz = pos[f"{sec}_ballZ"][a:b]
        buf[:, ns * 2] = np.round(np.nan_to_num(bx) * 100); buf[:, ns * 2 + 1] = np.round(np.nan_to_num(by) * 100)
        buf[:, ns * 2 + 2] = np.round(np.clip(np.nan_to_num(bz), 0, 300) * 100)
        buf[:, ns * 2 + 3] = pos[f"{sec}_BS"][a:b]          # 1 = in play
        buf[:, ns * 2 + 4] = pos[f"{sec}_BP"][a:b]          # 1 = home, 2 = away (verified against kick-off events)
        name = f"p{pid}_{c:03d}.bin"
        raw = buf.astype("<i2").tobytes()
        open(f"{OUT}/track/{name}", "wb").write(raw)
        chunks.append({"file": f"track/{name}", "start": a, "frames": n, "slots": [slots[i] for i in present], "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()[:16]})
    periods.append({"id": pid, "section": sec, "firstFrame": m["first_frame"], "frames": nf, "t0": m["t0"], "fps": FPS, "homeAttacksRight": bool(home_attacks_right),
                    "clockOffset": 0 if pid == 1 else 45 * 60, "chunkFrames": CHUNK, "chunks": chunks})
    print(sec, "frames", nf, "chunks", nchunks, "home attacks right:", home_attacks_right)

# ---------------- events ----------------
ev_root = etree.parse(f"{DATA}/J03WMX_events.xml").getroot()
events = []
def frame_for(t, period):
    t0 = parse_time(period["t0"])
    return int(round((parse_time(t) - t0).total_seconds() * FPS))
def period_for(t):
    tt = parse_time(t)
    for p in reversed(periods):
        if tt >= parse_time(p["t0"]) - dt.timedelta(seconds=1):
            return p
    return periods[0]
def conv(x, y):
    if x is None or y is None: return None
    return [round(float(x) - 52.5, 2), round(float(y) - 34.0, 2)]

ATTR_KEEP = {"Evaluation", "Height", "Distance", "Direction", "Recipient", "Player", "Team", "xG", "TypeOfShot", "ChanceEvaluation", "Type", "Winner", "Loser", "WinnerTeam", "LoserTeam",
             "WinnerRole", "PossessionChange", "DefensiveClearance", "Fouler", "TeamFouler", "Fouled", "TeamFouled", "PlayerIn", "PlayerOut", "GameSection", "FinalResult", "Reason",
             "CardColor", "DistanceToGoal", "InsideBox", "CounterAttack", "PlayOrigin", "FromOpenPlay", "Side", "FreeKickLayup", "OneTwo", "BallPossessionPhase", "PlayAngle", "TeamLeft", "TeamRight"}
for e in ev_root.iter("Event"):
    children = list(e)
    if not children or children[0].tag == "Delete":
        continue
    top = children[0]
    kind = top.tag
    # find the innermost action (Play inside set pieces, ShotAtGoal inside Penalty)
    inner = top
    for sub in top.iter():
        if sub.tag in ("Play", "ShotAtGoal"):
            inner = sub; break
    t = e.get("EventTime")
    per = period_for(t)
    fr = frame_for(t, per)
    if e.get("CalculatedFrame"):
        fr = int(e.get("CalculatedFrame")) - per["firstFrame"]
    rec = {"id": e.get("EventId"), "period": per["id"], "frame": fr, "time": t, "kind": kind}
    if inner is not top: rec["action"] = inner.tag
    rec["pos"] = conv(e.get("X-Position"), e.get("Y-Position"))
    if e.get("X-Source-Position") is not None: rec["src"] = conv(e.get("X-Source-Position"), e.get("Y-Source-Position"))
    attrs = {}
    for node in [top, inner] + list(inner):
        for k, v in node.attrib.items():
            if k in ATTR_KEEP and k not in attrs: attrs[k] = v
        if node is not top and node is not inner: attrs.setdefault("sub", node.tag)
    for k in ("Team", "WinnerTeam", "LoserTeam", "TeamFouler", "TeamFouled", "TeamLeft", "TeamRight"):
        if k in attrs and attrs[k] in team_by_id: attrs[k] = team_by_id[attrs[k]]
    rec.update(attrs)
    if kind == "ShotAtGoal" or rec.get("action") == "ShotAtGoal":
        res = [c.tag for c in inner]
        rec["result"] = res[0] if res else None
    events.append(rec)
events.sort(key=lambda r: (r["period"], r["frame"], r["id"]))
print("events", len(events))

# sanity: BallPossession flag vs pass team at pass frames
agree = {1: 0, 2: 0}; tot = 0
for r in events:
    if r.get("action") == "Play" or r["kind"] == "Play":
        sec = periods[r["period"] - 1]["section"]; f = r["frame"]
        if 0 <= f < pmeta["sections"][sec]["frames"]:
            bp = int(pos[f"{sec}_BP"][f]); tot += 1
            if (bp == 1 and r["Team"] == "home") or (bp == 2 and r["Team"] == "away"): agree[1] += 1
            else: agree[2] += 1
print("BallPossession 1=home agreement at pass frames:", agree, "of", tot)

goals = [r for r in events if r.get("result") == "SuccessfulShot"]
print("goals:", [(g["period"], g["frame"], g.get("Player"), g.get("Team"), g.get("xG")) for g in goals])

match = {
    "matchId": gen.get("MatchId"), "competition": gen.get("CompetitionName"), "season": gen.get("Season"), "matchDay": int(gen.get("MatchDay")),
    "kickoff": gen.get("KickoffTime"), "result": gen.get("Result"), "stadium": env.get("StadiumName"), "attendance": int(env.get("NumberOfSpectators")),
    "pitch": {"length": float(env.get("PitchX")), "width": float(env.get("PitchY"))},
    "home": teams["home"], "away": teams["away"], "players": players, "periods": periods,
    "provenance": {
        "dataset": "An integrated dataset of spatiotemporal and event data in elite soccer (IDSSE)",
        "authors": "Bassek, Manuel; Rein, Robert; Weber, Hendrik; Memmert, Daniel (2025)",
        "doi": "10.6084/m9.figshare.28196177.v1", "paper": "https://doi.org/10.1038/s41597-025-04505-y",
        "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "dataOwner": "Deutsche Fußball Liga (DFL); collected by Sportec Solutions (TRACAB Gen5, 25 Hz)",
        "accessed": dt.date.today().isoformat(),
        "sourceFiles": {k: v for k, v in (l.split() [::-1] for l in open(f"{DATA}/sha256.txt").read().strip().splitlines())},
        "modifications": "Positions converted to centimetre Int16 chunks; events mapped to frame numbers; coordinates recentred to the pitch centre."
    }
}
json.dump(match, open(f"{OUT}/match.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(events, open(f"{OUT}/events.json", "w"), ensure_ascii=False, separators=(",", ":"))
import os
print("match.json", os.path.getsize(f"{OUT}/match.json"), "events.json", os.path.getsize(f"{OUT}/events.json"), "track bytes", sum(os.path.getsize(f"{OUT}/track/{f}") for f in os.listdir(f"{OUT}/track")))
