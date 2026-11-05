// Match data access: metadata, events and lazily-loaded Int16 tracking chunks.
// Works in the browser (fetch) and in Node (fs) so the same code feeds the app, tests and validation.

const SENTINEL = -32768;

export class MatchData {
  constructor(match, events, loader) {
    this.match = match; this.events = events; this.loader = loader;
    this.players = new Map(match.players.map(p => [p.id, p]));
    this.chunks = new Map(); // key period:index -> {slots, x: Float32Array[frames*slots], ...}
    this.pending = new Map();
  }
  static async load(base, loader) {
    const read = async f => JSON.parse(await loader.text(`${base}/${f}`));
    const [match, events] = await Promise.all([read("match.json"), read("events.json")]);
    return new MatchData(match, events, loader);
  }
  period(id) { return this.match.periods[id - 1]; }
  chunkIndex(period, frame) { return Math.floor(frame / period.chunkFrames); }
  key(periodId, ci) { return `${periodId}:${ci}`; }
  has(periodId, frame) { return this.chunks.has(this.key(periodId, this.chunkIndex(this.period(periodId), frame))); }
  async ensure(periodId, frame, prefetch = 1) {
    const period = this.period(periodId);
    const ci = this.chunkIndex(period, frame);
    const waits = [];
    for (let c = ci; c <= Math.min(ci + prefetch, period.chunks.length - 1); c++) waits.push(this.loadChunk(periodId, c));
    if (ci > 0 && prefetch > 0) this.loadChunk(periodId, ci - 1);
    await waits[0];
    return this.chunks.get(this.key(periodId, ci));
  }
  async loadChunk(periodId, ci) {
    const key = this.key(periodId, ci);
    if (this.chunks.has(key)) return this.chunks.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const period = this.period(periodId); const meta = period.chunks[ci];
    const p = this.loader.bytes(`${this.loader.base}/${meta.file}`).then(buf => {
      const i16 = new Int16Array(buf);
      const ns = meta.slots.length, stride = ns * 2 + 5, n = meta.frames;
      if (i16.length !== n * stride) throw new Error(`chunk ${meta.file}: unexpected size ${i16.length} != ${n * stride}`);
      const x = new Float32Array(n * ns), y = new Float32Array(n * ns);
      const ball = new Float32Array(n * 3), status = new Uint8Array(n), poss = new Uint8Array(n);
      for (let f = 0; f < n; f++) {
        const o = f * stride;
        for (let s = 0; s < ns; s++) { const vx = i16[o + 2 * s], vy = i16[o + 2 * s + 1]; const k = f * ns + s; x[k] = vx === SENTINEL ? NaN : vx / 100; y[k] = vy === SENTINEL ? NaN : vy / 100; }
        ball[f * 3] = i16[o + ns * 2] / 100; ball[f * 3 + 1] = i16[o + ns * 2 + 1] / 100; ball[f * 3 + 2] = i16[o + ns * 2 + 2] / 100;
        status[f] = i16[o + ns * 2 + 3]; poss[f] = i16[o + ns * 2 + 4];
      }
      const chunk = { meta, periodId, ci, start: meta.start, n, ns, slots: meta.slots, x, y, ball, status, poss,
        teams: meta.slots.map(id => this.players.get(id).team), gk: meta.slots.map(id => this.players.get(id).position === "TW") };
      this.chunks.set(key, chunk); this.pending.delete(key);
      return chunk;
    });
    this.pending.set(key, p);
    return p;
  }
}

/** Velocity for slot s at local frame f within a chunk (SG slope over ±3 frames, clamped to the chunk). */
export function chunkVelocity(chunk, s, f, maxSpeed = 12) {
  const ns = chunk.ns, n = chunk.n;
  let nx = 0, ny = 0, den = 0;
  for (let k = -3; k <= 3; k++) {
    let i = f + k; if (i < 0) i = 0; if (i >= n) i = n - 1;
    const x = chunk.x[i * ns + s]; if (Number.isNaN(x)) continue;
    nx += k * x; ny += k * chunk.y[i * ns + s]; den += k * k;
  }
  if (!den) return [0, 0];
  let vx = nx / (den * 0.04), vy = ny / (den * 0.04);
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (sp > maxSpeed) { vx *= maxSpeed / sp; vy *= maxSpeed / sp; }
  return [vx, vy];
}

/** Build a frame snapshot: array of player records + ball, using chunk-local velocities. */
export function snapshot(data, periodId, frame) {
  const period = data.period(periodId); const ci = data.chunkIndex(period, frame);
  const chunk = data.chunks.get(data.key(periodId, ci));
  if (!chunk) return null;
  const f = frame - chunk.start, ns = chunk.ns;
  const players = [];
  for (let s = 0; s < ns; s++) {
    const x = chunk.x[f * ns + s]; if (Number.isNaN(x)) continue;
    const [vx, vy] = chunkVelocity(chunk, s, f);
    players.push({ id: chunk.slots[s], team: chunk.teams[s], gk: chunk.gk[s], x, y: chunk.y[f * ns + s], vx, vy });
  }
  return { periodId, frame, players, ball: { x: chunk.ball[f * 3], y: chunk.ball[f * 3 + 1], z: chunk.ball[f * 3 + 2] }, inPlay: chunk.status[f] === 1, possession: chunk.poss[f] === 1 ? "home" : chunk.poss[f] === 2 ? "away" : null };
}

export function nodeLoader(base) {
  return { base, async text(p) { const fs = await import("node:fs/promises"); return fs.readFile(p, "utf8"); }, async bytes(p) { const fs = await import("node:fs/promises"); const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}
export function fetchLoader(base) {
  return { base, async text(p) { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.text(); }, async bytes(p) { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.arrayBuffer(); } };
}
