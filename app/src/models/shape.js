// Team shape: defensive/midfield/attacking lines, line height, length, width, compactness.
// Lines = exact 1-D k-means (k = 3) on the outfield players' depth coordinate.
// Depth convention: depth = dir * x, where dir = +1 if the team attacks towards +x; the team's own
// goal line is at depth -length/2, so height-from-own-goal = depth + length/2.

/**
 * Exact 1-D k-means: the globally optimal partition of the values into k clusters minimising the within-cluster
 * sum of squares. In one dimension optimal clusters are contiguous in sorted order, so the optimum is found by
 * dynamic programming over cut points (n <= 11 outfield players, k = 3). Returns a cluster index per value;
 * cluster indices are ordered by increasing value. Deterministic, no initialisation dependence.
 */
export function kmeans1d(values, k) {
  const n = values.length; if (n === 0) return [];
  k = Math.min(k, n);
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const v = order.map(i => values[i]);
  const pref = new Float64Array(n + 1), pref2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pref[i + 1] = pref[i] + v[i]; pref2[i + 1] = pref2[i] + v[i] * v[i]; }
  const sse = (i, j) => { const c = j - i, s = pref[j] - pref[i]; return (pref2[j] - pref2[i]) - s * s / c; }; // values v[i..j)
  // dp[c][j] = minimal cost of splitting v[0..j) into c clusters; cut[c][j] = start index of the last cluster
  const dp = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Int32Array(n + 1));
  dp[0][0] = 0;
  for (let c = 1; c <= k; c++) for (let j = c; j <= n; j++) for (let i = c - 1; i < j; i++) {
    const cost = dp[c - 1][i] + sse(i, j);
    if (cost < dp[c][j] - 1e-12) { dp[c][j] = cost; cut[c][j] = i; }
  }
  const assign = new Array(n).fill(0);
  let j = n; for (let c = k; c >= 1; c--) { const i = cut[c][j]; for (let t = i; t < j; t++) assign[order[t]] = c - 1; j = i; }
  return assign;
}

/** Convex hull polygon and area (m²) by monotone chain. pts: [{x,y}] */
export function hullPolygon(pts) {
  if (pts.length < 3) return [];
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = []; for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function hullArea(pts) {
  const hull = hullPolygon(pts);
  if (hull.length < 3) return 0;
  let a = 0; for (let i = 0; i < hull.length; i++) { const q = hull[i], r = hull[(i + 1) % hull.length]; a += q.x * r.y - r.x * q.y; }
  return Math.abs(a) / 2;
}

const LINE_NAMES = ["defence", "midfield", "attack"];

/**
 * players: [{id, x, y, gk}] of ONE team; dir: attacking direction (+1/-1); length: pitch length.
 * Returns lines (sorted from own goal outwards), metrics in metres.
 */
export function teamShape(players, dir, length = 105) {
  const out = players.filter(p => !p.gk);
  const depths = out.map(p => dir * p.x);
  const k = Math.min(3, out.length);
  const assign = kmeans1d(depths, k);
  const groups = Array.from({ length: k }, () => []);
  out.forEach((p, i) => groups[assign[i]].push(i));
  const lines = groups.filter(g => g.length).map(g => {
    const d = g.map(i => depths[i]); const ys = g.map(i => out[i].y);
    return { depth: d.reduce((a, b) => a + b, 0) / d.length, members: g.map(i => out[i].id), yMin: Math.min(...ys), yMax: Math.max(...ys), count: g.length };
  }).sort((a, b) => a.depth - b.depth);
  lines.forEach((l, i) => { l.name = lines.length === 3 ? LINE_NAMES[i] : `line ${i + 1}`; l.x = dir * l.depth; l.height = l.depth + length / 2; });
  const minD = Math.min(...depths), maxD = Math.max(...depths);
  const ys = out.map(p => p.y);
  const gk = players.find(p => p.gk);
  return {
    dir, lines,
    defensiveLineHeight: lines.length ? lines[0].height : NaN,         // mean height of the deepest line from own goal line
    lastDefenderHeight: out.length ? minD + length / 2 : NaN,          // deepest outfield player
    length: maxD - minD, width: Math.max(...ys) - Math.min(...ys),
    hull: hullPolygon(out), hullArea: hullArea(out), centroid: { x: out.reduce((a, p) => a + p.x, 0) / out.length, y: out.reduce((a, p) => a + p.y, 0) / out.length },
    lineGaps: lines.slice(1).map((l, i) => l.depth - lines[i].depth),
    gkHeight: gk ? dir * gk.x + length / 2 : NaN,
  };
}

/**
 * Line-breaking test for a pass from (x0,y0) to (x1,y1) against the DEFENDING team's shape.
 * The defending team's lines are expressed in its own depth convention (dir_def = -dir_att);
 * a pass "breaks" a line when it starts on the attacking side... i.e. the ball goes from in front of the
 * line to behind it (towards the defending team's own goal) and crosses the line's lateral extent (±margin).
 */
export function lineBreaks(x0, y0, x1, y1, defShape, { margin = 1.0, lateral = 1.0 } = {}) {
  const dir = defShape.dir; // defending team's attacking direction
  const d0 = dir * x0, d1 = dir * x1; // depths in the defending team's convention: smaller = closer to its own goal
  const broken = [];
  for (const l of defShape.lines) {
    if (l.count < 2) continue;
    if (d0 > l.depth + margin && d1 < l.depth - margin) {
      const t = (d0 - l.depth) / (d0 - d1);
      const cy = y0 + t * (y1 - y0);
      const through = cy >= l.yMin - lateral && cy <= l.yMax + lateral;
      broken.push({ line: l.name, crossY: cy, through });
    }
  }
  return broken;
}
