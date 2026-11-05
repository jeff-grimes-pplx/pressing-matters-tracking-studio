// JS-side validation exports: sum/symmetry checks, team-shape metrics, line breaks, speeds.
import fs from "node:fs/promises";
import { MatchData, nodeLoader, snapshot, chunkVelocity } from "../app/src/data.js";
import { DEFAULT_PARAMS, derivedParams, makeScene, makeGrid, computeSurface, applyOffside, controlAtTarget, makeWork } from "../app/src/models/pitchcontrol.js";
import { teamShape, lineBreaks } from "../app/src/models/shape.js";
import { buildScene } from "../app/src/models/options.js";

const base = new URL("../app/data", import.meta.url).pathname;
const data = await MatchData.load(base, nodeLoader(base));
const analysis = JSON.parse(await fs.readFile(`${base}/analysis.json`, "utf8"));
const P = derivedParams(DEFAULT_PARAMS); const grid = makeGrid(105, 68, 1.0);
for (const per of data.match.periods) for (let c = 0; c < per.chunks.length; c++) await data.loadChunk(per.id, c);
const dirHome = analysis.dirHome;

// ---- 1. sum and symmetry checks on 12 real frames
const frames = [[1, 11602], [1, 12519], [1, 21707], [1, 31548], [1, 45500], [1, 60000], [2, 5000], [2, 20000], [2, 52615], [2, 63049], [2, 64794], [2, 70000]];
const checks = [];
for (const [p, f] of frames) {
  const snap = snapshot(data, p, f);
  const att = snap.possession || "home";
  const sc = buildScene(snap.players, att, snap.ball, makeScene); applyOffside(sc, P);
  const sAtt = computeSurface(sc, grid, P);
  // sum check within one computation: attacking + defending control must reach the convergence level (>= 0.99) and never exceed 1
  const work = makeWork(sc.n); let minTot = 2, maxTot = 0, cellsBelow = 0;
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
    const a = controlAtTarget(sc, grid.x0 + i * grid.dx, grid.y0 + j * grid.dy, P, work); const tot = a + work.lastDef;
    if (tot < minTot) minTot = tot; if (tot > maxTot) maxTot = tot; if (tot < 1 - P.convergeTol - 1e-9) cellsBelow++;
  }
  const minSum = minTot, maxSum = maxTot, maxDev = Math.max(1 - minTot, maxTot - 1);
  // mirror symmetry: negate all coordinates and velocities, surface must be the point-mirrored surface
  const sc3 = makeScene(sc.n); for (let i = 0; i < sc.n; i++) { sc3.x[i] = -sc.x[i]; sc3.y[i] = -sc.y[i]; sc3.vx[i] = -sc.vx[i]; sc3.vy[i] = -sc.vy[i]; } sc3.att.set(sc.att); sc3.gk.set(sc.gk); sc3.active.set(sc.active); sc3.ballX = -sc.ballX; sc3.ballY = -sc.ballY;
  const sMir = computeSurface(sc3, grid, P); let maxMirror = 0;
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) maxMirror = Math.max(maxMirror, Math.abs(sAtt[j * grid.nx + i] - sMir[(grid.ny - 1 - j) * grid.nx + (grid.nx - 1 - i)]));
  // range
  let lo = 1, hi = 0; for (const v of sAtt) { if (v < lo) lo = v; if (v > hi) hi = v; }
  checks.push({ period: p, frame: f, att, sumMin: +minSum.toFixed(5), sumMax: +maxSum.toFixed(5), cellsBelowConvergence: cellsBelow, mirrorMaxDiff: maxMirror, min: lo, max: hi });
}
// analytic sanity: one attacker standing on the target, nearest defender 30 m away -> control ~1; swapped -> ~0
const toy = makeScene(2); toy.x[0] = 0; toy.y[0] = 0; toy.att[0] = 1; toy.x[1] = 30; toy.y[1] = 0; toy.att[1] = 0; toy.ballX = -10; toy.ballY = 0;
const toyWork = makeWork(2); const toyAtt = controlAtTarget(toy, 0, 0, P, toyWork); const toyFar = controlAtTarget(toy, 30, 0, P, toyWork);
const toyMid = controlAtTarget(toy, 15, 0, P, toyWork);
const sanity = { attackerOnTarget: toyAtt, defenderOnTarget: toyFar, midpoint: toyMid };

// ---- 2. team shape on 200 evenly spaced in-play frames (both teams)
const shapes = [];
for (const per of data.match.periods) for (let f = 500; f < per.frames; f += Math.floor(per.frames / 100)) {
  const snap = snapshot(data, per.id, f); if (!snap.inPlay) continue;
  for (const t of ["home", "away"]) {
    const dir = t === "home" ? dirHome[per.id] : -dirHome[per.id];
    const s = teamShape(snap.players.filter(p => p.team === t), dir);
    shapes.push({ period: per.id, frame: f, team: t, dir, players: snap.players.filter(p => p.team === t).map(p => ({ id: p.id, x: p.x, y: p.y, gk: p.gk })),
      defensiveLineHeight: s.defensiveLineHeight, lastDefenderHeight: s.lastDefenderHeight, length: s.length, width: s.width, hullArea: s.hullArea, lineGaps: s.lineGaps, lines: s.lines.map(l => ({ depth: l.depth, members: l.members.slice().sort(), yMin: l.yMin, yMax: l.yMax })) });
  }
}

// ---- 3. line breaks for every pass: export inputs (defender positions at pass frame) and JS result
const breaks = [];
for (const p of analysis.passes) {
  const snap = snapshot(data, p.period, p.frame); if (!snap) continue;
  const defTeam = p.team === "home" ? "away" : "home"; const dirAtt = p.team === "home" ? dirHome[p.period] : -dirHome[p.period];
  const defShape = teamShape(snap.players.filter(q => q.team === defTeam), -dirAtt);
  const b = lineBreaks(p.start[0], p.start[1], p.end[0], p.end[1], defShape);
  breaks.push({ id: p.id, period: p.period, frame: p.frame, start: p.start, end: p.end, dirDef: -dirAtt, defenders: snap.players.filter(q => q.team === defTeam).map(q => ({ id: q.id, x: q.x, y: q.y, gk: q.gk })), through: b.filter(x => x.through).map(x => x.line).sort(), around: b.filter(x => !x.through).map(x => x.line).sort() });
}

// ---- 4. speeds: JS speed series for 4 players over the first-half chunk 5 (for comparison with the official S column)
const speeds = {};
const chunk = data.chunks.get(data.key(1, 5));
for (const s of [0, 3, 12, 17]) { const id = chunk.slots[s]; const arr = []; for (let f = 0; f < chunk.n; f++) { const [vx, vy] = chunkVelocity(chunk, s, f); arr.push(+Math.sqrt(vx * vx + vy * vy).toFixed(4)); } speeds[id] = arr; }

await fs.writeFile(new URL("./js_results.json", import.meta.url), JSON.stringify({ checks, sanity, shapes, breaks, speeds: { period: 1, chunk: 5, start: chunk.start, data: speeds } }));
console.log("checks", JSON.stringify(checks.map(c => [c.period, c.frame, c.sumMin, c.sumMax, c.cellsBelowConvergence, c.mirrorMaxDiff.toExponential(1)])));
console.log("sanity", JSON.stringify(sanity));
console.log("shapes", shapes.length, "breaks", breaks.length, "line-breaking through", breaks.filter(b => b.through.length).length);
