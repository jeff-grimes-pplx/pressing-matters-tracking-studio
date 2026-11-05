// Surface worker: computes the pitch-control surface (and optionally the pass-value surface) off the main thread.
import { derivedParams, DEFAULT_PARAMS, makeScene, makeGrid, computeSurface } from "./models/pitchcontrol.js";
import { XT } from "./models/xt.js";
import { passValueSurface } from "./models/options.js";

let xt = null; let P = derivedParams(DEFAULT_PARAMS); let grid = makeGrid(105, 68, 1.0);
let control = new Float32Array(grid.nx * grid.ny), value = new Float32Array(grid.nx * grid.ny);

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "init") { xt = new XT(m.xt); P = derivedParams({ ...DEFAULT_PARAMS, ...(m.params || {}) }); grid = makeGrid(m.length || 105, m.width || 68, m.cell || 1.0);
    control = new Float32Array(grid.nx * grid.ny); value = new Float32Array(grid.nx * grid.ny); self.postMessage({ type: "ready", grid }); return; }
  if (m.type === "params") { P = derivedParams({ ...DEFAULT_PARAMS, ...m.params }); return; }
  if (m.type === "grid") { grid = makeGrid(grid.length, grid.width, m.cell); control = new Float32Array(grid.nx * grid.ny); value = new Float32Array(grid.nx * grid.ny); self.postMessage({ type: "ready", grid }); return; }
  if (m.type === "surface") {
    const n = m.x.length; const sc = makeScene(n);
    sc.x.set(m.x); sc.y.set(m.y); sc.vx.set(m.vx); sc.vy.set(m.vy); sc.att.set(m.att); sc.gk.set(m.gk); sc.active.set(m.active);
    sc.ballX = m.ballX; sc.ballY = m.ballY; sc.hasBall = true;
    const t0 = performance.now();
    computeSurface(sc, grid, P, control);
    const tc = performance.now() - t0;
    let tv = 0;
    if (m.wantValue && xt) { const t1 = performance.now(); passValueSurface(control, grid, xt, m.dir, sc, P, value); tv = performance.now() - t1; }
    const outC = control.slice(0), outV = m.wantValue ? value.slice(0) : null;
    self.postMessage({ type: "surface", id: m.id, control: outC, value: outV, msControl: tc, msValue: tv, grid }, outV ? [outC.buffer, outV.buffer] : [outC.buffer]);
  }
};
