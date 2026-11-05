// Expected Threat lookup over the 12x8 grid trained in pipeline/train_xt.py (open Wyscout data, CC BY 4.0).
// Coordinates: pitch-centred metres; `dir` = +1 if the team in possession attacks towards +x.
// Values are bilinearly interpolated between cell centres so the surface is continuous.
export class XT {
  constructor(model) { this.m = model; this.nx = model.grid.nx; this.ny = model.grid.ny; this.g = model.xt; }
  /** xT for the team attacking in direction `dir` at pitch position (x, y). */
  at(x, y, dir, length = 105, width = 68) {
    const u = (dir * x + length / 2) / length;   // 0 at own goal line, 1 at opponent goal line
    const v = (y + width / 2) / width;           // symmetric model; orientation does not matter
    const fx = Math.min(Math.max(u * this.nx - 0.5, 0), this.nx - 1), fy = Math.min(Math.max(v * this.ny - 0.5, 0), this.ny - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(i0 + 1, this.nx - 1), j1 = Math.min(j0 + 1, this.ny - 1);
    const tx = fx - i0, ty = fy - j0;
    const g = this.g;
    return (1 - tx) * (1 - ty) * g[j0][i0] + tx * (1 - ty) * g[j0][i1] + (1 - tx) * ty * g[j1][i0] + tx * ty * g[j1][i1];
  }
  /** Raw cell value (no interpolation), for tests. */
  cell(i, j) { return this.g[j][i]; }
}
