"""Assemble app/data/validation.json (shown in the Models & data drawer) and validation/VALIDATION.md
from the individual validation outputs. Every number here is produced by a script in this folder."""
import json, datetime
ROOT = "/home/user/workspace/pressing-matters-studio"
ref = json.load(open(f"{ROOT}/validation/pc_reference_results.json"))
js = json.load(open(f"{ROOT}/validation/js_results.json"))
rc = json.load(open(f"{ROOT}/validation/recompute_results.json"))
perf = json.load(open(f"{ROOT}/validation/performance.json"))
xt = json.load(open(f"{ROOT}/validation/xt_training.json"))
cells = 105 * 68
over = sum(r["ref_overshoot_cells"] for r in ref)
pc = {
    "scenes": len(ref), "cells": cells, "totalCells": len(ref) * cells,
    "maxAbsDiff": max(r["max_abs_diff"] for r in ref), "meanAbsDiff": sum(r["mean_abs_diff"] for r in ref) / len(ref),
    "offsideMatch": sum(1 for r in ref if r["offside_match"]),
    "referenceOvershootCells": over, "maxAbsDiffAtOvershoot": max(r["max_abs_diff_at_overshoot"] for r in ref), "referenceTotMax": max(r["ref_tot_max"] for r in ref),
    "jsMs": sum(r["js_ms"] for r in ref) / len(ref), "refMs": sum(r["ref_ms"] for r in ref) / len(ref),
    "sumCheck": {"frames": len(js["checks"]), "minSum": min(c["sumMin"] for c in js["checks"]), "maxSum": max(c["sumMax"] for c in js["checks"]), "cellsBelowConvergence": sum(c["cellsBelowConvergence"] for c in js["checks"])},
    "mirrorMaxDiff": max(c["mirrorMaxDiff"] for c in js["checks"]),
    "sanity": js["sanity"],
    "symmetry": f"sum ∈ [{min(c['sumMin'] for c in js['checks']):.2f}, {max(c['sumMax'] for c in js['checks']):.2f}] on {len(js['checks'])} frames × {cells} cells, mirror max |Δ| = {max(c['mirrorMaxDiff'] for c in js['checks']):.1e}",
}
ppda_ok = all(r["match"] for r in rc["ppda"]["rows"])
ppda = {"rows": rc["ppda"]["rows"], "rollingWindows": rc["ppda"]["rolling_windows"], "rollingMismatches": rc["ppda"]["rolling_mismatches"],
        "summary": f"match and both halves {'identical' if ppda_ok else 'DIFFER'} (Köln {rc['ppda']['rows'][0]['py']['passes']}/{rc['ppda']['rows'][0]['py']['actions']} = {rc['ppda']['rows'][0]['py']['ppda']:.2f}, Bayern {rc['ppda']['rows'][3]['py']['passes']}/{rc['ppda']['rows'][3]['py']['actions']} = {rc['ppda']['rows'][3]['py']['ppda']:.2f}); {rc['ppda']['rolling_windows'] - rc['ppda']['rolling_mismatches']}/{rc['ppda']['rolling_windows']} rolling 5-minute windows identical"}
sh = rc["shape"]; lb = rc["lineBreaks"]
shape = {"frames": sh["frames"], "samePartition": sh["samePartition"], "maxAbsDiff": sh["maxAbsDiff"], "lineBreakPasses": lb["passes"], "lineBreakIdentical": lb["identical"], "throughCount": lb["throughCount"], "defenceLineCount": lb["defenceLineCount"],
         "summary": f"line partition identical in {sh['samePartition']}/{sh['frames']} team-frames (exact DP k-means vs app), def-line height max |Δ| {sh['maxAbsDiff']['defensiveLineHeight']:.1e} m, hull area max |Δ| {sh['maxAbsDiff']['hullArea']:.1e} m²; line-breaking classification identical for {lb['identical']}/{lb['passes']} passes ({lb['throughCount'][0]} through-line passes, {lb['defenceLineCount'][0]} through the defensive line)"}
ph = rc["physical"]; sp = ph["speeds"]
physical = {"speeds": sp, "distanceRatioMean": ph["ratio_mean"], "distanceRatioMin": ph["ratio_min"], "distanceRatioMax": ph["ratio_max"], "players": len(ph["distance"]),
            "summary": f"{len(sp)} players × {sp[0]['frames']} frames: RMSE {min(s['js_vs_official_rmse'] for s in sp):.3f}–{max(s['js_vs_official_rmse'] for s in sp):.3f} m/s, r ≥ {min(s['js_vs_official_corr'] for s in sp):.4f}; whole-match distance from app velocities / from the official speed column = {ph['ratio_mean']:.4f} on average over {len(ph['distance'])} players (range {ph['ratio_min']:.4f}–{ph['ratio_max']:.4f})"}
