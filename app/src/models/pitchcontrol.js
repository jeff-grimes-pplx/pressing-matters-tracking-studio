// Pitch control after Spearman (2018), "Beyond Expected Goals" / "Off the ball scoring opportunities",
// following the numerical scheme of the MIT-licensed reference implementation
// (Friends-of-Tracking-Data-FoTD/LaurieOnTracking, Metrica_PitchControl.py).
// All parameters are explicit; the defaults are the reference defaults.

export const DEFAULT_PARAMS = Object.freeze({
  maxPlayerSpeed: 5.0,     // m/s
  reactionTime: 0.7,       // s
  ttiSigma: 0.45,          // s, logistic arrival-time uncertainty
  lambdaAtt: 4.3,          // 1/s ball-control rate, attacking players
  lambdaDef: 4.3,          // 1/s (kappa_def = 1)
  lambdaGK: 12.9,          // 1/s, defending goalkeeper (3 x lambdaDef)
  avgBallSpeed: 15.0,      // m/s
  intDt: 0.04,             // s integration step
  maxIntTime: 10.0,        // s
  convergeTol: 0.01,       // stop when total probability > 0.99
  timeToControlVeto: 3,    // ignore players who cannot plausibly arrive (10^-veto)
  offsides: true,
  offsideTol: 0.2,         // m
});

export function derivedParams(p = DEFAULT_PARAMS) {
  const base = Math.log(10) * p.timeToControlVeto;
  return {
    ...p,
    k: Math.PI / Math.sqrt(3) / p.ttiSigma,
    timeToControlAtt: base * (Math.sqrt(3) * p.ttiSigma / Math.PI + 1 / p.lambdaAtt),
    timeToControlDef: base * (Math.sqrt(3) * p.ttiSigma / Math.PI + 1 / p.lambdaDef),
    nSteps: Math.round(p.maxIntTime / p.intDt) + 1,
  };
}

/**
 * A "scene" is a plain structure describing one instant:
 * { n, x: Float64Array, y, vx, vy, att: Uint8Array (1 = attacking team), gk: Uint8Array, active: Uint8Array,
 *   ballX, ballY, hasBall }
 * `active` lets the caller exclude offside attackers or absent players.
 */
export function makeScene(n) {
  return { n, x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
    att: new Uint8Array(n), gk: new Uint8Array(n), active: new Uint8Array(n).fill(1), ballX: 0, ballY: 0, hasBall: true };
}

/** Attack direction (+1 or -1 along x) of the attacking team, from the defending goalkeeper's side. */
export function attackDirection(scene) {
  for (let i = 0; i < scene.n; i++) if (!scene.att[i] && scene.gk[i] && scene.active[i]) return scene.x[i] > 0 ? 1 : -1;
  // fallback: mean x of defenders
  let s = 0, c = 0; for (let i = 0; i < scene.n; i++) if (!scene.att[i]) { s += scene.x[i]; c++; }
  return s / Math.max(c, 1) > 0 ? 1 : -1;
}

/** Marks offside attackers inactive (reference check_offsides). Returns the offside line x (in attack-direction units). */
export function applyOffside(scene, params) {
  const dir = attackDirection(scene); // defending half sign == dir
  const depths = [];
  for (let i = 0; i < scene.n; i++) if (!scene.att[i] && scene.active[i]) depths.push(dir * scene.x[i]);
  depths.sort((a, b) => b - a);
  const second = depths.length > 1 ? depths[1] : depths[0];
  const ball = scene.hasBall ? dir * scene.ballX : -Infinity;
  const line = Math.max(second, ball, 0) + params.offsideTol;
  const offside = [];
  for (let i = 0; i < scene.n; i++) if (scene.att[i] && scene.active[i] && dir * scene.x[i] > line) { scene.active[i] = 0; offside.push(i); }
  return { line: dir * line, dir, offside };
}

