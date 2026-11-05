// 3D Broadcast / Spidercam Stadium Perspective Renderer for Pressing Matters Studio.
// Synchronized at 60 fps with the 25 Hz optical tracking frame, Spearman (2018) pitch-control surface,
// glowing 3D pass-probability corridors, team convex hulls, and interactive 3D counterfactual defender dragging.

import { COLORS, roundRect } from "./render.js";

const DEG = Math.PI / 180;

export class Pitch3DRenderer {
  constructor(canvas, pitch) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.L = pitch.length; // 105 m
    this.W = pitch.width;  // 68 m
    this.dpr = 1;
    this.cssW = 800;
    this.cssH = 600;

    // Camera state: spherical orbit around target (tx, ty, tz)
    // World coordinates: x in [-52.5, +52.5] (left-right), y in [-34, +34] (bottom-top), z >= 0 (height in metres)
    this.preset = "spidercam"; // 'spidercam' | 'broadcast' | 'carrier'
    this.cam = {
      yaw: -32 * DEG,     // horizontal angle around Z axis (0 = looking from -y south stand towards +y north stand)
      pitch: 36 * DEG,    // elevation angle above turf plane
      dist: 84,           // camera distance from target (metres)
      fov: 42 * DEG,      // vertical field of view
      tx: -14,            // look-at target x (metres)
      ty: -8,             // look-at target y (metres)
      tz: 0.8,            // look-at target z (metres)
    };
    this.userOrbited = false;
    this._basis = null;
    this._updateBasis();
  }

  resize(cssW, cssH, dpr = window.devicePixelRatio || 1) {
    this.dpr = dpr;
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.canvas.style.width = this.cssW + "px";
    this.canvas.style.height = this.cssH + "px";
    this._updateBasis();
  }

  setPreset(preset, frameData = null, analysis = null, immediate = true) {
    this.preset = preset;
    this.userOrbited = false;
    this.syncCameraToPlay(frameData, analysis, immediate ? 1.0 : 0.14);
  }

  orbit(dYaw, dPitch) {
    this.userOrbited = true;
    this.cam.yaw += dYaw;
    this.cam.pitch = Math.max(16 * DEG, Math.min(72 * DEG, this.cam.pitch + dPitch));
    this._updateBasis();
  }

  zoom(factor) {
    this.cam.dist = Math.max(38, Math.min(145, this.cam.dist * factor));
    this._updateBasis();
  }

  syncCameraToPlay(fr, an, alpha = 0.12) {
    if (!fr) return;
    const bx = Number.isFinite(fr.ball?.x) ? fr.ball.x : 0;
    const by = Number.isFinite(fr.ball?.y) ? fr.ball.y : 0;
    const carrier = an?.carrier || null;
    const dir = an?.dir || -1;

    let goalYaw = this.cam.yaw;
    let goalPitch = this.cam.pitch;
    let goalDist = this.cam.dist;
    let goalTx = this.cam.tx;
    let goalTy = this.cam.ty;
    let goalTz = 0.6;

    if (this.preset === "broadcast") {
      goalYaw = 0;
      goalPitch = 33 * DEG;
      goalDist = 92;
      goalTx = Math.max(-22, Math.min(22, bx * 0.55));
      goalTy = Math.max(-8, Math.min(8, by * 0.25));
    } else if (this.preset === "carrier") {
      const cx = carrier ? carrier.x : bx;
      const cy = carrier ? carrier.y : by;
      // Look from behind the ball carrier toward the attacking goal & central passing options
      const aimX = dir * 34;
      const aimY = cy * 0.35;
      const lookAngle = Math.atan2(aimY - cy, aimX - cx);
      goalYaw = lookAngle - Math.PI / 2;
      goalPitch = 25 * DEG;
      goalDist = 48;
      goalTx = cx * 0.65 + aimX * 0.35;
      goalTy = cy * 0.65 + aimY * 0.35;
      goalTz = 0.9;
    } else {
      // 'spidercam': elevated diagonal tactical stadium angle framing the active half
      goalYaw = (dir < 0 ? -34 : 34) * DEG;
      goalPitch = 37 * DEG;
      goalDist = 76;
      goalTx = Math.max(-28, Math.min(28, bx * 0.62));
      goalTy = Math.max(-14, Math.min(14, by * 0.45));
    }

    const lerp = (a, b, t) => a + (b - a) * t;
    if (!this.userOrbited) {
      this.cam.yaw = lerp(this.cam.yaw, goalYaw, alpha);
      this.cam.pitch = lerp(this.cam.pitch, goalPitch, alpha);
      this.cam.dist = lerp(this.cam.dist, goalDist, alpha);
    }
    this.cam.tx = lerp(this.cam.tx, goalTx, alpha);
    this.cam.ty = lerp(this.cam.ty, goalTy, alpha);
    this.cam.tz = lerp(this.cam.tz, goalTz, alpha);
    this._updateBasis();
  }

  _updateBasis() {
    const { yaw, pitch, dist, fov, tx, ty, tz } = this.cam;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // Forward vector (from camera to target): when yaw=0, camera is at -y looking towards +y
    const fx = -sy * cp;
    const fy = cy * cp;
    const fz = -sp;
    const cx = tx - fx * dist;
    const camY = ty - fy * dist;
    const cz = tz - fz * dist;
    // Right vector = normalize(F x WorldUp(0,0,1))
    const rx = cy;
    const ry = sy;
    const rz = 0;
    // Up vector = R x F
    const ux = -sy * sp;
    const uy = cy * sp;
    const uz = cp;
    const focal = (this.cssH * 0.5) / Math.tan(fov * 0.5);
    this._basis = { cx, cy: camY, cz, fx, fy, fz, rx, ry, rz, ux, uy, uz, focal };
  }

  /** Project 3D world point (x, y, z) -> [sx, sy, depth, scale] in CSS pixels. Returns null if behind near plane. */
  project(x, y, z = 0) {
    const b = this._basis;
    const dx = x - b.cx, dy = y - b.cy, dz = z - b.cz;
    const zCam = dx * b.fx + dy * b.fy + dz * b.fz;
    if (zCam < 2.0) return null;
    const xCam = dx * b.rx + dy * b.ry + dz * b.rz;
    const yCam = dx * b.ux + dy * b.uy + dz * b.uz;
    const s = b.focal / zCam;
    return [this.cssW * 0.5 + xCam * s, this.cssH * 0.5 - yCam * s, zCam, s];
  }

  /** Unproject CSS pixel (px, py) onto the z = planeZ horizontal plane -> [wx, wy] in metres. */
  screenToWorld(px, py, planeZ = 0) {
    const b = this._basis;
    const ndcX = (px - this.cssW * 0.5) / b.focal;
    const ndcY = (this.cssH * 0.5 - py) / b.focal;
    const dirX = b.fx + ndcX * b.rx + ndcY * b.ux;
    const dirY = b.fy + ndcX * b.ry + ndcY * b.uy;
    const dirZ = b.fz + ndcX * b.rz + ndcY * b.uz;
    if (Math.abs(dirZ) < 1e-5) return [0, 0];
    const t = (planeZ - b.cz) / dirZ;
    if (t <= 0) return [0, 0];
    return [b.cx + dirX * t, b.cy + dirY * t];
  }

  /** Hit-test 3D player figures in screen space (checks both ground disc and upper torso badge). */
  playerAt(px, py, players) {
    if (!players) return null;
    let best = null, bestD = Infinity;
    for (const p of players) {
      const g = this.project(p.x, p.y, 0);
      const h = this.project(p.x, p.y, 1.65);
      if (!g || !h) continue;
      const hitR = Math.max(14, g[3] * 1.45);
      const dFoot = Math.hypot(px - g[0], py - g[1]);
      const dHead = Math.hypot(px - h[0], py - h[1]);
      const dMid = Math.hypot(px - (g[0] + h[0]) * 0.5, py - (g[1] + h[1]) * 0.5);
      const d = Math.min(dFoot, dHead, dMid);
      if (d < hitR && d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  _drawPoly3D(ctx, pts3d, close = true) {
    let started = false;
    ctx.beginPath();
    for (const pt of pts3d) {
      const p = this.project(pt[0], pt[1], pt[2] || 0);
      if (!p) continue;
      if (!started) {
        ctx.moveTo(p[0], p[1]);
        started = true;
      } else {
        ctx.lineTo(p[0], p[1]);
      }
    }
    if (close && started) ctx.closePath();
    return started;
  }

  _strokeSegmentSubdivided(ctx, x0, y0, z0, x1, y1, z1, steps = 8) {
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = this.project(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t);
      if (!p) continue;
      if (!started) {
        ctx.moveTo(p[0], p[1]);
        started = true;
      } else {
        ctx.lineTo(p[0], p[1]);
      }
    }
  }

  renderScene(fr, an, state, shirts, names) {
    this.syncCameraToPlay(fr, an, 0.16);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 1. Night stadium atmosphere & floodlights
    const bgGrad = ctx.createLinearGradient(0, 0, 0, this.cssH);
    bgGrad.addColorStop(0, "#05080c");
    bgGrad.addColorStop(0.35, "#091219");
    bgGrad.addColorStop(1, "#09130e");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    this._drawStadiumBowl(ctx);
    this._drawTurfAndMarkings(ctx, state, an);

    // 2. Team shape & convex hull on 3D turf
    if (state.showShape && an.shapes) {
      this._drawShape3D(ctx, an.shapes.home, "home");
      this._drawShape3D(ctx, an.shapes.away, "away");
    }

    // 3. Glowing 3D pass-probability corridors & lofted trajectory arcs
    if (an.options && fr.inPlay) {
      this._drawOptions3D(ctx, an.options, an.origin, fr.players, an.showPass ? { recipient: an.pass.recipient } : null, names, state.whatIf.size > 0);
    }

    // 4. Counterfactual ghost trails on the 3D turf
    for (const p of fr.players) {
      if (p.tracked) {
        this._drawGhostTrail3D(ctx, p.tracked, p, shirts.get(p.id), names.get(p.id));
      }
    }

    // 5. Depth-sorted 3D players, ghosts, and ball
    this._drawEntities3D(ctx, fr, an, state, shirts, names);

    ctx.restore();
  }

  _drawStadiumBowl(ctx) {
    const { L, W } = this;
    const padX = 8.5, padY = 6.5;
    // Outer pitch apron (dark tartan/concrete track perimeter)
    ctx.save();
    if (
      this._drawPoly3D(ctx, [
        [-L / 2 - padX, -W / 2 - padY, -0.05],
        [L / 2 + padX, -W / 2 - padY, -0.05],
        [L / 2 + padX, W / 2 + padY, -0.05],
        [-L / 2 - padX, W / 2 + padY, -0.05],
      ])
    ) {
      ctx.fillStyle = "#0d1713";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // LED perimeter advertising boards (z = 0 to 1.05 m)
    const boards = [
      [[-L / 2 - 3.2, W / 2 + 2.6], [L / 2 + 3.2, W / 2 + 2.6]],
      [[-L / 2 - 3.2, -W / 2 - 2.6], [-L / 2 - 3.2, W / 2 + 2.6]],
      [[L / 2 + 3.2, -W / 2 - 2.6], [L / 2 + 3.2, W / 2 + 2.6]],
    ];
    for (const [[ax, ay], [bx, by]] of boards) {
      if (
        this._drawPoly3D(ctx, [
          [ax, ay, 0],
          [bx, by, 0],
          [bx, by, 1.05],
          [ax, ay, 1.05],
        ])
      ) {
        ctx.fillStyle = "rgba(18, 26, 36, 0.85)";
        ctx.fill();
        ctx.strokeStyle = "rgba(120, 175, 255, 0.24)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Subtle floodlight glow cones at the 4 stadium corners
    const towers = [
      [-L / 2 - 14, W / 2 + 12, 26],
      [L / 2 + 14, W / 2 + 12, 26],
      [-L / 2 - 14, -W / 2 - 12, 26],
      [L / 2 + 14, -W / 2 - 12, 26],
    ];
    for (const [tx, ty, tz] of towers) {
      const p = this.project(tx, ty, tz);
      if (!p) continue;
      const r = Math.max(40, Math.min(180, p[3] * 18));
      const g = ctx.createRadialGradient(p[0], p[1], 1, p[0], p[1], r);
      g.addColorStop(0, "rgba(235, 245, 255, 0.26)");
      g.addColorStop(0.3, "rgba(180, 215, 255, 0.08)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawTurfAndMarkings(ctx, state, an) {
    const { L, W } = this;
    // 10 mowed grass stripes
    const bands = 10;
    const bw = L / bands;
    for (let i = 0; i < bands; i++) {
      const x0 = -L / 2 + i * bw;
      const x1 = x0 + bw;
      if (
        this._drawPoly3D(ctx, [
          [x0, -W / 2 - 1.4, 0],
          [x1, -W / 2 - 1.4, 0],
          [x1, W / 2 + 1.4, 0],
          [x0, W / 2 + 1.4, 0],
        ])
      ) {
        ctx.fillStyle = i % 2 ? COLORS.pitchA : COLORS.pitchB;
        ctx.fill();
      }
    }

    // Drape Spearman Pitch Control or Expected Threat (xT) Pass Value surface onto the 3D turf
    const surf = state.surfaceMode === "control" ? state.surface : state.surfaceMode === "value" ? state.valueSurface : null;
    if (surf && state.surfaceGrid && state.surfaceMode !== "off") {
      this._drawSurface3D(ctx, surf, state.surfaceGrid, state.surfaceMode, an.attTeam);
      if (state.surfaceMode === "control") {
        this._drawFrontier3D(ctx, surf, state.surfaceGrid, 0.5);
      }
    }

    // Regulation 3D pitch markings
    ctx.save();
    ctx.strokeStyle = "rgba(236, 243, 232, 0.82)";
    ctx.lineWidth = 1.35;
    ctx.lineJoin = "round";

    const strokeRect3D = (xa, ya, xb, yb) => {
      ctx.beginPath();
      this._strokeSegmentSubdivided(ctx, xa, ya, 0.01, xb, ya, 0.01, 8);
      this._strokeSegmentSubdivided(ctx, xb, ya, 0.01, xb, yb, 0.01, 8);
      this._strokeSegmentSubdivided(ctx, xb, yb, 0.01, xa, yb, 0.01, 8);
      this._strokeSegmentSubdivided(ctx, xa, yb, 0.01, xa, ya, 0.01, 8);
      ctx.stroke();
    };

    // Outer touchlines & goal lines
    strokeRect3D(-L / 2, -W / 2, L / 2, W / 2);

    // Halfway line
    ctx.beginPath();
    this._strokeSegmentSubdivided(ctx, 0, -W / 2, 0.01, 0, W / 2, 0.01, 10);
    ctx.stroke();

    // Center circle (r = 9.15 m) & spot
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const p = this.project(Math.cos(a) * 9.15, Math.sin(a) * 9.15, 0.01);
      if (!p) continue;
      i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();

    // Penalty areas, 6-yard boxes, penalty arcs, and 3D Goal Frames
    const ang = Math.acos((16.5 - 11.0) / 9.15);
    for (const side of [-1, 1]) {
      const gx = (side * L) / 2;
      strokeRect3D(gx, -20.16, gx - side * 16.5, 20.16);
      strokeRect3D(gx, -9.16, gx - side * 5.5, 9.16);

      // Penalty spot
      const spot = this.project(gx - side * 11.0, 0, 0.01);
      if (spot) {
        ctx.fillStyle = "rgba(236, 243, 232, 0.9)";
        ctx.beginPath();
        ctx.arc(spot[0], spot[1], Math.max(1.8, spot[3] * 0.2), 0, Math.PI * 2);
        ctx.fill();
      }

      // Penalty box arc
      const a0 = side > 0 ? Math.PI - ang : -ang;
      const a1 = side > 0 ? Math.PI + ang : ang;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const a = a0 + (a1 - a0) * (i / 24);
        const p = this.project(gx - side * 11.0 + Math.cos(a) * 9.15, Math.sin(a) * 9.15, 0.01);
        if (!p) continue;
        i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();

      // 3D Extruded Goal Frame (7.32m wide x 2.44m high x 2.0m deep)
      this._drawGoal3D(ctx, gx, side);
    }
    ctx.restore();
  }

  _drawGoal3D(ctx, gx, side) {
    const depth = side * 2.1;
    const yL = -3.66, yR = 3.66, h = 2.44;
    ctx.save();
    // Translucent goal net panels
    const netFaces = [
      [[gx, yL, 0], [gx + depth, yL, 0], [gx + depth, yL, h], [gx, yL, h]],
      [[gx, yR, 0], [gx + depth, yR, 0], [gx + depth, yR, h], [gx, yR, h]],
      [[gx + depth, yL, 0], [gx + depth, yR, 0], [gx + depth, yR, h], [gx + depth, yL, h]],
      [[gx, yL, h], [gx + depth, yL, h], [gx + depth, yR, h], [gx, yR, h]],
    ];
    ctx.fillStyle = "rgba(235, 242, 250, 0.11)";
    ctx.strokeStyle = "rgba(235, 242, 250, 0.28)";
    ctx.lineWidth = 0.8;
    for (const face of netFaces) {
      if (this._drawPoly3D(ctx, face)) {
        ctx.fill();
        ctx.stroke();
      }
    }
    // Goalposts & crossbar in bright white
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    this._strokeSegmentSubdivided(ctx, gx, yL, 0, gx, yL, h, 2);
    this._strokeSegmentSubdivided(ctx, gx, yR, 0, gx, yR, h, 2);
    this._strokeSegmentSubdivided(ctx, gx, yL, h, gx, yR, h, 4);
    ctx.stroke();
    ctx.restore();
  }

  _drawSurface3D(ctx, surface, grid, mode, attTeam) {
    const { nx, ny, x0, y0, dx, dy } = grid;
    const ta = COLORS[attTeam].tint;
    const td = COLORS[attTeam === "home" ? "away" : "home"].tint;
    // Render in 2x2 cell macro-quads (52x34 = 1,768 perspective quads) for rock-solid 60fps
    const step = 2;
    ctx.save();
    for (let j = 0; j < ny; j += step) {
      const jEnd = Math.min(ny, j + step);
      const wy0 = y0 + (j - 0.5) * dy;
      const wy1 = y0 + (jEnd - 0.5) * dy;
      for (let i = 0; i < nx; i += step) {
        const iEnd = Math.min(nx, i + step);
        const wx0 = x0 + (i - 0.5) * dx;
        const wx1 = x0 + (iEnd - 0.5) * dx;
        // Sample average over macro-cell
        let sum = 0, cnt = 0;
        for (let jj = j; jj < jEnd; jj++) {
          for (let ii = i; ii < iEnd; ii++) {
            sum += surface[jj * nx + ii];
            cnt++;
          }
        }
        const v = sum / cnt;
        let r, g, b, alpha;
        if (mode === "control") {
          const c = v - 0.5;
          const col = c >= 0 ? ta : td;
          const a = Math.min(1, Math.abs(c) * 2);
          alpha = Math.pow(a, 1.2) * 0.48;
          if (alpha < 0.025) continue;
          [r, g, b] = col;
        } else {
          const col = v >= 0 ? COLORS.valuePos : COLORS.valueNeg;
          const a = Math.min(1, Math.abs(v) / 0.06);
          alpha = Math.pow(a, 0.8) * 0.72;
          if (alpha < 0.03) continue;
          [r, g, b] = col;
        }
        const p0 = this.project(wx0, wy0, 0.005);
        const p1 = this.project(wx1, wy0, 0.005);
        const p2 = this.project(wx1, wy1, 0.005);
        const p3 = this.project(wx0, wy1, 0.005);
        if (!p0 || !p1 || !p2 || !p3) continue;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.lineTo(p3[0], p3[1]);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawFrontier3D(ctx, surface, grid, level = 0.5) {
    const { nx, ny, dx, dy, x0, y0 } = grid;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const pt = (xa, ya) => this.project(xa, ya, 0.03);
    const interp = (va, vb) => (level - va) / (vb - va);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = surface[j * nx + i];
        const b = surface[j * nx + i + 1];
        const c = surface[(j + 1) * nx + i + 1];
        const dd = surface[(j + 1) * nx + i];
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (dd > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const X = x0 + i * dx, Y = y0 + j * dy;
        const top = () => pt(X + interp(a, b) * dx, Y);
        const right = () => pt(X + dx, Y + interp(b, c) * dy);
        const bottom = () => pt(X + interp(dd, c) * dx, Y + dy);
        const left = () => pt(X, Y + interp(a, dd) * dy);
        const seg = (p, q) => {
          if (p && q) {
            ctx.moveTo(p[0], p[1]);
            ctx.lineTo(q[0], q[1]);
          }
        };
        switch (idx) {
          case 1: case 14: seg(left(), bottom()); break;
          case 2: case 13: seg(bottom(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(top(), right()); break;
          case 5: seg(left(), top()); seg(bottom(), right()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), top()); break;
          case 10: seg(top(), right()); seg(left(), bottom()); break;
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawShape3D(ctx, shape, team) {
    if (!shape) return;
    const isHome = team === "home";
    ctx.save();
    // 1. Convex hull polygon on the 3D turf
    if (shape.hull && shape.hull.length >= 3) {
      const hull3d = shape.hull.map(pt => [pt.x, pt.y, 0.02]);
      if (this._drawPoly3D(ctx, hull3d, true)) {
        ctx.fillStyle = isHome ? "rgba(255, 72, 92, 0.09)" : "rgba(64, 140, 255, 0.09)";
        ctx.fill();
        ctx.strokeStyle = isHome ? "rgba(255, 110, 125, 0.55)" : "rgba(110, 175, 255, 0.55)";
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // 2. 3D Defensive line vertical light ribbon
    if (shape.lines && shape.lines.length) {
      const defLine = shape.lines[0];
      if (defLine && defLine.count >= 2) {
        const y0 = defLine.yMin - 2.0, y1 = defLine.yMax + 2.0;
        if (
          this._drawPoly3D(ctx, [
            [defLine.x, y0, 0.02],
            [defLine.x, y1, 0.02],
            [defLine.x, y1, 0.9],
            [defLine.x, y0, 0.9],
          ])
        ) {
          ctx.fillStyle = isHome ? "rgba(200, 16, 46, 0.22)" : "rgba(74, 140, 255, 0.22)";
          ctx.fill();
          ctx.strokeStyle = isHome ? "rgba(255, 110, 125, 0.8)" : "rgba(120, 185, 255, 0.8)";
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  _drawOptions3D(ctx, opts, origin, players, actual, names, hasWhatIf) {
    if (!opts) return;
    const ox = origin.x, oy = origin.y;
    const byId = new Map(players.map(p => [p.id, p]));
    ctx.save();

    for (const o of opts.options) {
      if (o.offside) continue;
      const isBest = o === opts.best;
      const isBlocked = hasWhatIf && !!o.newlyBlocked;
      const isActual = actual && actual.recipient === o.id;
      if (!isBest && !isActual && !isBlocked && o.rank > 5) continue;

      const dx = o.x - ox, dy = o.y - oy;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist, ny = dx / dist;
      const w0 = isBest ? 0.36 : 0.22;
      const w1 = isBest ? 0.85 : 0.48;

      // Glowing 3D turf corridor quad
      const corridorPts = [
        [ox + nx * w0, oy + ny * w0, 0.025],
        [ox - nx * w0, oy - ny * w0, 0.025],
        [o.x - nx * w1, o.y - ny * w1, 0.025],
        [o.x + nx * w1, o.y + ny * w1, 0.025],
      ];
      if (this._drawPoly3D(ctx, corridorPts, true)) {
        if (isBlocked) {
          ctx.fillStyle = "rgba(255, 82, 82, 0.24)";
        } else if (isBest) {
          ctx.fillStyle = "rgba(255, 200, 61, 0.34)";
        } else {
          ctx.fillStyle = `rgba(220, 235, 255, ${(0.08 + 0.18 * o.prob).toFixed(3)})`;
        }
        ctx.fill();
      }

      // Lofted 3D pass trajectory arc
      const arcHeight = Math.min(2.6, Math.max(0.55, dist * 0.065));
      ctx.beginPath();
      let started = false;
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        const px = ox + dx * t;
        const py = oy + dy * t;
        const pz = 0.12 + 4 * arcHeight * t * (1 - t);
        const sc = this.project(px, py, pz);
        if (!sc) continue;
        if (!started) {
          ctx.moveTo(sc[0], sc[1]);
          started = true;
        } else {
          ctx.lineTo(sc[0], sc[1]);
        }
      }
      if (started) {
        if (isBlocked) {
          ctx.strokeStyle = "rgba(255, 107, 107, 0.85)";
          ctx.lineWidth = 2.0;
          ctx.setLineDash([4, 4]);
        } else if (isBest) {
          ctx.strokeStyle = COLORS.best;
          ctx.lineWidth = 3.0;
          ctx.shadowColor = "rgba(255, 200, 61, 0.65)";
          ctx.shadowBlur = 10;
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = `rgba(238, 242, 246, ${(0.4 + 0.5 * o.prob).toFixed(2)})`;
          ctx.lineWidth = 1.5 + 1.2 * o.prob;
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
      }
    }

    // Actual pass played (white dashed 3D trajectory)
    if (actual && byId.has(actual.recipient)) {
      const r = byId.get(actual.recipient);
      const dx = r.x - ox, dy = r.y - oy;
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      for (let s = 0; s <= 18; s++) {
        const t = s / 18;
        const p = this.project(ox + dx * t, oy + dy * t, 0.08 + 0.7 * 4 * t * (1 - t));
        if (!p) continue;
        s === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  _drawGhostTrail3D(ctx, from, to, shirt, meta) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05) return;
    const nx = -dy / dist, ny = dx / dist;
    const w = 0.38;

    ctx.save();
    // Glowing amber displacement ribbon on the 3D turf
    if (
      this._drawPoly3D(ctx, [
        [from.x + nx * w, from.y + ny * w, 0.03],
        [from.x - nx * w, from.y - ny * w, 0.03],
        [to.x - nx * w, to.y - ny * w, 0.03],
        [to.x + nx * w, to.y + ny * w, 0.03],
      ])
    ) {
      ctx.fillStyle = "rgba(255, 200, 61, 0.28)";
      ctx.fill();
    }

    // Center dashed vector
    ctx.strokeStyle = "#ffc83d";
    ctx.lineWidth = 2.4;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    this._strokeSegmentSubdivided(ctx, from.x, from.y, 0.1, to.x, to.y, 0.1, 6);
    ctx.stroke();
    ctx.setLineDash([]);

    // 0.6 m interception block ring around displaced defender
    ctx.strokeStyle = "rgba(255, 200, 61, 0.75)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const p = this.project(to.x + Math.cos(a) * 1.35, to.y + Math.sin(a) * 1.35, 0.04);
      if (!p) continue;
      i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();

    // Floating displacement badge below displaced defender's foot so it never collides with head billboards
    const foot = this.project(to.x, to.y, 0);
    if (foot && dist >= 0.4) {
      const last = meta ? (meta.last === "Cavaco Cancelo" ? "Cancelo" : meta.last) : "";
      const txt = `#${shirt ?? ""} ${last} · Δ ${dist.toFixed(1)} m`;
      ctx.font = "600 10.5px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(txt).width + 12;
      const bx = foot[0] - tw / 2;
      const by = foot[1] + 10;
      roundRect(ctx, bx, by, tw, 17, 4);
      ctx.fillStyle = "rgba(18, 15, 6, 0.94)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 200, 61, 0.85)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "#ffc83d";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, foot[0], by + 9);
    }
    ctx.restore();
  }

  _drawEntities3D(ctx, fr, an, state, shirts, names) {
    const items = [];
    const optById = new Map((an.options?.options || []).map(o => [o.id, o]));

    for (const p of fr.players) {
      if (p.tracked) {
        const gp = this.project(p.tracked.x, p.tracked.y, 0);
        if (gp) items.push({ kind: "ghost", p, x: p.tracked.x, y: p.tracked.y, depth: gp[2] + 0.1 });
      }
      const sp = this.project(p.x, p.y, 0);
      if (sp) items.push({ kind: "player", p, depth: sp[2] });
    }
    const bp = this.project(fr.ball.x, fr.ball.y, Math.max(0, fr.ball.z || 0));
    if (bp) items.push({ kind: "ball", ball: fr.ball, depth: bp[2] - 0.15 });

    // Painter's algorithm: back to front
    items.sort((a, b) => b.depth - a.depth);

    for (const it of items) {
      if (it.kind === "ghost") {
        this._drawSinglePlayer3D(ctx, it.p, it.x, it.y, shirts.get(it.p.id), {
          isGhost: true,
        });
      } else if (it.kind === "player") {
        const p = it.p;
        this._drawSinglePlayer3D(ctx, p, p.x, p.y, shirts.get(p.id), {
          isGhost: false,
          selected: p.id === state.selectedId || p.id === state.dragId,
          hovered: p.id === state.hoverId,
          carrier: an.carrier && p.id === an.carrier.id,
          offside: an.offsideIds && an.offsideIds.has(p.id),
          showVelocity: state.showVelocity,
          opt: optById.get(p.id) || null,
          isBestOpt: an.options?.best && an.options.best.id === p.id,
          lastName: names.get(p.id)?.last || "",
        });
      } else if (it.kind === "ball") {
        this._drawBall3D(ctx, it.ball);
      }
    }
  }

  _drawSinglePlayer3D(ctx, p, wx, wy, shirt, flags) {
    const foot = this.project(wx, wy, 0);
    const head = this.project(wx, wy, 1.75);
    if (!foot || !head) return;

    const col = COLORS[p.team];
    const scale = foot[3]; // pixels per metre at player's depth
    const baseR = Math.max(5, Math.min(20, scale * 0.95));
    const badgeR = Math.max(7.5, Math.min(16, scale * 0.82));

    ctx.save();
    if (flags.isGhost) {
      ctx.globalAlpha = 0.55;
    }

    // 1. Velocity vector on the 3D turf
    if (!flags.isGhost && flags.showVelocity) {
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.5) {
        const tip = this.project(wx + p.vx * 0.95, wy + p.vy * 0.95, 0.05);
        if (tip) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(foot[0], foot[1]);
          ctx.lineTo(tip[0], tip[1]);
          ctx.stroke();
        }
      }
    }

    // 2. Perspective ground shadow & tactical base ring on turf
    ctx.fillStyle = "rgba(0, 0, 0, 0.46)";
    ctx.beginPath();
    ctx.ellipse(foot[0], foot[1], baseR * 1.15, baseR * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();

    if (flags.selected || flags.isBestOpt) {
      ctx.strokeStyle = COLORS.best;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(foot[0], foot[1], baseR * 1.45, baseR * 0.74, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (flags.carrier) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.ellipse(foot[0], foot[1], baseR * 1.5, baseR * 0.76, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. 3D Vertical Player Plinth / Kit Column connecting turf to jersey disc
    const bodyW = Math.max(4, badgeR * 0.78);
    const bodyGrad = ctx.createLinearGradient(foot[0], head[1], foot[0], foot[1]);
    if (p.team === "home") {
      bodyGrad.addColorStop(0, "rgba(246, 244, 238, 0.92)");
      bodyGrad.addColorStop(1, "rgba(200, 16, 46, 0.78)");
    } else {
      bodyGrad.addColorStop(0, "rgba(56, 64, 74, 0.95)");
      bodyGrad.addColorStop(1, "rgba(24, 28, 34, 0.82)");
    }
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(head[0] - bodyW * 0.65, head[1]);
    ctx.lineTo(head[0] + bodyW * 0.65, head[1]);
    ctx.lineTo(foot[0] + bodyW * 0.45, foot[1]);
    ctx.lineTo(foot[0] - bodyW * 0.45, foot[1]);
    ctx.closePath();
    ctx.fill();

    // 4. Elevated Jersey Number Badge
    ctx.fillStyle = col.fill;
    ctx.beginPath();
    ctx.arc(head[0], head[1], badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = flags.selected ? COLORS.best : col.stroke;
    ctx.lineWidth = flags.selected ? 2.4 : 1.7;
    if (flags.isGhost) ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = col.text;
    ctx.font = `700 ${Math.max(9.5, badgeR * 1.25).toFixed(1)}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(shirt ?? ""), head[0], head[1] + 0.5);

    // 5. Floating 3D Pass-Option Probability Billboard above top options & newly-blocked options
    const o = flags.opt;
    const isBlocked = !!(o && o.newlyBlocked);
    if (!flags.isGhost && o && !o.offside && (flags.isBestOpt || isBlocked || o.rank <= 3 || flags.selected)) {
      const shortLast = flags.lastName === "Cavaco Cancelo" ? "Cancelo" : flags.lastName;
      const basePct = o.baseProb !== undefined ? Math.round(o.baseProb * 100) : 0;
      const txt = isBlocked
        ? `${shortLast} ${basePct}%→0% BLOCKED`
        : `${shortLast} ${Math.round(o.prob * 100)}%${o.newlyPromoted ? " #1" : ""}`;
      ctx.font = "600 10.5px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(txt).width + 10;
      const th = 16;
      const bx = head[0] - tw / 2;
      const by = head[1] - badgeR - th - 4;
      ctx.fillStyle = flags.isBestOpt
        ? "rgba(255, 200, 61, 0.96)"
        : isBlocked
        ? "rgba(76, 18, 24, 0.94)"
        : "rgba(10, 13, 18, 0.88)";
      roundRect(ctx, bx, by, tw, th, 4);
      ctx.fill();
      if (flags.isBestOpt) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (isBlocked) {
        ctx.strokeStyle = "rgba(255, 107, 107, 0.85)";
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
      ctx.fillStyle = flags.isBestOpt ? "#201a08" : isBlocked ? "#ffb3b3" : "#f4f6f9";
      ctx.fillText(txt, head[0], by + th / 2 + 0.5);
    }

    ctx.restore();
  }

  _drawBall3D(ctx, ball) {
    const z = Math.max(0, ball.z || 0);
    const g = this.project(ball.x, ball.y, 0);
    const b = this.project(ball.x, ball.y, z + 0.22);
    if (!g || !b) return;
    const r = Math.max(4.5, Math.min(10, b[3] * 0.42));
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.ellipse(g[0], g[1], r * 1.1, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    if (z > 0.15) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(g[0], g[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#1a1d22";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(b[0], b[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