t1 = next(t for t in perf["tests"] if t["label"] == "control-1x"); tv = next(t for t in perf["tests"] if t["label"] == "value-1x"); t4 = next(t for t in perf["tests"] if t["label"] == "control-4x")
performance = {"cpu": perf["cpu"], "tests": perf["tests"],
               "summary": f"what-if drag on a {perf['cpu']['cores']}-core {perf['cpu']['model'].replace('(R)', '').strip()} sandbox (headless Chromium, 1 m grid, {cells} cells): worker compute median {t1['control']['median']:.0f} ms (p95 {t1['control']['p95']:.0f}), pointer-to-surface round trip median {t1['roundTrip']['median']:.0f} ms, p95 {t1['roundTrip']['p95']:.0f} ms, max {t1['roundTrip']['max']:.0f} ms over {t1['surfacesComputed']} recomputations; pass-value surface adds {tv['value']['median']:.0f} ms; with 4× CPU throttling the round trip is {t4['roundTrip']['median']:.0f} ms median"}
pm = rc["passModel"]
passModel = {**pm, "summary": f"{pm['openPlayPasses']} open-play passes in this match: mean P at the actual end point {pm['meanP_completed']:.3f} for completed vs {pm['meanP_failed']:.3f} for failed passes; real completion rate by P bin: " + ", ".join(f"{c['bin']} → {c['completion']*100:.0f}% (n={c['n']})" for c in pm["calibration"]) + ". P separates completed from failed passes and is monotone with the completion rate, but it under-predicts below 0.4 — a ranking score, not a calibrated probability"}
xtv = {"iterations": xt.get("iterations"), "pearson_r": xt["validation"]["pearson_r_converged"] if "validation" in xt else None, "mae": xt["validation"].get("mae_converged") if "validation" in xt else None}
out = {"generated": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "pitchControl": pc, "ppda": ppda, "shape": shape, "physical": physical, "performance": performance, "passModel": passModel, "xt": xtv}
json.dump(out, open(f"{ROOT}/app/data/validation.json", "w"), indent=1)

# ------------------------------------------------------------------ Markdown
L = []
L.append("# Validation — Pressing Matters (A7)\n")
L.append(f"All numbers below are produced by the scripts in this folder (`run_js.mjs`, `pc_scenes.mjs` + `pc_reference.py`, `recompute.py`, the Playwright drag test → `performance.json`, `build_validation_json.py`). Generated {out['generated']}.\n")
L.append("## Pitch control vs reference implementation\n")
L.append("Reference: `Metrica_PitchControl.py` from Friends-of-Tracking `LaurieOnTracking` (MIT), run unmodified on identical inputs (positions, velocities, ball, GK flags, default parameters, offside rule).\n")
L.append("| Check | Result |\n|---|---|")
L.append(f"| Real scenes compared | {pc['scenes']} (passes, shots, kick-offs) × {cells} cells = {pc['totalCells']:,} cells |")
L.append(f"| Max abs difference (cells where the reference total ≤ 1) | {pc['maxAbsDiff']:.1e} |")
L.append(f"| Mean abs difference | {pc['meanAbsDiff']:.1e} |")
L.append(f"| Offside decisions identical | {pc['offsideMatch']}/{pc['scenes']} scenes |")
L.append(f"| Cells where the reference scheme overshoots (att + def > 1) | {pc['referenceOvershootCells']} of {pc['totalCells']:,} (reference total up to {pc['referenceTotMax']:.2f}); app guards the step there, max difference {pc['maxAbsDiffAtOvershoot']:.3f} |")
L.append(f"| Sum check att + def (12 frames × {cells} cells) | min {pc['sumCheck']['minSum']:.2f}, max {pc['sumCheck']['maxSum']:.2f}, cells below the 0.99 convergence level: {pc['sumCheck']['cellsBelowConvergence']} |")
L.append(f"| Point-mirror symmetry (x,y,v → −x,−y,−v) | max |Δ| {pc['mirrorMaxDiff']:.1e} |")
L.append(f"| Analytic sanity | attacker standing on target: {pc['sanity']['attackerOnTarget']:.3f}; defender on target: {pc['sanity']['defenderOnTarget']:.3f}; equidistant midpoint: {pc['sanity']['midpoint']:.3f} |")
L.append(f"| Speed | app {pc['jsMs']:.1f} ms per 1 m surface (Node) vs reference {pc['refMs']/1000:.1f} s |\n")
L.append("Per-scene table: `pc_reference_results.json`.\n")
L.append("## PPDA (independent Python recount from events.json)\n")
L.append("| Team | Scope | Passes allowed | Defensive actions | PPDA | Identical |\n|---|---|---|---|---|---|")
for r in rc["ppda"]["rows"]:
    L.append(f"| {'Köln' if r['team']=='home' else 'Bayern'} | {r['scope']} | {r['py']['passes']} / {r['js']['passes']} | {r['py']['actions']} / {r['js']['actions']} | {r['py']['ppda']:.2f} | {'yes' if r['match'] else 'NO'} |")