/** Pitch control probability for the attacking team at one target. Also fills per-player cumulative control in `out` (optional). */
export function controlAtTarget(scene, tx, ty, P, work, out) {
  const n = scene.n;
  const tti = work.tti;
  const bdx = tx - scene.ballX, bdy = ty - scene.ballY;
  const ballT = scene.hasBall ? Math.sqrt(bdx * bdx + bdy * bdy) / P.avgBallSpeed : 0;
  let tauAtt = Infinity, tauDef = Infinity;
  for (let i = 0; i < n; i++) {
    if (!scene.active[i]) { tti[i] = Infinity; continue; }
    const rx = scene.x[i] + scene.vx[i] * P.reactionTime, ry = scene.y[i] + scene.vy[i] * P.reactionTime;
    const ddx = tx - rx, ddy = ty - ry;
    const t = P.reactionTime + Math.sqrt(ddx * ddx + ddy * ddy) / P.maxPlayerSpeed;
    tti[i] = t;
    if (scene.att[i]) { if (t < tauAtt) tauAtt = t; } else if (t < tauDef) tauDef = t;
  }
  if (tauAtt - Math.max(ballT, tauDef) >= P.timeToControlDef) { work.lastDef = 1; work.lastTot = 1; return 0; }
  if (tauDef - Math.max(ballT, tauAtt) >= P.timeToControlAtt) { work.lastDef = 0; work.lastTot = 1; return 1; }
  // candidate players
  const idx = work.idx; let m = 0;
  for (let i = 0; i < n; i++) {
    if (!scene.active[i]) continue;
    if (scene.att[i] ? (tti[i] - tauAtt < P.timeToControlAtt) : (tti[i] - tauDef < P.timeToControlDef)) { idx[m++] = i; work.cum[i] = 0; }
  }
  let prevAtt = 0, prevDef = 0, ptot = 0;
  const k = P.k, dt = P.intDt;
  // logistic arrival probability f_i(T) = 1 / (1 + exp(-k (T - tti_i))).
  // exp(-k (T + dt - tti)) = exp(-k (T - tti)) * exp(-k dt): one exp per player per cell, then a multiply per step.
  const e = work.e, decay = Math.exp(-k * dt);
  for (let j = 0; j < m; j++) { const i = idx[j]; e[i] = Math.exp(-k * (ballT - tti[i])); }
  // Explicit Euler step as in the reference. Overshoot guard (not in the reference): when six or more players
  // arrive together, Σ f_i λ_i dt can exceed 1 and the reference scheme pushes the total probability above 1;
  // here the step is scaled so that the total increment never exceeds the remaining free probability.
  const rate = work.rate;
  for (let step = 1; step < P.nSteps && 1 - ptot > P.convergeTol; step++) {
    const free = 1 - prevAtt - prevDef;
    let sa = 0, sd = 0, S = 0;
    for (let j = 0; j < m; j++) {
      const i = idx[j];
      const f = 1 / (1 + e[i]);
      e[i] *= decay;
      const r = f * (scene.att[i] ? P.lambdaAtt : (scene.gk[i] ? P.lambdaGK : P.lambdaDef)) * dt;
      rate[i] = r; S += r; work.cum[i] += free * r;
      if (scene.att[i]) sa += work.cum[i]; else sd += work.cum[i];
    }
    if (S > 1) { // rare: rescale this step so the total increment equals the remaining free probability
      const corr = free * (1 / S - 1); sa = 0; sd = 0;
      for (let j = 0; j < m; j++) { const i = idx[j]; work.cum[i] += corr * rate[i]; if (scene.att[i]) sa += work.cum[i]; else sd += work.cum[i]; }
    }
    prevAtt = sa; prevDef = sd; ptot = sa + sd;
  }
  work.lastDef = prevDef; work.lastTot = ptot;
  if (out) { for (let i = 0; i < n; i++) out[i] = 0; for (let j = 0; j < m; j++) out[idx[j]] = work.cum[idx[j]]; }
  return prevAtt;
}

export function makeWork(n) { return { tti: new Float64Array(n), idx: new Int32Array(n), cum: new Float64Array(n), e: new Float64Array(n), rate: new Float64Array(n), lastDef: 0, lastTot: 0 }; }

/** Grid definition: cell centres, origin at pitch centre. */
export function makeGrid(length = 105, width = 68, cell = 1.0) {
  const nx = Math.round(length / cell), ny = Math.round(width / cell);
  const dx = length / nx, dy = width / ny;
  return { nx, ny, dx, dy, x0: -length / 2 + dx / 2, y0: -width / 2 + dy / 2, length, width };
}

/** Full surface of attacking-team control. Returns Float32Array(ny*nx), row-major (y outer). */
export function computeSurface(scene, grid, P, out) {
  const work = makeWork(scene.n);
  const surf = out || new Float32Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    const ty = grid.y0 + j * grid.dy;
    for (let i = 0; i < grid.nx; i++) surf[j * grid.nx + i] = controlAtTarget(scene, grid.x0 + i * grid.dx, ty, P, work);
  }
  return surf;
}
