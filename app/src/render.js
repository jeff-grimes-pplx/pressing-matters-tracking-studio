// Canvas renderer: pitch, control surface, team shape, passing options, players, ball.
export const COLORS = {
  stage: "#0c1510", pitchA: "#1d4a35", pitchB: "#1a4330", line: "rgba(236,243,232,0.78)",
  home: { fill: "#f6f4ee", stroke: "#c8102e", text: "#b30d26", tint: [255, 72, 92] },
  away: { fill: "#262a2e", stroke: "#e9ecef", text: "#f3f4f6", tint: [64, 140, 255] },
  ball: "#ffffff", ballShadow: "rgba(0,0,0,0.45)",
  best: "#ffc83d", option: "#eef2f6", negative: "#8a94a6", actual: "#ffffff", offside: "#ff6b6b",
  valuePos: [255, 200, 61], valueNeg: [92, 108, 140],
  frontier: "rgba(255,255,255,0.55)",
  shapeBand: "rgba(255,255,255,0.10)",
};

export class PitchRenderer {
  constructor(canvas, pitch) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.L = pitch.length; this.W = pitch.width; this.margin = 3.2;
    this.surfCanvas = document.createElement("canvas"); this.surfCtx = this.surfCanvas.getContext("2d");
    this.pitchCache = null; this.dpr = 1; this.scale = 1; this.ox = 0; this.oy = 0;
    this.flipX = false; // when true, +x world is drawn to the left (so the team of interest attacks right)
  }
  resize(cssW, cssH, dpr = window.devicePixelRatio || 1) {
    this.dpr = dpr; this.cssW = cssW; this.cssH = cssH;
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + "px"; this.canvas.style.height = cssH + "px";
    const sx = cssW / (this.L + 2 * this.margin), sy = cssH / (this.W + 2 * this.margin);
    this.scale = Math.min(sx, sy); this.ox = cssW / 2; this.oy = cssH / 2;
    this.pitchCache = null;
  }
  // world (metres, pitch-centred, +y up) -> css pixels
  toScreen(x, y) { return [this.ox + (this.flipX ? -x : x) * this.scale, this.oy - y * this.scale]; }
  toWorld(px, py) { const x = (px - this.ox) / this.scale; return [this.flipX ? -x : x, -(py - this.oy) / this.scale]; }
  m(v) { return v * this.scale; }

  drawPitch(ctx) {
    const { L, W } = this; const s = this.scale;
    const [x0, y0] = this.toScreen(-L / 2, W / 2); const [x1, y1] = this.toScreen(L / 2, -W / 2);
    const left = Math.min(x0, x1), top = y0, width = Math.abs(x1 - x0), height = y1 - y0;
    ctx.fillStyle = COLORS.stage; ctx.fillRect(0, 0, this.cssW, this.cssH);
    // grass stripes (mown across the pitch, 10 bands)
    const bands = 10, bw = width / bands;
    for (let i = 0; i < bands; i++) { ctx.fillStyle = i % 2 ? COLORS.pitchA : COLORS.pitchB; ctx.fillRect(left + i * bw, top - this.m(1.5), bw + 0.5, height + this.m(3)); }
    // subtle vignette
    const g = ctx.createRadialGradient(this.ox, this.oy, this.m(20), this.ox, this.oy, this.m(70));
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.28)"); ctx.fillStyle = g; ctx.fillRect(0, 0, this.cssW, this.cssH);
    // markings
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = Math.max(1, this.m(0.12)); ctx.lineJoin = "round";
    const rect = (xa, ya, xb, yb) => { const [a, b] = this.toScreen(xa, ya); const [c, d] = this.toScreen(xb, yb); ctx.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)); };
    rect(-L / 2, -W / 2, L / 2, W / 2);
    const [cx, cy] = this.toScreen(0, 0);
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + height); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, this.m(9.15), 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, this.m(0.2), 0, Math.PI * 2); ctx.fillStyle = COLORS.line; ctx.fill();
    for (const side of [-1, 1]) {
      const gx = side * L / 2;
      rect(gx, -20.16, gx - side * 16.5, 20.16);
      rect(gx, -9.16, gx - side * 5.5, 9.16);
      const [px, py] = this.toScreen(gx - side * 11, 0);
      ctx.beginPath(); ctx.arc(px, py, this.m(0.2), 0, Math.PI * 2); ctx.fill();
      // penalty arc: part of circle r=9.15 around the spot outside the box
      const dxBox = 16.5 - 11; const ang = Math.acos(dxBox / 9.15);
      ctx.beginPath();
      const facing = (side * (this.flipX ? -1 : 1)); // screen direction of this goal
      const a0 = facing > 0 ? Math.PI - ang : -ang, a1 = facing > 0 ? Math.PI + ang : ang;
      ctx.arc(px, py, this.m(9.15), a0, a1); ctx.stroke();
      // goal
      const [ga, gb] = this.toScreen(gx, 3.66); const [gc, gd] = this.toScreen(gx + side * 2.0, -3.66);
      ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(Math.min(ga, gc), Math.min(gb, gd), Math.abs(gc - ga), Math.abs(gd - gb));
      ctx.strokeRect(Math.min(ga, gc), Math.min(gb, gd), Math.abs(gc - ga), Math.abs(gd - gb));
      // corner arcs
      for (const cy2 of [-1, 1]) { const [qx, qy] = this.toScreen(gx, cy2 * W / 2); ctx.beginPath(); ctx.arc(qx, qy, this.m(1), 0, Math.PI * 2); ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip(); ctx.beginPath(); ctx.arc(qx, qy, this.m(1), 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    }
  }
  ensurePitchCache() {
    if (this.pitchCache) return this.pitchCache;
    const c = document.createElement("canvas"); c.width = this.canvas.width; c.height = this.canvas.height;
    const ctx = c.getContext("2d"); ctx.scale(this.dpr, this.dpr); this.drawPitch(ctx); this.pitchCache = c; return c;
  }

  /** surface: Float32Array ny*nx; mode 'control' (0..1, attacking team) or 'value' (signed xT gain). */
  drawSurface(ctx, surface, grid, mode, attTeam, alphaScale = 1) {
    if (!surface) return;
    const { nx, ny } = grid;
    if (this.surfCanvas.width !== nx || this.surfCanvas.height !== ny) { this.surfCanvas.width = nx; this.surfCanvas.height = ny; }
    const img = this.surfCtx.createImageData(nx, ny); const d = img.data;
    const ta = COLORS[attTeam].tint, td = COLORS[attTeam === "home" ? "away" : "home"].tint;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = surface[j * nx + i]; const k = ((ny - 1 - j) * nx + i) * 4; // +y up
      if (mode === "control") {
        const c = v - 0.5; const col = c >= 0 ? ta : td; const a = Math.min(1, Math.abs(c) * 2);
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = Math.round(255 * Math.pow(a, 1.25) * 0.46 * alphaScale);
      } else {
        const col = v >= 0 ? COLORS.valuePos : COLORS.valueNeg; const a = Math.min(1, Math.abs(v) / 0.06);
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = Math.round(255 * Math.pow(a, 0.8) * 0.75 * alphaScale);
      }
    }
    this.surfCtx.putImageData(img, 0, 0);
    const [sx0, sy0] = this.toScreen(-this.L / 2, this.W / 2); const [sx1, sy1] = this.toScreen(this.L / 2, -this.W / 2);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.beginPath(); ctx.rect(Math.min(sx0, sx1), sy0, Math.abs(sx1 - sx0), sy1 - sy0); ctx.clip();
    if (this.flipX) { ctx.translate(sx0, sy0); ctx.scale(-1, 1); ctx.drawImage(this.surfCanvas, -(sx0 - sx1), 0, sx0 - sx1, sy1 - sy0); }
    else ctx.drawImage(this.surfCanvas, sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.restore();
  }

  /** 0.5 iso-line of the control surface by marching squares (linear interpolation). */
  drawFrontier(ctx, surface, grid, level = 0.5) {
    if (!surface) return;
    const { nx, ny, dx, dy, x0, y0 } = grid;
    ctx.save(); ctx.strokeStyle = COLORS.frontier; ctx.lineWidth = 1.2; ctx.setLineDash([]); ctx.beginPath();
    const pt = (xa, ya) => this.toScreen(xa, ya);
    const interp = (va, vb) => (level - va) / (vb - va);
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = surface[j * nx + i], b = surface[j * nx + i + 1], c = surface[(j + 1) * nx + i + 1], dd = surface[(j + 1) * nx + i];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (dd > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const X = x0 + i * dx, Y = y0 + j * dy;
      const top = () => pt(X + interp(a, b) * dx, Y), right = () => pt(X + dx, Y + interp(b, c) * dy), bottom = () => pt(X + interp(dd, c) * dx, Y + dy), left = () => pt(X, Y + interp(a, dd) * dy);
      const seg = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
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
    ctx.stroke(); ctx.restore();
  }

  drawShape(ctx, shape, team, label = true) {
    if (!shape || !shape.lines) return;
    const col = COLORS[team];
    const isHome = team === "home";
    // 1. Outfield convex-hull polygon (monotone chain, m^2)
    if (shape.hull && shape.hull.length >= 3) {
      ctx.save();
      ctx.beginPath();
      shape.hull.forEach((pt, idx) => {
        const [hx, hy] = this.toScreen(pt.x, pt.y);
        idx === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
      });
      ctx.closePath();
      ctx.fillStyle = isHome ? "rgba(255,72,92,0.08)" : "rgba(64,140,255,0.08)";
      ctx.fill();
      ctx.strokeStyle = isHome ? "rgba(255,110,125,0.48)" : "rgba(110,175,255,0.48)";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label && shape.centroid && Number.isFinite(shape.hullArea)) {
        const [cx, cy] = this.toScreen(shape.centroid.x, shape.centroid.y);
        const txt = `hull ${Math.round(shape.hullArea)} m²`;
        ctx.font = "600 10px 'JetBrains Mono', monospace";
        const tw = ctx.measureText(txt).width + 10;
        roundRect(ctx, cx - tw / 2, cy - 8, tw, 16, 4);
        ctx.fillStyle = "rgba(10,13,18,0.78)";
        ctx.fill();
        ctx.fillStyle = isHome ? "#ff9aa6" : "#9ac2ff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(txt, cx, cy + 0.5);
      }
      ctx.restore();
    }
    // 2. Optimal 1-D k-means (k=3) tactical lines
    shape.lines.forEach((l, li) => {
      if (l.count < 2) return;
      const [x, yTop] = this.toScreen(l.x, l.yMax + 1.5); const [, yBot] = this.toScreen(l.x, l.yMin - 1.5);
      ctx.save(); ctx.fillStyle = COLORS.shapeBand; ctx.fillRect(x - this.m(1.2), yTop, this.m(2.4), yBot - yTop);
      ctx.strokeStyle = col.fill === "#262a2e" ? "rgba(233,236,239,0.6)" : "rgba(200,16,46,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke(); ctx.setLineDash([]);
      if (label) {
        ctx.font = "600 10px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(255,255,255,0.88)";
        ctx.textAlign = "center";
        const ty = Math.max(14 + li * 13, yTop - 6 - (li % 2) * 12);
        ctx.fillText(`${l.name} ${l.height.toFixed(0)} m`, x, ty);
      }
      ctx.restore();
    });
  }

  /** options: result of passOptions; carrier: player; actual: {recipientId} or null */
  drawOptions(ctx, opts, ball, players, actual, selectedId) {
    if (!opts) return;
    const [bx, by] = this.toScreen(ball.x, ball.y);
    const byId = new Map(players.map(p => [p.id, p]));
    // lines first (so chips sit on top): show top 4 options, best, newlyBlocked, actual recipient, or selected
    for (const o of opts.options) {
      const isActual = actual && actual.recipient === o.id;
      if (o !== opts.best && !o.newlyBlocked && !isActual && o.id !== selectedId && (o.offside || o.rank > 4)) continue;
      const [tx, ty] = this.toScreen(o.x, o.y);
      ctx.save();
      if (o.offside) { ctx.strokeStyle = "rgba(255,107,107,0.5)"; ctx.setLineDash([3, 5]); ctx.lineWidth = 1; }
      else if (o.newlyBlocked) { ctx.strokeStyle = "rgba(255,107,107,0.88)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 2.0; }
      else if (o === opts.best) { ctx.strokeStyle = COLORS.best; ctx.lineWidth = 2.6; ctx.shadowColor = "rgba(255,200,61,0.55)"; ctx.shadowBlur = 10; }
      else if (o.gain < 0) { ctx.strokeStyle = `rgba(138,148,166,${0.3 + 0.45 * o.prob})`; ctx.lineWidth = 1.2; }
      else { ctx.strokeStyle = `rgba(238,242,246,${0.4 + 0.55 * o.prob})`; ctx.lineWidth = 1 + 2 * o.prob; }
      ctx.beginPath(); ctx.moveTo(bx, by);
      // slight curve for readability
      const mx = (bx + tx) / 2, my = (by + ty) / 2, nx = -(ty - by), ny = tx - bx, len = Math.hypot(nx, ny) || 1;
      const bend = Math.min(18, len * 0.06);
      ctx.quadraticCurveTo(mx + nx / len * bend, my + ny / len * bend, tx, ty); ctx.stroke();
      ctx.restore();
    }
    // actual pass
    if (actual && byId.has(actual.recipient)) {
      const r = byId.get(actual.recipient); const [tx, ty] = this.toScreen(r.x, r.y);
      ctx.save(); ctx.strokeStyle = COLORS.actual; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
      // arrow head
      const ang = Math.atan2(ty - by, tx - bx); ctx.setLineDash([]); ctx.fillStyle = COLORS.actual; ctx.beginPath();
      const hx = tx - Math.cos(ang) * this.m(1.4), hy = ty - Math.sin(ang) * this.m(1.4);
      ctx.moveTo(hx, hy); ctx.lineTo(hx - Math.cos(ang - 0.5) * 9, hy - Math.sin(ang - 0.5) * 9); ctx.lineTo(hx - Math.cos(ang + 0.5) * 9, hy - Math.sin(ang + 0.5) * 9); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  /** Value chips, drawn above players; placement avoids player dots where possible. */
  drawOptionChips(ctx, opts, players, hasWhatIf = false) {
    if (!opts) return;
    const r = this.m(1.15); const dots = players.map(p => this.toScreen(p.x, p.y)); const placed = [];
    ctx.save(); ctx.font = "600 11px 'JetBrains Mono', monospace"; ctx.textBaseline = "middle";
    const maxRank = this.cssW < 640 ? 3 : 4;
    for (const o of opts.options) {
      const isBlocked = hasWhatIf && !!o.newlyBlocked;
      if (o.offside) continue;
      if (o !== opts.best && !isBlocked && o.rank > maxRank) continue; // top 4 chips + blocked on pitch; full 10 in right rail
      const [tx, ty] = this.toScreen(o.x, o.y);
      const basePct = o.baseProb !== undefined ? Math.round(o.baseProb * 100) : 0;
      const text = isBlocked ? `${basePct}%→0% BLOCKED` : `${Math.round(o.prob * 100)}%  ${o.gain >= 0 ? "+" : "−"}${Math.abs(o.gain).toFixed(3)}`;
      const w = ctx.measureText(text).width + 11, h = 17;
      const cands = [
        [tx + r + 6, ty - r - h - 4],
        [tx - r - 6 - w, ty - r - h - 4],
        [tx + r + 6, ty + r + 4],
        [tx - r - 6 - w, ty + r + 4],
        [tx - w / 2, ty - r - h - 8],
        [tx - w / 2, ty + r + 8],
        [tx + r + 10, ty - h / 2],
        [tx - r - 10 - w, ty - h / 2],
      ];
      let best = cands[0], bestScore = Infinity;
      for (const [cx, cy] of cands) {
        let score = 0;
        for (const [dx, dy] of dots) if (dx > cx - r - 3 && dx < cx + w + r + 3 && dy > cy - r - 3 && dy < cy + h + r + 3) score += 14;
        for (const q of placed) if (cx < q[0] + q[2] + 4 && cx + w + 4 > q[0] && cy < q[1] + q[3] + 4 && cy + h + 4 > q[1]) score += 10;
        if (cx < 2 || cy < 2 || cx + w > this.cssW - 2 || cy + h > this.cssH - 2) score += 20;
        if (score < bestScore) { bestScore = score; best = [cx, cy]; }
      }
      const [cx, cy] = best; placed.push([cx, cy, w, h]);
      ctx.fillStyle = o === opts.best ? "rgba(255,200,61,0.96)" : isBlocked ? "rgba(76,18,24,0.92)" : "rgba(10,13,18,0.86)";
      roundRect(ctx, cx, cy, w, h, 4); ctx.fill();
      if (o === opts.best) { ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1; ctx.stroke(); }
      else if (isBlocked) { ctx.strokeStyle = "rgba(255,107,107,0.75)"; ctx.lineWidth = 1.1; ctx.stroke(); }
      ctx.fillStyle = o === opts.best ? "#201a08" : isBlocked ? "#ffb3b3" : o.gain < 0 ? "#aab3c2" : "#f4f6f9";
      ctx.fillText(text, cx + 5.5, cy + h / 2 + 0.5);
      // tiny connector when the chip is not adjacent to the dot
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.max(cx, Math.min(cx + w, tx)), Math.max(cy, Math.min(cy + h, ty))); ctx.lineTo(tx, ty); ctx.stroke();
    }
    ctx.restore();
  }

  drawPlayers(ctx, players, shirts, { selectedId, hoverId, carrierId, dragId, showVelocity, offsideIds, dimTeam }) {
    const r = this.m(1.15);
    // Compute visual screen positions with gentle pairwise separation so tightly marked players (<1.2m apart) never obscure each other's jersey numbers
    const scr = players.map(p => {
      const [sx, sy] = this.toScreen(p.x, p.y);
      return { p, x: sx, y: sy, ox: sx, oy: sy };
    });
    const minDist = r * 2.08;
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < scr.length; i++) {
        for (let j = i + 1; j < scr.length; j++) {
          const a = scr[i], b = scr[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < minDist) {
            if (d < 0.01) { dx = 1; dy = 0; d = 1; }
            const push = (minDist - d) * 0.52;
            const ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push;
            b.x += ux * push; b.y += uy * push;
          }
        }
      }
    }
    for (const s of scr) {
      const { p, x, y, ox, oy } = s;
      const col = COLORS[p.team];
      ctx.save();
      if (showVelocity) { const sp = Math.hypot(p.vx, p.vy); if (sp > 0.5) { const [ex, ey] = this.toScreen(p.x + p.vx * 0.8, p.y + p.vy * 0.8); ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke(); } }
      // shadow
      ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(x + r * 0.15, y + r * 0.35, r * 1.05, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
      if (p.id === selectedId || p.id === dragId) { ctx.shadowColor = COLORS.best; ctx.shadowBlur = 14; ctx.strokeStyle = COLORS.best; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0; }
      else if (p.id === hoverId) { ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke(); }
      if (p.id === carrierId) { ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      ctx.globalAlpha = dimTeam && p.team === dimTeam ? 0.75 : 1;
      ctx.fillStyle = col.fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = col.stroke; ctx.lineWidth = p.gk ? 2.4 : 1.6; ctx.stroke();
      if (p.gk) { ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, r - 3, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = col.text; ctx.font = `700 ${Math.max(9, r * 1.25).toFixed(1)}px 'Barlow Condensed', sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(shirts.get(p.id) ?? ""), x, y + 0.5);
      if (offsideIds && offsideIds.has(p.id)) { ctx.strokeStyle = COLORS.offside; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.stroke(); }
      ctx.restore();
    }
  }
  drawBall(ctx, ball) {
    const [x, y] = this.toScreen(ball.x, ball.y); const z = Math.max(0, ball.z || 0); const r = this.m(0.55) + Math.min(3, z * 0.6);
    ctx.save();
    ctx.fillStyle = COLORS.ballShadow; ctx.beginPath(); ctx.ellipse(x + this.m(0.3) + z * 1.2, y + this.m(0.4) + z * 1.2, r * 0.9, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    const yy = y - z * 2.2;
    ctx.fillStyle = COLORS.ball; ctx.strokeStyle = "#1a1d22"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, yy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  drawGhost(ctx, from, to, shirt = "") {
    // what-if: show original position as a ghost jersey disc, glowing displacement vector, block radius, and Δm pill
    const [ax, ay] = this.toScreen(from.x, from.y); const [bx, by] = this.toScreen(to.x, to.y);
    const distM = Math.hypot(to.x - from.x, to.y - from.y);
    const r = this.m(1.15);
    ctx.save();
    // 1. Glowing amber corridor & dashed displacement vector
    ctx.strokeStyle = "rgba(255,200,61,0.28)"; ctx.lineWidth = Math.max(6, this.m(1.1)); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = "#ffc83d"; ctx.setLineDash([5, 4]); ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    // Arrowhead pointing to counterfactual position
    const ang = Math.atan2(by - ay, bx - ax);
    if (Math.hypot(bx - ax, by - ay) > r * 2.2) {
      const hx = bx - Math.cos(ang) * (r + 3), hy = by - Math.sin(ang) * (r + 3);
      ctx.fillStyle = "#ffc83d";
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.cos(ang - 0.5) * 8, hy - Math.sin(ang - 0.5) * 8);
      ctx.lineTo(hx - Math.cos(ang + 0.5) * 8, hy - Math.sin(ang + 0.5) * 8);
      ctx.closePath();
      ctx.fill();
    }
    // 2. Ghost disc at tracked origin with shirt number
    ctx.fillStyle = "rgba(15,20,26,0.68)";
    ctx.beginPath(); ctx.arc(ax, ay, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,200,61,0.82)"; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(ax, ay, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    if (shirt !== "") {
      ctx.fillStyle = "rgba(255,200,61,0.9)";
      ctx.font = `700 ${Math.max(9, r * 1.15).toFixed(1)}px 'Barlow Condensed', sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(shirt), ax, ay + 0.5);
    }
    // 3. Interception block ring around counterfactual position
    ctx.strokeStyle = "rgba(255,200,61,0.55)"; ctx.lineWidth = 1.3; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.arc(bx, by, r + 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    // 4. Δ distance pill placed cleanly below counterfactual disc (avoids crowding nearby receivers)
    if (distM >= 0.4) {
      const mx = bx, my = by + r + 13;
      const lbl = `#${shirt ?? ""} Δ ${distM.toFixed(1)} m`;
      ctx.font = "600 10px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(lbl).width + 10, th = 15;
      roundRect(ctx, mx - tw / 2, my - th / 2, tw, th, 4);
      ctx.fillStyle = "rgba(18,15,6,0.94)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,200,61,0.85)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#ffc83d"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(lbl, mx, my + 0.5);
    }
    ctx.restore();
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
