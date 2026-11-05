// Player velocities from 25 Hz positions.
// Savitzky–Golay first-derivative filter, window 7, polynomial order 1 (same smoothing as the
// reference Metrica_Velocities.py: window_length=7, polyorder=1), i.e. a linear least-squares slope
// over ±3 frames: v = Σ_{k=-3..3} k·x[t+k] / (28·dt). Speeds above `maxSpeed` are treated as tracking errors.
export const VELOCITY_PARAMS = Object.freeze({ window: 7, dt: 0.04, maxSpeed: 12 });

export function sgSlope(getter, t, nFrames, dt = 0.04) {
  // getter(i) returns the coordinate at frame i (may be NaN); uses the nearest valid frame at the edges
  let num = 0, den = 0;
  for (let k = -3; k <= 3; k++) {
    let i = t + k; if (i < 0) i = 0; if (i >= nFrames) i = nFrames - 1;
    const v = getter(i);
    if (Number.isNaN(v)) continue;
    num += k * v; den += k * k;
  }
  return den > 0 ? num / (den * dt) : 0;
}

/** Velocity (vx, vy) for one object track at frame t; clamps the speed to maxSpeed. */
export function velocityAt(xs, ys, t, params = VELOCITY_PARAMS) {
  const n = xs.length;
  let vx = sgSlope(i => xs[i], t, n, params.dt), vy = sgSlope(i => ys[i], t, n, params.dt);
  const s = Math.sqrt(vx * vx + vy * vy);
  if (s > params.maxSpeed) { vx *= params.maxSpeed / s; vy *= params.maxSpeed / s; }
  return [vx, vy];
}
