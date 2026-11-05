// Passing-option values for the player in possession.
// For teammate j at (xj, yj):
//   C_j = pitch control of the attacking team at (xj, yj) when the ball arrives (Spearman model, ball travel time included)
//   R_j = lane interception risk: probability that a defender reaches the ball's path before the ball does
//   P_j = (1 − R_j) · C_j                                            completion probability of the pass
//   value V_j = P_j · xT_att(xj, yj) − (1 − P_j) · xT_opp(xj, yj)   (a turnover gives the opponent the ball there)
//   gain  ΔV_j = V_j − xT_att(ball)                                  (compared with keeping the ball)
// Offside teammates (reference offside rule) are listed but not valued.
import { controlAtTarget, makeWork, applyOffside } from "./pitchcontrol.js";

export const LANE = Object.freeze({ startOffset: 2.5, endOffset: 2.0, blockDistance: 0.6 });

/**
 * Lane interception risk for a ground pass from (ox, oy) to (tx, ty).
 * For every active defender i with reaction point R_i = position + velocity · reactionTime, the best point to
 * intercept along the lane maximises g(s) = t_ball(s) − tti_i(s) = s / v_ball − reaction − |S(s) − R_i| / v_max.
 * With a = along-lane coordinate of R_i and h = its perpendicular distance, g is maximised exactly at
 * s* = a + h·ρ/√(1 − ρ²), ρ = v_max / v_ball (clamped to the valid part of the lane: `startOffset` after the
 * passer to `endOffset` before the target, which the control term covers). The chance is the same logistic as the
 * pitch-control model, q_i = 1 / (1 + exp(−k·g(s*))). A defender standing within `blockDistance` of the lane
 * blocks it outright (q_i = 1). Defenders combine as independent chances: R = 1 − Π (1 − q_i).
 */
export function laneRisk(scene, ox, oy, tx, ty, P) {
  const dx = tx - ox, dy = ty - oy, dist = Math.sqrt(dx * dx + dy * dy);
  const s0 = LANE.startOffset, s1 = dist - LANE.endOffset;
  if (s1 <= s0) return 0;
  const ux = dx / dist, uy = dy / dist;
  const rho = P.maxPlayerSpeed / P.avgBallSpeed, lead = rho / Math.sqrt(1 - rho * rho);
  let keep = 1;
  for (let i = 0; i < scene.n; i++) {
    if (scene.att[i] || !scene.active[i]) continue;
    const px = scene.x[i] - ox, py = scene.y[i] - oy; const along = px * ux + py * uy, perp = Math.abs(px * uy - py * ux);
    if (along > 0.5 && along < dist - 0.5 && perp < LANE.blockDistance) return 1;   // ball path runs through the defender
    const rx = scene.x[i] + scene.vx[i] * P.reactionTime - ox, ry = scene.y[i] + scene.vy[i] * P.reactionTime - oy;
    const a = rx * ux + ry * uy, h = Math.abs(rx * uy - ry * ux);
    let s = a + h * lead; if (s < s0) s = s0; else if (s > s1) s = s1;
    const ddx = s - a; const tti = P.reactionTime + Math.sqrt(ddx * ddx + h * h) / P.maxPlayerSpeed;
    const g = s / P.avgBallSpeed - tti;
    keep *= 1 - 1 / (1 + Math.exp(-P.k * g));
  }
  return 1 - keep;
}

export function buildScene(players, attTeam, ball, makeScene) {
  const sc = makeScene(players.length);
  players.forEach((p, i) => { sc.x[i] = p.x; sc.y[i] = p.y; sc.vx[i] = p.vx; sc.vy[i] = p.vy; sc.att[i] = p.team === attTeam ? 1 : 0; sc.gk[i] = p.gk ? 1 : 0; sc.active[i] = 1; });
  sc.ballX = ball.x; sc.ballY = ball.y; sc.hasBall = true;
  return sc;
}

/** Nearest attacking player to the ball. */
export function ballCarrier(players, attTeam, ball) {
  let best = null, bd = Infinity;
  for (const p of players) if (p.team === attTeam) { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < bd) { bd = d; best = p; } }
  return best;
}

export function passOptions(players, scene, attTeam, carrierId, xt, dir, P, offsideInfo) {
  const work = makeWork(scene.n);
  const ballXT = xt.at(scene.ballX, scene.ballY, dir);
  const offsideSet = new Set(offsideInfo ? offsideInfo.offside : []);
  const options = [];
  players.forEach((p, i) => {
    if (p.team !== attTeam || p.id === carrierId) return;
    const dist = Math.hypot(p.x - scene.ballX, p.y - scene.ballY);
    const o = { id: p.id, index: i, x: p.x, y: p.y, distance: dist, ballTime: dist / P.avgBallSpeed, offside: offsideSet.has(i) };
    if (!o.offside) {
      const pc = controlAtTarget(scene, p.x, p.y, P, work);
      const risk = laneRisk(scene, scene.ballX, scene.ballY, p.x, p.y, P);
      const prob = (1 - risk) * pc;
      const xtA = xt.at(p.x, p.y, dir), xtO = xt.at(p.x, p.y, -dir);
      o.control = pc; o.laneRisk = risk; o.prob = prob; o.xtTarget = xtA; o.xtOpp = xtO; o.value = prob * xtA - (1 - prob) * xtO; o.gain = o.value - ballXT;
    }
    options.push(o);
  });
  const valued = options.filter(o => !o.offside).sort((a, b) => b.value - a.value);
  valued.forEach((o, r) => { o.rank = r + 1; });
  return { carrierId, ballXT, options, ranked: valued, best: valued[0] || null };
}

/** Pass-value surface for the whole grid given a control surface: V(cell) − xT(ball), with lane risk per cell. */
export function passValueSurface(control, grid, xt, dir, scene, P, out) {
  const surf = out || new Float32Array(control.length);
  const ballX = scene.ballX, ballY = scene.ballY;
  const ballXT = xt.at(ballX, ballY, dir);
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
    const k = j * grid.nx + i, x = grid.x0 + i * grid.dx, y = grid.y0 + j * grid.dy;
    const prob = control[k] * (1 - laneRisk(scene, ballX, ballY, x, y, P));
    surf[k] = prob * xt.at(x, y, dir) - (1 - prob) * xt.at(x, y, -dir) - ballXT;
  }
  return surf;
}