L.append(f"\nRolling 5-minute windows: {rc['ppda']['rolling_windows'] - rc['ppda']['rolling_mismatches']}/{rc['ppda']['rolling_windows']} identical. Definition: {rc['ppda']['definition']}.\n")
L.append("## Team shape and line-breaking passes\n")
L.append(f"Independent method: exact dynamic-programming 1-D k-means (globally optimal, k = 3) on outfield depth plus a monotone-chain hull. The app uses the same exact formulation (an earlier Lloyd's-algorithm version matched in only 135/240 team-frames and was replaced).\n")
L.append("| Check | Result |\n|---|---|")
L.append(f"| Team-frames compared | {sh['frames']} (120 in-play frames × 2 teams) |")
L.append(f"| Identical line partition | {sh['samePartition']}/{sh['frames']} |")
L.append(f"| Max abs difference def-line height / length / width / hull | {sh['maxAbsDiff']['defensiveLineHeight']:.1e} m / {sh['maxAbsDiff']['length']:.1e} m / {sh['maxAbsDiff']['width']:.1e} m / {sh['maxAbsDiff']['hullArea']:.1e} m² |")
L.append(f"| Line-breaking classification identical | {lb['identical']}/{lb['passes']} passes |")
L.append(f"| Through-line passes / through the defensive line | {lb['throughCount'][0]} / {lb['defenceLineCount'][0]} (Python: {lb['throughCount'][1]} / {lb['defenceLineCount'][1]}) |\n")
L.append("## Physical metrics vs the provider's speed column\n")
L.append("| Player | Frames | App vs numpy SG max |Δ| | App vs official S: RMSE (m/s) | median |Δ| (m/s) | r |\n|---|---|---|---|---|---|")
for s in sp:
    L.append(f"| {s['player']} | {s['frames']} | {s['js_vs_py_maxAbs']:.1e} | {s['js_vs_official_rmse']:.3f} | {s['js_vs_official_medianAbs']:.3f} | {s['js_vs_official_corr']:.4f} |")
L.append(f"\nWhole-match distance (app velocities integrated) / (official speed column integrated): mean {ph['ratio_mean']:.4f}, range {ph['ratio_min']:.4f}–{ph['ratio_max']:.4f} over {len(ph['distance'])} players. Per-player table in `recompute_results.json`.\n")
L.append("## Expected threat grid\n")
L.append(f"Own 12×8 grid trained on the open Wyscout event data; compared with the published open grid (Singh 2018): Pearson r = {xtv['pearson_r']:.3f}" + (f", MAE = {xtv['mae']:.4f}" if xtv['mae'] is not None else "") + f", {xtv['iterations']} iterations. Details: `xt_training.json`.\n")
L.append("## Pass model calibration on this match\n")
L.append(f"P = (1 − lane risk) × control at target, evaluated at the actual end point of each of the {pm['openPlayPasses']} open-play passes ({pm['completed']} completed, {pm['failed']} failed).\n")
L.append("| Model P | n | Completion rate |\n|---|---|---|")
for c in pm["calibration"]: L.append(f"| {c['bin']} | {c['n']} | {c['completion']*100:.0f}% |")
L.append(f"\nMean P: completed {pm['meanP_completed']:.3f}, failed {pm['meanP_failed']:.3f} (control-only term: {pm['meanControl_completed']:.3f} vs {pm['meanControl_failed']:.3f}). Reading: P separates completed from failed passes and is monotone with the completion rate, but it under-predicts below 0.4 (most low-P passes still arrive, e.g. short passes under light pressure), so the app labels it a success score, not a calibrated probability.\n")
L.append("## Performance (browser)\n")
L.append(f"Hardware: {perf['cpu']['cores']}-core {perf['cpu']['model'].strip()} sandbox, headless Chromium via Playwright, 1440×900, 1 m grid ({cells} cells). Each test drags a defender across the pitch with real pointer events; every event triggers a worker recomputation.\n")
L.append("| Test | Recomputations | Worker compute median / p95 (ms) | Value surface median (ms) | Round trip median / p95 / max (ms) | Updates per s | Render fps during drag |\n|---|---|---|---|---|---|---|")
for t in perf["tests"]:
    L.append(f"| {t['label']} | {t['surfacesComputed']} | {t['control']['median']:.1f} / {t['control']['p95']:.1f} | {t['value']['median']:.1f} | {t['roundTrip']['median']:.1f} / {t['roundTrip']['p95']:.1f} / {t['roundTrip']['max']:.1f} | {t['updatesPerSecond']:.1f} | {t['fps']:.1f} |")
L.append("\nRound trip = main-thread postMessage → worker compute → result received (includes structured-clone transfer). The 4× test applies Chrome DevTools CPU throttling to the page's main thread. Numbers are from the sandbox CPU, not a laptop; a modern laptop core is faster single-threaded.\n")
open(f"{ROOT}/validation/VALIDATION.md", "w").write("\n".join(L))
print("validation.json + VALIDATION.md written")
