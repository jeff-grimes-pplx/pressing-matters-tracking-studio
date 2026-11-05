// Export scenes (positions + velocities) and the JS pitch-control surfaces for reference comparison.
import fs from "node:fs/promises";
import { MatchData, nodeLoader, snapshot } from "../app/src/data.js";
import { DEFAULT_PARAMS, derivedParams, makeScene, makeGrid, computeSurface, applyOffside } from "../app/src/models/pitchcontrol.js";

const base = new URL("../app/data", import.meta.url).pathname;
const data = await MatchData.load(base, nodeLoader(base));
const P = derivedParams(DEFAULT_PARAMS);
const grid = makeGrid(105, 68, 1.0);
// scenes: every shot frame + every 40th open-play pass
const passes = data.events.filter(e => (e.kind === "Play" || e.action === "Play") && e.FromOpenPlay === "true");
const shots = data.events.filter(e => e.kind === "ShotAtGoal" || e.action === "ShotAtGoal");
const picks = [...shots, ...passes.filter((_, i) => i % 40 === 0)];
const scenes = [];
for (const ev of picks) {
  await data.ensure(ev.period, ev.frame, 0);
  const snap = snapshot(data, ev.period, ev.frame);
  if (!snap) continue;
  const attTeam = ev.Team; // team of the event
  const sc = makeScene(snap.players.length);
  snap.players.forEach((p, i) => { sc.x[i] = p.x; sc.y[i] = p.y; sc.vx[i] = p.vx; sc.vy[i] = p.vy; sc.att[i] = p.team === attTeam ? 1 : 0; sc.gk[i] = p.gk ? 1 : 0; });
  sc.ballX = snap.ball.x; sc.ballY = snap.ball.y; sc.hasBall = true;
  const off = applyOffside(sc, P);
  const t0 = performance.now();
  const surf = computeSurface(sc, grid, P);
  const ms = performance.now() - t0;
  scenes.push({ event: ev.id, kind: ev.action || ev.kind, period: ev.period, frame: ev.frame, attTeam, ms,
    players: snap.players.map((p, i) => ({ id: p.id, team: p.team, gk: p.gk, x: p.x, y: p.y, vx: p.vx, vy: p.vy, active: sc.active[i] })),
    ball: snap.ball, offside: off.offside.map(i => snap.players[i].id), surface: Array.from(surf) });
}
await fs.writeFile(new URL("./pc_scenes.json", import.meta.url), JSON.stringify({ params: P, grid, scenes }));
console.log("scenes", scenes.length, "mean ms", (scenes.reduce((a, s) => a + s.ms, 0) / scenes.length).toFixed(1));
