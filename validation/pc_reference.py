"""Compare the JS pitch-control surfaces with the MIT-licensed reference implementation
(LaurieOnTracking/Metrica_PitchControl.py, run unmodified) on identical inputs."""
import json, sys, time
import numpy as np, pandas as pd
sys.path.insert(0, "/home/user/workspace/pressing-matters-studio/data/ref")
import Metrica_PitchControl as mpc

d = json.load(open("/home/user/workspace/pressing-matters-studio/validation/pc_scenes.json"))
g = d["grid"]; P = d["params"]
params = mpc.default_model_params(P["timeToControlVeto"])
assert abs(params["lambda_gk"] - P["lambdaGK"]) < 1e-9 and params["max_player_speed"] == P["maxPlayerSpeed"]
xs = g["x0"] + np.arange(g["nx"]) * g["dx"]; ys = g["y0"] + np.arange(g["ny"]) * g["dy"]
rows = []
for sc in d["scenes"]:
    att_team = sc["attTeam"]
    def mk(team, name):
        row = {}; gk = None
        for p in sc["players"]:
            if p["team"] != team: continue
            row[f"{name}_{p['id']}_x"] = p["x"]; row[f"{name}_{p['id']}_y"] = p["y"]; row[f"{name}_{p['id']}_vx"] = p["vx"]; row[f"{name}_{p['id']}_vy"] = p["vy"]
            if p["gk"]: gk = p["id"]
        return pd.Series(row), gk
    att_row, att_gk = mk(att_team, "Home")
    def_team = "away" if att_team == "home" else "home"
    def_row, def_gk = mk(def_team, "Away")
    attackers = mpc.initialise_players(att_row, "Home", params, att_gk)
    defenders = mpc.initialise_players(def_row, "Away", params, def_gk)
    ball = np.array([sc["ball"]["x"], sc["ball"]["y"]])
    attackers = mpc.check_offsides(attackers, defenders, ball, (att_gk, def_gk))
    ref_off = sorted(set(p["id"] for p in sc["players"] if p["team"] == att_team) - set(p.id for p in attackers))
    t0 = time.time()
    ref = np.zeros((g["ny"], g["nx"])); ref_tot = np.zeros((g["ny"], g["nx"]))
    for j, ty in enumerate(ys):
        for i, tx in enumerate(xs):
            a, dfd = mpc.calculate_pitch_control_at_target(np.array([tx, ty]), attackers, defenders, ball, params)
            ref[j, i] = a; ref_tot[j, i] = a + dfd
    ms = (time.time() - t0) * 1000
    js = np.array(sc["surface"]).reshape(g["ny"], g["nx"])
    diff = np.abs(js - ref)
    # cells where the reference's explicit Euler step overshoots (attacking + defending probability > 1); the JS
    # implementation guards against this, so differences there are expected and reported separately
    over = ref_tot > 1 + 1e-9
    rows.append({"event": sc["event"], "kind": sc["kind"], "period": sc["period"], "frame": sc["frame"], "offside_js": sorted(sc["offside"]), "offside_ref": ref_off,
                 "offside_match": sorted(sc["offside"]) == ref_off, "max_abs_diff": float(diff[~over].max()), "mean_abs_diff": float(diff[~over].mean()),
                 "ref_overshoot_cells": int(over.sum()), "max_abs_diff_at_overshoot": float(diff[over].max()) if over.any() else 0.0, "ref_tot_max": float(ref_tot.max()),
                 "js_mean": float(js.mean()), "ref_mean": float(ref.mean()), "js_ms": round(sc["ms"], 1), "ref_ms": round(ms)})
    print(rows[-1])
json.dump(rows, open("/home/user/workspace/pressing-matters-studio/validation/pc_reference_results.json", "w"), indent=1)
mx = max(r["max_abs_diff"] for r in rows)
print("SCENES", len(rows), "max abs diff over non-overshoot cells", mx, "overshoot cells", sum(r["ref_overshoot_cells"] for r in rows), "of", len(rows) * g["nx"] * g["ny"], "all offside match", all(r["offside_match"] for r in rows))
