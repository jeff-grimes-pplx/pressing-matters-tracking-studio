// Pressing Matters — live 25 Hz tracking-data & counterfactual pitch-control studio.
// Synchronized 2D Tactical Pitch + 3D Broadcast / Spidercam Stadium View.
import { MatchData, fetchLoader, chunkVelocity } from "./data.js";
import { DEFAULT_PARAMS, derivedParams, makeScene, makeGrid, applyOffside, attackDirection } from "./models/pitchcontrol.js";
import { XT } from "./models/xt.js";
import { teamShape } from "./models/shape.js";
import { ppda } from "./models/ppda.js";
import { PHYS, PhysicalAccumulator } from "./models/physical.js";
import { buildScene, ballCarrier, passOptions } from "./models/options.js";
import { PitchRenderer, COLORS, roundRect } from "./render.js";
import { Pitch3DRenderer } from "./render3d.js";
import { drawerHTML } from "./drawer.js";

const $ = (id) => document.getElementById(id);
const FPS = 25, FRAME_MS = 1000 / FPS;
const P = derivedParams(DEFAULT_PARAMS);

const state = {
  periodId: 2, frame: 64794, sub: 0, playing: false, speed: 1,
  viewMode: "2d", // '2d' | 'split' | '3d'
  camPreset: "spidercam", // 'spidercam' | 'broadcast' | 'carrier'
  selectedId: null, hoverId: null, dragId: null, whatIf: new Map(), whatIfFrame: null,
  whatIfAnim: null, // { pid, fromX, fromY, toX, toY, t0, duration, presetKey }
  surfaceMode: "control", showShape: false, showVelocity: false, showOptions: true,
  attackOverride: null, // 'home' | 'away' | null
  surface: null, valueSurface: null, surfaceGrid: null, surfaceReqId: 0, surfaceDoneId: 0, surfaceBusy: false, surfacePending: null,
  perf: { control: 0, value: 0, roundTrip: 0, options: 0, render: 0 }, cell: 1.0,
  lastTs: 0, playhead: 64794, seeking: false,
};

let data, analysis, xt, renderer, renderer3d, worker, shirts, names, dirHome, validation = null, cfVerification = null;
const canvas = $("pitch"), canvas3d = $("pitch3d"), stage = $("stage"), stageGrid = $("stageGrid"), pane2d = $("pane2d"), pane3d = $("pane3d"), scrub = $("scrub");
let exportURL = null;

// ---------------------------------------------------------------- boot
async function boot() {
  const base = new URL("./data", document.baseURI).href.replace(/\/$/, "");
  data = await MatchData.load(base, fetchLoader(base));
  const [an, xtModel, val, cfVal] = await Promise.all([
    fetch(`${base}/analysis.json`).then(r => r.json()),
    fetch(`${base}/xt.json`).then(r => r.json()),
    fetch(`${base}/validation.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${base}/counterfactual_verification.json`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  analysis = an; xt = new XT(xtModel); validation = val; cfVerification = cfVal;
  dirHome = { 1: data.match.periods[0].homeAttacksRight ? 1 : -1, 2: data.match.periods[1].homeAttacksRight ? 1 : -1 };
  shirts = new Map(data.match.players.map(p => [p.id, p.shirt])); names = new Map(data.match.players.map(p => [p.id, p]));
  const ballPos = new Map(analysis.events.map(e => [e.id, e.ballPos])); for (const e of data.events) if (!e.pos && ballPos.has(e.id)) e.ballPos = ballPos.get(e.id);
  renderer = new PitchRenderer(canvas, data.match.pitch);
  renderer3d = new Pitch3DRenderer(canvas3d, data.match.pitch);
  setupUI();
  readURL();
  worker = await startWorker();
  worker.onmessage = onWorker;
  worker.postMessage({ type: "init", xt: xtModel, cell: state.cell, length: data.match.pitch.length, width: data.match.pitch.width });
  await seek(state.periodId, state.frame, true);
  layout(); $("app").dataset.state = "ready";
  activeChip = null; updateBookmarkChips();
  requestAnimationFrame(tick);
}

async function startWorker() {
  try {
    const res = await fetch(new URL("./worker.bundle.js", import.meta.url)); if (!res.ok) throw new Error(`bundle ${res.status}`);
    const blob = new Blob([await res.text()], { type: "text/javascript" });
    return new Worker(URL.createObjectURL(blob));
  } catch (err) {
    console.warn("worker bundle unavailable, using module worker", err);
    return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  }
}

function readURL() {
  const q = new URLSearchParams(location.search);
  if (q.get("p")) state.periodId = +q.get("p") === 2 ? 2 : 1;
  if (q.get("f")) state.frame = Math.max(0, Math.min(data.period(state.periodId).frames - 1, +q.get("f")));
  if (q.get("sel")) state.selectedId = q.get("sel");
  if (q.get("mode")) setMode(q.get("mode"));
  if (q.get("view")) setView(q.get("view"), false);
  if (q.get("cam")) setCamPreset(q.get("cam"));
  if (q.get("shape") === "1") toggle("showShape", $("toggleShape"), true);
  if (q.get("vel") === "1") toggle("showVelocity", $("toggleVelocity"), true);
  if (q.get("cell")) state.cell = +q.get("cell") || 1;
  state.playhead = state.frame;
}
function writeURL() {
  const q = new URLSearchParams();
  q.set("p", state.periodId); q.set("f", state.frame);
  if (state.selectedId) q.set("sel", state.selectedId);
  if (state.surfaceMode !== "control") q.set("mode", state.surfaceMode);
  if (state.viewMode !== "2d") q.set("view", state.viewMode);
  history.replaceState(null, "", `?${q}`);
}

// ---------------------------------------------------------------- frame access
function currentChunk(frame = state.frame) { const per = data.period(state.periodId); return data.chunks.get(data.key(state.periodId, data.chunkIndex(per, frame))); }

/** Interpolated frame: positions blended between frame and frame+1 (same or next chunk), velocities from the SG filter. */
function buildFrame() {
  const per = data.period(state.periodId); const f = state.frame, sub = state.sub;
  const chunk = currentChunk(f); if (!chunk) return null;
  const f1 = Math.min(per.frames - 1, f + 1); const chunk1 = currentChunk(f1);
  const lf = f - chunk.start, ns = chunk.ns;
  const players = [];
  for (let s = 0; s < ns; s++) {
    const x = chunk.x[lf * ns + s]; if (Number.isNaN(x)) continue;
    const id = chunk.slots[s]; let x1 = x, y1 = chunk.y[lf * ns + s];
    if (chunk1 && sub > 0) { const s1 = chunk1 === chunk ? s : chunk1.slots.indexOf(id); if (s1 >= 0) { const lf1 = f1 - chunk1.start; const xx = chunk1.x[lf1 * chunk1.ns + s1]; if (!Number.isNaN(xx)) { x1 = xx; y1 = chunk1.y[lf1 * chunk1.ns + s1]; } } }
    const [vx, vy] = chunkVelocity(chunk, s, lf);
    const p = { id, team: chunk.teams[s], gk: chunk.gk[s], x: x + (x1 - x) * sub, y: chunk.y[lf * ns + s] + (y1 - chunk.y[lf * ns + s]) * sub, vx, vy, tracked: null };
    players.push(p);
  }
  let ball = { x: chunk.ball[lf * 3], y: chunk.ball[lf * 3 + 1], z: chunk.ball[lf * 3 + 2] };
  if (chunk1 && sub > 0) { const lf1 = f1 - chunk1.start; ball = { x: ball.x + (chunk1.ball[lf1 * 3] - ball.x) * sub, y: ball.y + (chunk1.ball[lf1 * 3 + 1] - ball.y) * sub, z: ball.z + (chunk1.ball[lf1 * 3 + 2] - ball.z) * sub }; }
  const poss = chunk.poss[lf] === 1 ? "home" : chunk.poss[lf] === 2 ? "away" : null;
  const trackedPlayers = players.map(p => ({ ...p }));
  const trackedBall = { ...ball };
  // what-if overrides (only valid on the frame they were made)
  if (state.whatIf.size && state.whatIfFrame === `${state.periodId}:${f}`) {
    for (const p of players) { const o = state.whatIf.get(p.id); if (o) { p.tracked = { x: p.x, y: p.y }; p.x = o.x; p.y = o.y; if (o.ball) { ball = { ...ball, x: o.x + 0.3, y: o.y }; } } }
  }
  return { players, trackedPlayers, ball, trackedBall, inPlay: chunk.status[lf] === 1, possession: poss };
}

function attackingTeam(fr) {
  if (state.attackOverride) return state.attackOverride;
  if (state.selectedId) { const p = fr.players.find(q => q.id === state.selectedId); if (p) return p.team; }
  if (fr.possession) return fr.possession;
  let best = "home", bd = Infinity;
  for (const p of fr.players) { const d = Math.hypot(p.x - fr.ball.x, p.y - fr.ball.y); if (d < bd) { bd = d; best = p.team; } }
  return best;
}

/** Everything the models say about this frame (plus baseline tracked options when What-If is active). */
function analyse(fr) {
  const attTeam = attackingTeam(fr); const defTeam = attTeam === "home" ? "away" : "home";
  const dir = attTeam === "home" ? dirHome[state.periodId] : -dirHome[state.periodId];
  const sel = state.selectedId ? fr.players.find(p => p.id === state.selectedId) : null;
  const actualCarrier = ballCarrier(fr.players, attTeam, fr.ball);
  const carrier = (sel && sel.team === attTeam) ? sel : actualCarrier;
  const hypothetical = !!(carrier && actualCarrier && carrier.id !== actualCarrier.id && Math.hypot(carrier.x - fr.ball.x, carrier.y - fr.ball.y) > 2.5);
  const origin = hypothetical ? { x: carrier.x, y: carrier.y } : fr.ball;
  const scene = buildScene(fr.players, attTeam, origin, makeScene);
  const off = applyOffside(scene, P);
  const t0 = performance.now();
  const options = state.showOptions && fr.inPlay !== false ? passOptions(fr.players, scene, attTeam, carrier ? carrier.id : null, xt, dir, P, off) : null;
  let baseOptions = null;
  if (state.whatIf.size && options && fr.trackedPlayers) {
    const baseCarrier = (sel && sel.team === attTeam) ? fr.trackedPlayers.find(p => p.id === sel.id) : ballCarrier(fr.trackedPlayers, attTeam, fr.trackedBall);
    const baseOrigin = hypothetical && baseCarrier ? { x: baseCarrier.x, y: baseCarrier.y } : fr.trackedBall;
    const baseScene = buildScene(fr.trackedPlayers, attTeam, baseOrigin, makeScene);
    const baseOff = applyOffside(baseScene, P);
    baseOptions = passOptions(fr.trackedPlayers, baseScene, attTeam, baseCarrier ? baseCarrier.id : null, xt, dir, P, baseOff);
    const baseById = new Map(baseOptions.ranked.map(o => [o.id, o]));
    for (const opt of options.options) {
      const b = baseById.get(opt.id);
      if (b) {
        opt.baseProb = b.prob;
        opt.baseRank = b.rank;
        opt.newlyBlocked = b.prob >= 0.15 && opt.prob < 0.05 && opt.laneRisk >= 0.90;
        opt.newlyPromoted = b.rank > 1 && opt.rank === 1;
      }
    }
  }
  state.perf.options = performance.now() - t0;
  const shapes = { home: teamShape(fr.players.filter(p => p.team === "home"), dirHome[state.periodId]), away: teamShape(fr.players.filter(p => p.team === "away"), -dirHome[state.periodId]) };
  const pass = analysis.passes.find(p => p.period === state.periodId && Math.abs(p.frame - state.frame) <= 2 && p.team === attTeam) || null;
  return { attTeam, defTeam, dir, scene, off, carrier, actualCarrier, hypothetical, origin, options, baseOptions, shapes, pass, showPass: pass && !hypothetical, offsideIds: new Set(off.offside.map(i => fr.players[i].id)) };
}

// ---------------------------------------------------------------- worker surface
function requestSurface(fr, an) {
  const sc = an.scene;
  const msg = { type: "surface", id: ++state.surfaceReqId, x: sc.x, y: sc.y, vx: sc.vx, vy: sc.vy, att: sc.att, gk: sc.gk, active: sc.active, ballX: sc.ballX, ballY: sc.ballY, dir: an.dir, wantValue: state.surfaceMode === "value", t: performance.now() };
  if (state.surfaceBusy) { if (state.surfacePending) pendingTimes.delete(state.surfacePending.id); state.surfacePending = msg; return; }
  state.surfaceBusy = true; pendingTimes.set(msg.id, msg.t); worker.postMessage(msg);
}
function onWorker(ev) {
  const m = ev.data;
  if (m.type === "ready") { state.surfaceGrid = m.grid; return; }
  if (m.type === "surface") {
    state.surfaceBusy = false; state.surface = m.control; state.valueSurface = m.value; state.surfaceGrid = m.grid; state.surfaceDoneId = m.id;
    state.perf.control = m.msControl; state.perf.value = m.msValue; if (pendingTimes.has(m.id)) { state.perf.roundTrip = performance.now() - pendingTimes.get(m.id); pendingTimes.delete(m.id); }
    perfLog.push({ id: m.id, control: m.msControl, value: m.msValue, roundTrip: state.perf.roundTrip, render: state.perf.render }); if (perfLog.length > 400) perfLog.shift();
    if (state.surfacePending) { const p = state.surfacePending; state.surfacePending = null; state.surfaceBusy = true; pendingTimes.set(p.id, performance.now()); worker.postMessage(p); }
    needsRender = true;
  }
}
const pendingTimes = new Map();
const perfLog = [];

// ---------------------------------------------------------------- render loop
let needsRender = true, lastFrameKey = "", lastAnalysis = null, lastFrameData = null, optionsSig = "";
function tick(ts) {
  if (state.whatIfAnim) {
    const a = state.whatIfAnim;
    const u = Math.min(1, (ts - a.t0) / a.duration);
    // Smooth easeInOutCubic so the viewer can watch the defender drag and surface morph
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    state.whatIfFrame = `${state.periodId}:${state.frame}`;
    state.whatIf.set(a.pid, { x: a.fromX + (a.toX - a.fromX) * e, y: a.fromY + (a.toY - a.fromY) * e, ball: false });
    if (u >= 1) state.whatIfAnim = null;
    needsRender = true;
  }
  if (state.playing) {
    const dt = state.lastTs ? Math.min(100, ts - state.lastTs) : 0; state.lastTs = ts;
    state.playhead += (dt / FRAME_MS) * state.speed;
    const per = data.period(state.periodId);
    if (state.playhead >= per.frames - 1) { state.playhead = per.frames - 1; setPlaying(false); }
    const nf = Math.floor(state.playhead); const sub = state.playhead - nf;
    if (nf !== state.frame) { if (state.whatIf.size) clearWhatIf(false); state.frame = nf; }
    state.sub = sub; needsRender = true;
    if (!data.has(state.periodId, Math.min(per.frames - 1, nf + 1500))) data.ensure(state.periodId, Math.min(per.frames - 1, nf + 1500), 0);
    if (!currentChunk()) { data.ensure(state.periodId, state.frame, 1).then(() => { needsRender = true; }); }
  } else state.lastTs = ts;
  if (needsRender) { needsRender = false; const r0 = performance.now(); render(); state.perf.render = performance.now() - r0; }
  requestAnimationFrame(tick);
}

function render() {
  const fr = buildFrame(); if (!fr) return;
  const an = analyse(fr); lastAnalysis = an; lastFrameData = fr;
  const key = `${state.periodId}:${state.frame}:${state.sub.toFixed(3)}:${an.attTeam}:${state.surfaceMode}:${[...state.whatIf.entries()].map(([k, v]) => `${k}${v.x.toFixed(2)}${v.y.toFixed(2)}`).join("")}`;
  if (key !== lastFrameKey && state.surfaceMode !== "off") { lastFrameKey = key; pendingTimes.set(state.surfaceReqId + 1, performance.now()); requestSurface(fr, an); }

  if ( revealT0 === null ) revealT0 = performance.now();
  const reveal = Math.min(1, (performance.now() - revealT0) / REVEAL_MS); if (reveal < 1) needsRender = true;

  // Render 2D Tactical Pitch when visible
  if (state.viewMode === "2d" || state.viewMode === "split") {
    const ctx = renderer.ctx; ctx.setTransform(renderer.dpr, 0, 0, renderer.dpr, 0, 0);
    ctx.fillStyle = "#0b0d10"; ctx.fillRect(0, 0, renderer.cssW, renderer.cssH);
    ctx.globalAlpha = easeReveal(reveal);
    ctx.drawImage(renderer.ensurePitchCache(), 0, 0, renderer.cssW, renderer.cssH);
    if (state.surfaceMode === "control" && state.surface) { renderer.drawSurface(ctx, state.surface, state.surfaceGrid, "control", an.attTeam); renderer.drawFrontier(ctx, state.surface, state.surfaceGrid); }
    else if (state.surfaceMode === "value" && state.valueSurface) { renderer.drawSurface(ctx, state.valueSurface, state.surfaceGrid, "value", an.attTeam); }
    if (state.showShape) {
      renderer.drawShape(ctx, an.shapes.home, "home");
      renderer.drawShape(ctx, an.shapes.away, "away");
    }
    for (const p of fr.players) if (p.tracked) renderer.drawGhost(ctx, p.tracked, p, shirts.get(p.id));
    if (an.options && fr.inPlay) renderer.drawOptions(ctx, an.options, an.origin, fr.players, an.showPass ? { recipient: an.pass.recipient } : null, state.selectedId);
    renderer.drawPlayers(ctx, fr.players, shirts, { selectedId: state.selectedId, hoverId: state.hoverId, carrierId: an.carrier ? an.carrier.id : null, dragId: state.dragId, showVelocity: state.showVelocity, offsideIds: an.offsideIds });
    ctx.globalAlpha = 1; renderer.drawBall(ctx, fr.ball); ctx.globalAlpha = easeReveal(reveal);
    if (an.options && fr.inPlay) renderer.drawOptionChips(ctx, an.options, fr.players, state.whatIf.size > 0);
    ctx.globalAlpha = 1;
  }

  // Render 3D Broadcast / Spidercam Stadium View when visible
  if (state.viewMode === "3d" || state.viewMode === "split") {
    renderer3d.renderScene(fr, an, state, shirts, names);
  }

  updatePanels(fr, an);
}
let revealT0 = null; const REVEAL_MS = 2000; const easeReveal = t => t < 0.25 ? 0 : (u => u * u * (3 - 2 * u))((t - 0.25) / 0.75);

// ---------------------------------------------------------------- panels
const fmt = { pct: v => `${Math.round(v * 100)}%`, d3: v => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`, m1: v => Number.isFinite(v) ? v.toFixed(1) : "—", m0: v => Number.isFinite(v) ? v.toFixed(0) : "—", kmh: v => `${(v * 3.6).toFixed(1)} km/h`, km: v => `${(v / 1000).toFixed(2)} km` };
function clockText(periodId, frame) { const per = data.period(periodId); const s = per.clockOffset + frame / FPS; const mm = Math.floor(s / 60), ss = Math.floor(s % 60); return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`; }

let lastChipKey = "", lastScrubFrame = -1;
function updatePanels(fr, an) {
  $("clock").textContent = clockText(state.periodId, state.frame);
  const chipKey = `${state.periodId}:${state.frame >> 3}`; if (chipKey !== lastChipKey) { lastChipKey = chipKey; updateBookmarkChips(); }
  if (state.frame !== lastScrubFrame) { lastScrubFrame = state.frame; drawScrub(); }
  const sc = liveScore(state.periodId, state.frame); $("score").textContent = `${sc.home} : ${sc.away}`;
  $("periodLabel").textContent = state.periodId === 1 ? "1st half" : "2nd half";
  $("frameLabel").textContent = `P${state.periodId} · f ${state.frame}${fr.inPlay ? "" : " · dead ball"}`;
  const attName = data.match[an.attTeam].name.replace("1. FC ", "").replace("FC Bayern München", "Bayern");
  $("attackLabel").innerHTML = `<span class="dot" style="background:${an.attTeam === "home" ? "rgba(255,72,92,0.9)" : "rgba(64,140,255,0.9)"}"></span>${attName} in possession · attacking ${an.dir > 0 ? "→" : "←"}${state.attackOverride ? " (manual)" : ""}`;
  // event label
  const ev = an.showPass ? an.pass : null;
  if (ev) {
    const a = ev.actual; const segs = [];
    if (a && a.rank) segs.push(`ranked #${a.rank} of ${a.of}`);
    if (state.whatIf.size && an.options && ev.recipient) {
      const live = an.options.ranked.find(o => o.id === ev.recipient);
      segs.push(live ? `#${live.rank} of ${an.options.ranked.length} under what-if` : "unranked under what-if");
    }
    if (ev.breaks.length) segs.push(`breaks ${ev.breaks.join(" + ")} line`);
    const key = `${ev.player}|${ev.recipient}|${segs.join("|")}`;
    const el = $("eventLabel"); el.classList.remove("hidden");
    if (el.dataset.key !== key) {
      el.dataset.key = key; el.textContent = "";
      const l1 = document.createElement("span"); l1.className = "ev-pass"; l1.textContent = `Pass played: ${pname(ev.player)} → ${ev.recipient ? pname(ev.recipient) : "lost"}`; el.appendChild(l1);
      if (segs.length) { const l2 = document.createElement("span"); l2.className = "ev-rank"; segs.forEach((s, i) => { if (i) { const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "·"; l2.appendChild(sep); } const sp = document.createElement("span"); sp.textContent = s; l2.appendChild(sp); }); el.appendChild(l2); }
    }
  }
  else { $("eventLabel").classList.add("hidden"); $("eventLabel").dataset.key = ""; }

  // selected player
  const sel = state.selectedId ? fr.players.find(p => p.id === state.selectedId) : null;
  if (sel) {
    const meta = names.get(sel.id); $("playerEmpty").classList.add("hidden"); $("playerBody").classList.remove("hidden");
    $("pShirt").textContent = meta.shirt; $("pShirt").className = `shirt ${sel.team}`; $("pName").textContent = `${meta.first} ${meta.last}`;
    const dispTxt = sel.tracked ? ` · what-if Δ ${Math.hypot(sel.x - sel.tracked.x, sel.y - sel.tracked.y).toFixed(1)} m` : "";
    $("pMeta").textContent = `${data.match[sel.team].name} · ${posName(meta.position)}${dispTxt}`;
    const sp = Math.hypot(sel.vx, sel.vy); $("pSpeed").textContent = fmt.kmh(sp);
    const ph = analysis.physical[sel.id]; const cum = cumulativeTo(ph, state.periodId, state.frame, sel.id);
    $("pDist").textContent = fmt.km(cum.distance); $("pSprints").textContent = `${cum.sprints}`; $("pTop").textContent = fmt.kmh(cum.top); $("pHsr").textContent = fmt.km(cum.hsr); $("pAcc").textContent = `${cum.accels}`;
    drawSpeedTrace(sel.id);
  } else { $("playerEmpty").classList.remove("hidden"); $("playerBody").classList.add("hidden"); }

  // Counterfactual What-If Delta Banner
  const shortLast = last => last === "Cavaco Cancelo" ? "Cancelo" : last;
  const wd = $("whatIfDelta");
  if (state.whatIf.size && an.options && an.baseOptions) {
    const movedPlayers = fr.players.filter(p => p.tracked);
    const movedSummary = movedPlayers.map(p => {
      const m = names.get(p.id);
      return `#${m.shirt} ${shortLast(m.last)} · Δ ${Math.hypot(p.x - p.tracked.x, p.y - p.tracked.y).toFixed(1)} m`;
    }).join(", ");
    const baseById = new Map(an.baseOptions.ranked.map(o => [o.id, o]));
    const deltas = [];
    for (const opt of an.options.ranked) {
      const b = baseById.get(opt.id);
      if (!b) continue;
      const blocked = !!opt.newlyBlocked;
      const promoted = !!opt.newlyPromoted;
      if (blocked || promoted || Math.abs(opt.prob - b.prob) >= 0.03) {
        const m = names.get(opt.id);
        deltas.push({
          id: opt.id,
          label: `#${m.shirt} ${shortLast(m.last)}`,
          from: `${fmt.pct(b.prob)} (#${b.rank})`,
          to: `${fmt.pct(opt.prob)} (#${opt.rank}${blocked ? " · Blocked" : promoted ? " · Best" : ""})`,
          cls: blocked || opt.prob < b.prob - 0.03 ? "wd-down" : "wd-up",
          priority: promoted ? 0 : blocked ? 1 : 2,
        });
      }
    }
    deltas.sort((a, b) => a.priority - b.priority);
    wd.classList.remove("hidden");
    wd.innerHTML = `<div class="wd-head"><span>What-If vs Tracked</span><span>${movedSummary}</span></div>` +
      `<div class="wd-rows">${deltas.slice(0, 3).map(d => `<div class="wd-row"><span>${d.label}</span><span class="${d.cls}">${d.from} → ${d.to}</span></div>`).join("") || `<div class="wd-row"><span>Position adjusted</span><span>Surface updated</span></div>`}</div>`;
  } else {
    wd.classList.add("hidden");
    wd.innerHTML = "";
  }

  // options table
  const tb = $("optionsTable").querySelector("tbody");
  if (an.options && fr.inPlay) {
    const o = an.options; const played = an.showPass ? an.pass.recipient : null;
    const baseById = an.baseOptions ? new Map(an.baseOptions.ranked.map(x => [x.id, x])) : null;
    $("optionsMeta").textContent = `${an.carrier ? pname(an.carrier.id) : "—"} ${an.hypothetical ? "if on the ball (hypothetical)" : "on the ball"}`;
    const rows = [...o.ranked, ...o.options.filter(q => q.offside)];
    const sig = rows.map(opt => `${opt.id}${opt.offside ? "o" : `${Math.round(opt.prob * 100)}${Math.round(opt.control * 100)}${Math.round(opt.laneRisk * 100)}${opt.gain.toFixed(3)}${opt.distance.toFixed(0)}${opt.newlyBlocked ? "B" : ""}${opt.newlyPromoted ? "P" : ""}`}`).join("|") + played + (state.whatIf.size ? ":wi" : "");
    if (sig !== optionsSig) {
      optionsSig = sig; tb.innerHTML = "";
      for (const opt of rows) {
        const tr = document.createElement("tr"); const m = names.get(opt.id);
        const baseOpt = baseById ? baseById.get(opt.id) : null;
        const isBlocked = !!opt.newlyBlocked;
        const isPromoted = !!opt.newlyPromoted;
        tr.className = `${opt === o.best ? "best" : ""} ${opt.id === played ? "played" : ""} ${opt.offside ? "offside" : opt.gain < 0 ? "neg" : ""}`;
        let badges = "";
        if (opt.id === played) badges += '<span class="tag">played</span>';
        if (isBlocked) badges += '<span class="tag blocked">blocked</span>';
        else if (isPromoted && baseOpt) badges += `<span class="tag promoted">#${baseOpt.rank}→#1</span>`;
        tr.innerHTML = `<td>${opt.offside ? "—" : opt.rank}</td><td class="name"><span class="sh">${m.shirt}</span>${shortLast(m.last)}${badges}</td><td class="num score-col">${opt.offside ? "offside" : fmt.pct(opt.prob)}</td><td class="num muted">${opt.offside ? "" : fmt.pct(opt.control)}</td><td class="num muted">${opt.offside ? "" : fmt.pct(opt.laneRisk)}</td><td class="num">${opt.offside ? "" : fmt.d3(opt.gain)}</td><td class="num">${opt.distance.toFixed(0)}</td>`;
        tr.onclick = () => { state.selectedId = opt.id; needsRender = true; writeURL(); };
        tr.onmouseenter = () => { state.hoverId = opt.id; needsRender = true; }; tr.onmouseleave = () => { if (state.hoverId === opt.id) { state.hoverId = null; needsRender = true; } };
        tb.appendChild(tr);
      }
    }
    $("holdLine").textContent = `xT keeping the ball ${o.ballXT.toFixed(3)} · P = (1 − lane risk) × control at target`;
  } else { if (optionsSig !== "") { optionsSig = ""; tb.innerHTML = ""; } $("optionsMeta").textContent = fr.inPlay ? "options hidden" : "ball out of play"; $("holdLine").textContent = ""; }

  // shape
  for (const t of ["home", "away"]) {
    const s = an.shapes[t]; const tr = $(t === "home" ? "shapeHome" : "shapeAway"); const tds = tr.children;
    tds[0].textContent = shortTeam(t); tds[0].className = "team"; tds[1].textContent = fmt.m1(s.defensiveLineHeight); tds[2].textContent = fmt.m1(s.length); tds[3].textContent = fmt.m1(s.width); tds[4].textContent = fmt.m0(s.hullArea); tds[5].textContent = s.lineGaps.map(g => g.toFixed(0)).join(" / ");
  }
  // ppda
  for (const t of ["home", "away"]) {
    const tr = $(t === "home" ? "ppdaHome" : "ppdaAway"); const tds = tr.children;
    const roll = ppda(data.events, t, dirHome, { period: state.periodId, from: state.frame - analysis.ppda.windowFrames, to: state.frame });
    const half = ppda(data.events, t, dirHome, { period: state.periodId, from: -Infinity, to: state.frame });
    const match = state.periodId === 1 ? half : sumPPDA(analysis.ppda[t].halves[0], half);
    tds[0].textContent = shortTeam(t); tds[0].className = "team";
    tds[1].textContent = fmtPPDA(roll); tds[2].textContent = fmtPPDA(half); tds[3].textContent = fmtPPDA(match);
  }
  drawPPDATrace();
  $("perf").textContent = `surface ${state.surfaceGrid ? `${state.surfaceGrid.nx}×${state.surfaceGrid.ny}` : ""} · ${state.perf.control.toFixed(0)} ms worker${state.surfaceMode === "value" ? ` + ${state.perf.value.toFixed(0)} ms value` : ""} · ${state.perf.roundTrip >= state.perf.control ? `${state.perf.roundTrip.toFixed(0)} ms` : "—"} round trip`;
  $("whatIfLabel").classList.toggle("hidden", !state.whatIf.size); $("resetWhatIf").classList.toggle("hidden", !state.whatIf.size);
}

function liveScore(periodId, frame) {
  let home = 0, away = 0;
  for (const e of data.events) if ((e.kind === "ShotAtGoal" || e.action === "ShotAtGoal") && e.sub === "SuccessfulShot" && (e.period < periodId || (e.period === periodId && e.frame <= frame))) { if (e.Team === "home") home++; else away++; }
  return { home, away };
}
const fmtPPDA = r => r.ppda === null ? (r.passes ? `${r.passes}/0` : "—") : `${r.ppda.toFixed(1)}`;
const sumPPDA = (a, b) => ({ passes: a.passes + b.passes, actions: a.actions + b.actions, ppda: (a.actions + b.actions) ? (a.passes + b.passes) / (a.actions + b.actions) : null });
const pname = id => { const m = names.get(id); return m ? m.last : id; };
const shortTeam = t => t === "home" ? "Köln" : "Bayern";
const posName = p => ({ TW: "Goalkeeper", IVL: "Centre-back (L)", IVR: "Centre-back (R)", IVZ: "Centre-back", LV: "Left-back", RV: "Right-back", DML: "Def. midfield (L)", DMR: "Def. midfield (R)", DMZ: "Def. midfield", ZO: "Attacking midfield", OLM: "Left midfield", ORM: "Right midfield", LM: "Left midfield", RM: "Right midfield", HL: "Half-left", HR: "Half-right", STL: "Striker (L)", STR: "Striker (R)", STZ: "Striker", MZ: "Central midfield", RA: "Right wing", LA: "Left wing" })[p] || p;

function cumulativeTo(ph, periodId, frame, id) {
  const per = data.period(periodId); const ci = data.chunkIndex(per, frame);
  const before = ph.cumulative.filter(c => c.period < periodId || (c.period === periodId && c.chunk < ci)).pop();
  const base = { distance: before ? before.distance : 0, sprints: before ? before.sprints : 0, hsr: before ? before.hsr : 0, top: before ? (before.top || 0) : 0, accels: before ? (before.accels || 0) : 0 };
  const chunk = currentChunk(frame); if (!chunk) return base;
  const s = chunk.slots.indexOf(id); if (s < 0) return base;
  const acc = new PhysicalAccumulator();
  for (let f = 0; f <= frame - chunk.start; f++) { if (Number.isNaN(chunk.x[f * chunk.ns + s])) continue; const [vx, vy] = chunkVelocity(chunk, s, f); acc.push(Math.hypot(vx, vy)); }
  return { distance: base.distance + acc.distance, sprints: base.sprints + acc.sprints, hsr: base.hsr + acc.hsrDistance, top: Math.max(base.top, acc.topSpeed), accels: base.accels + acc.accelerations };
}
function drawSpeedTrace(id) {
  const c = $("speedTrace"); const w = c.clientWidth || 280; c.width = w * 2; c.height = 72; const ctx = c.getContext("2d"); ctx.scale(2, 2);
  const chunk = currentChunk(); if (!chunk) return; const s = chunk.slots.indexOf(id); if (s < 0) return;
  const lf = state.frame - chunk.start; const n = 250;
  ctx.clearRect(0, 0, w, 36); ctx.strokeStyle = "rgba(255,255,255,0.10)"; for (const v of [5.5, 7]) { const y = 34 - v / 10 * 30; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.beginPath(); ctx.strokeStyle = COLORS.best; ctx.lineWidth = 1.5;
  for (let k = 0; k < n; k++) { const f = lf - n + 1 + k; if (f < 0) continue; const [vx, vy] = chunkVelocity(chunk, s, f); const sp = Math.hypot(vx, vy); const x = k / (n - 1) * w, y = 34 - Math.min(10, sp) / 10 * 30; k === 0 || f === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke(); ctx.fillStyle = "rgba(143,152,168,0.9)"; ctx.font = "500 9px 'JetBrains Mono'"; ctx.textAlign = "right"; ctx.fillText("speed · last 10 s · 19.8 / 25.2 km/h", w, 8); ctx.textAlign = "left";
}
function drawPPDATrace() {
  const c = $("ppdaTrace"); const w = c.clientWidth || 280; c.width = w * 2; c.height = 112; const ctx = c.getContext("2d"); ctx.scale(2, 2);
  const rows = analysis.ppda.rolling; const total = data.match.periods[0].frames + data.match.periods[1].frames;
  const gx = (p, f) => ((p === 2 ? data.match.periods[0].frames : 0) + f) / total * w;
  ctx.clearRect(0, 0, w, 56); const maxV = 20;
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; for (const v of [5, 10, 15]) { const y = 52 - v / maxV * 44; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  for (const t of ["home", "away"]) {
    ctx.beginPath(); ctx.strokeStyle = t === "home" ? "rgba(255,72,92,0.95)" : "rgba(64,140,255,0.95)"; ctx.lineWidth = 1.5; let started = false;
    for (const r of rows) { const v = r[t].ppda; if (v === null) { started = false; continue; } const x = gx(r.period, r.frame), y = 52 - Math.min(maxV, v) / maxV * 44; if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  const cx = gx(state.periodId, state.frame); ctx.strokeStyle = COLORS.best; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, 54); ctx.stroke();
  ctx.fillStyle = "rgba(143,152,168,0.9)"; ctx.font = "500 9px 'JetBrains Mono'"; ctx.fillText("20", 0, 8); ctx.fillText("0", 0, 54); const hx = gx(2, 0); ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.moveTo(hx, 4); ctx.lineTo(hx, 54); ctx.stroke(); ctx.fillText("HT", hx + 3, 8);
}

// ---------------------------------------------------------------- timeline
function totalFrames() { return data.match.periods[0].frames + data.match.periods[1].frames; }
function globalPos(periodId, frame) { return ((periodId === 2 ? data.match.periods[0].frames : 0) + frame) / totalFrames(); }
function fromGlobal(u) { const g = Math.round(u * totalFrames()); const p1 = data.match.periods[0].frames; return g < p1 ? [1, Math.max(0, Math.min(p1 - 1, g))] : [2, Math.max(0, Math.min(data.match.periods[1].frames - 1, g - p1))]; }
function drawScrub() {
  const w = scrub.clientWidth, h = 38; scrub.width = w * 2; scrub.height = h * 2; const ctx = scrub.getContext("2d"); ctx.scale(2, 2);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#1a1f28"; roundRect(ctx, 0, 14, w, 10, 3); ctx.fill();
  for (const per of data.match.periods) per.chunks.forEach((c, i) => { if (data.chunks.has(data.key(per.id, i))) { const a = globalPos(per.id, c.start) * w, b = globalPos(per.id, c.start + c.frames) * w; ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(a, 14, Math.max(1, b - a), 10); } });
  const hx = globalPos(2, 0) * w; ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(hx - 0.5, 10, 1, 18);
  for (const b of analysis.bookmarks) {
    const x = globalPos(b.period, b.focus) * w;
    if (b.type === "goal") { ctx.fillStyle = COLORS.best; ctx.beginPath(); ctx.arc(x, 8, 3.5, 0, Math.PI * 2); ctx.fill(); }
    else if (b.type === "shot") { ctx.fillStyle = "rgba(231,233,238,0.7)"; ctx.fillRect(x - 0.5, 5, 1, 7); }
    else if (b.type === "var") { ctx.fillStyle = COLORS.offside; ctx.fillRect(x - 1, 5, 2, 7); }
    else if (b.type === "linebreak") { ctx.fillStyle = "#7ee0c3"; ctx.fillRect(x - 0.5, 27, 1, 6); }
    else if (b.type === "press") { ctx.fillStyle = "#c58cff"; ctx.fillRect(x - 0.5, 27, 1, 6); }
  }
  ctx.fillStyle = "rgba(143,152,168,0.9)"; ctx.font = "500 9px 'JetBrains Mono'"; ctx.textAlign = "left"; ctx.fillText("00:00", 0, 37); ctx.textAlign = "center"; ctx.fillText("HT", hx, 37); ctx.textAlign = "right"; ctx.fillText(clockText(2, data.match.periods[1].frames - 1), w, 37);
  const px = globalPos(state.periodId, state.frame) * w; ctx.fillStyle = COLORS.best; ctx.fillRect(px - 1, 12, 2, 14); ctx.beginPath(); ctx.moveTo(px - 5, 12); ctx.lineTo(px + 5, 12); ctx.lineTo(px, 17); ctx.closePath(); ctx.fill();
}
async function seek(periodId, frame, initial = false) {
  const per = data.period(periodId); frame = Math.max(0, Math.min(per.frames - 1, Math.round(frame)));
  state.periodId = periodId; state.frame = frame; state.sub = 0; state.playhead = frame; clearWhatIf(false); lastFrameKey = "";
  if (!data.has(periodId, frame)) { $("loading").textContent = "Loading tracking chunk…"; $("app").dataset.state = "loading"; await data.ensure(periodId, frame, 1); if (!initial) $("app").dataset.state = "ready"; }
  else data.ensure(periodId, frame, 1);
  needsRender = true; drawScrub(); writeURL(); updateBookmarkChips();
}
function setPlaying(on) { state.playing = on; state.lastTs = 0; $("playIcon").setAttribute("d", on ? "M3 2.5h3.5v11H3z M9.5 2.5H13v11H9.5z" : "M4 2.5v11l9-5.5z"); if (on && state.whatIf.size) clearWhatIf(false); }
function step(n) { setPlaying(false); let f = state.frame + n, p = state.periodId; const per = data.period(p); if (f < 0) f = 0; if (f >= per.frames) f = per.frames - 1; seek(p, f); }

// ---------------------------------------------------------------- what-if & pointer (2D + 3D)
function clearWhatIf(rerender = true) {
  state.whatIfAnim = null;
  $("whatIfPresetBtn").classList.remove("active");
  $("whatIfPocketBtn").classList.remove("active");
  if (!state.whatIf.size) return;
  state.whatIf.clear(); state.whatIfFrame = null; lastFrameKey = "";
  if (rerender) needsRender = true;
}

async function runWhatIfPreset(mode) {
  setPlaying(false);
  // Ensure we are on the 88:11 key pass frame (P2 f 64794) where Gnabry passes to Musiala before the 88:14 title winner
  if (state.periodId !== 2 || state.frame !== 64794) {
    await seek(2, 64794);
  }
  const fr = buildFrame();
  if (!fr) return;
  const martelId = "DFL-OBJ-002GKO"; // Köln #6 Eric Martel
  const canceloId = "DFL-OBJ-J015S4"; // Bayern #22 João Cancelo
  const baseMartel = fr.trackedPlayers.find(p => p.id === martelId);
  const baseCancelo = fr.trackedPlayers.find(p => p.id === canceloId);
  if (!baseMartel || !baseCancelo) return;

  const curMartel = fr.players.find(p => p.id === martelId) || baseMartel;
  let toX = baseMartel.x, toY = baseMartel.y;
  if (mode === "block_cancelo") {
    toX = (fr.trackedBall.x + baseCancelo.x) * 0.5;
    toY = (fr.trackedBall.y + baseCancelo.y) * 0.5;
    $("whatIfPresetBtn").classList.add("active");
    $("whatIfPocketBtn").classList.remove("active");
  } else if (mode === "open_musiala") {
    toX = baseMartel.x + 10.0;
    toY = baseMartel.y;
    $("whatIfPocketBtn").classList.add("active");
    $("whatIfPresetBtn").classList.remove("active");
  }
  state.selectedId = martelId;
  state.attackOverride = "away"; // Keep Bayern's attacking surface active while moving Köln defender #6 Martel
  state.whatIfFrame = `${state.periodId}:${state.frame}`;
  state.whatIfAnim = {
    pid: martelId,
    fromX: curMartel.x,
    fromY: curMartel.y,
    toX,
    toY,
    t0: performance.now(),
    duration: 2100,
  };
  needsRender = true;
}

function playerAt(px, py) {
  if (!lastFrameData) return null; const r = Math.max(10, renderer.m(1.4)); let best = null, bd = Infinity;
  for (const p of lastFrameData.players) { const [sx, sy] = renderer.toScreen(p.x, p.y); const d = Math.hypot(sx - px, sy - py); if (d < r && d < bd) { bd = d; best = p; } }
  return best;
}

function setupPointer() {
  let downAt = null, moved = false;
  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const p = playerAt(px, py); downAt = { px, py, p }; moved = false;
    if (p) { state.whatIfAnim = null; canvas.setPointerCapture(e.pointerId); state.dragId = p.id; canvas.classList.add("grabbing"); }
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (state.dragId && downAt) {
      if (Math.hypot(px - downAt.px, py - downAt.py) > 3) moved = true;
      if (moved) {
        if (state.playing) setPlaying(false);
        const [wx, wy] = renderer.toWorld(px, py);
        const isCarrier = lastAnalysis && lastAnalysis.actualCarrier && lastAnalysis.actualCarrier.id === state.dragId && !lastAnalysis.hypothetical;
        state.whatIfFrame = `${state.periodId}:${state.frame}`;
        state.whatIf.set(state.dragId, { x: Math.max(-renderer.L / 2 - 2, Math.min(renderer.L / 2 + 2, wx)), y: Math.max(-renderer.W / 2 - 2, Math.min(renderer.W / 2 + 2, wy)), ball: isCarrier });
        needsRender = true;
      }
      return;
    }
    const p = playerAt(px, py); const id = p ? p.id : null;
    if (id !== state.hoverId) { state.hoverId = id; canvas.classList.toggle("grab", !!id); needsRender = true; }
  });
  const up = () => {
    if (downAt && downAt.p && !moved) { state.selectedId = state.selectedId === downAt.p.id ? null : downAt.p.id; state.attackOverride = null; writeURL(); }
    state.dragId = null; downAt = null; canvas.classList.remove("grabbing"); needsRender = true;
  };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  // 3D Stadium Canvas Pointer: drag player on 3D turf for What-If, or drag empty space to orbit camera
  let down3d = null, moved3d = false;
  canvas3d.addEventListener("pointerdown", (e) => {
    const rect = canvas3d.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const p = lastFrameData ? renderer3d.playerAt(px, py, lastFrameData.players) : null;
    down3d = { px, py, lastX: px, lastY: py, p, orbit: !p || e.shiftKey || e.button === 2 };
    moved3d = false;
    canvas3d.setPointerCapture(e.pointerId);
    canvas3d.classList.add("grabbing");
    if (p && !down3d.orbit) { state.whatIfAnim = null; state.dragId = p.id; }
  });
  canvas3d.addEventListener("pointermove", (e) => {
    const rect = canvas3d.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (down3d) {
      if (Math.hypot(px - down3d.px, py - down3d.py) > 3) moved3d = true;
      if (moved3d) {
        if (down3d.orbit) {
          const dx = px - down3d.lastX, dy = py - down3d.lastY;
          down3d.lastX = px; down3d.lastY = py;
          renderer3d.orbit(-dx * 0.0065, dy * 0.005);
          needsRender = true;
        } else if (state.dragId) {
          if (state.playing) setPlaying(false);
          const [wx, wy] = renderer3d.screenToWorld(px, py, 0);
          const isCarrier = lastAnalysis && lastAnalysis.actualCarrier && lastAnalysis.actualCarrier.id === state.dragId && !lastAnalysis.hypothetical;
          state.whatIfFrame = `${state.periodId}:${state.frame}`;
          state.whatIf.set(state.dragId, { x: Math.max(-renderer.L / 2 - 2, Math.min(renderer.L / 2 + 2, wx)), y: Math.max(-renderer.W / 2 - 2, Math.min(renderer.W / 2 + 2, wy)), ball: isCarrier });
          needsRender = true;
        }
      }
      return;
    }
    const p = lastFrameData ? renderer3d.playerAt(px, py, lastFrameData.players) : null;
    const id = p ? p.id : null;
    if (id !== state.hoverId) { state.hoverId = id; canvas3d.classList.toggle("grab", !!id); needsRender = true; }
  });
  const up3d = () => {
    if (down3d && down3d.p && !moved3d) { state.selectedId = state.selectedId === down3d.p.id ? null : down3d.p.id; state.attackOverride = null; writeURL(); }
    state.dragId = null; down3d = null; canvas3d.classList.remove("grabbing"); needsRender = true;
  };
  canvas3d.addEventListener("pointerup", up3d); canvas3d.addEventListener("pointercancel", up3d);
  canvas3d.addEventListener("wheel", (e) => {
    e.preventDefault();
    renderer3d.zoom(e.deltaY > 0 ? 1.07 : 0.93);
    needsRender = true;
  }, { passive: false });
}

// ---------------------------------------------------------------- UI wiring
function setView(view, updateLayout = true) {
  if (!["2d", "split", "3d"].includes(view)) return;
  state.viewMode = view;
  stageGrid.dataset.view = view;
  document.querySelectorAll("#viewSeg [data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  if (updateLayout) { layout(); writeURL(); }
  needsRender = true;
}

function setCamPreset(preset) {
  if (!["spidercam", "broadcast", "carrier"].includes(preset)) return;
  state.camPreset = preset;
  document.querySelectorAll("#cam3dBar [data-cam]").forEach(b => b.classList.toggle("on", b.dataset.cam === preset));
  if (renderer3d) renderer3d.setPreset(preset, lastFrameData, lastAnalysis, true);
  needsRender = true;
}

function setMode(mode) {
  if (!["control", "value", "off"].includes(mode)) return; state.surfaceMode = mode;
  document.querySelectorAll("#surfaceSeg [data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  const lg = $("legend"); lg.querySelector(".sw.home").parentElement.classList.toggle("hidden", mode !== "control"); lg.querySelector(".sw.away").parentElement.classList.toggle("hidden", mode !== "control"); lg.querySelector(".sw.frontier").parentElement.classList.toggle("hidden", mode !== "control");
  lg.querySelector(".sw.gain").parentElement.classList.toggle("hidden", mode !== "value"); lg.querySelector(".sw.loss").parentElement.classList.toggle("hidden", mode !== "value");
  lastFrameKey = ""; needsRender = true;
}
function toggle(key, btn, force) { state[key] = force === undefined ? !state[key] : force; btn.classList.toggle("on", state[key]); btn.setAttribute("aria-pressed", String(state[key])); needsRender = true; }
let activeChip = null, chipScrolled = false;
function updateBookmarkChips() {
  let first = null;
  document.querySelectorAll("#bookmarks button").forEach(b => { const bm = analysis.bookmarks[+b.dataset.i]; const on = bm.period === state.periodId && state.frame >= bm.frame && state.frame <= bm.focus + 125; b.classList.toggle("on", on); if (on && !first) first = b; });
  if (!first) { const i = analysis.bookmarks.findIndex(bm => bm.period > state.periodId || (bm.period === state.periodId && bm.focus >= state.frame)); if (i >= 0) first = document.querySelector(`#bookmarks button[data-i="${i}"]`); }
  if (first && first !== activeChip) { const wrap = $("bookmarks"); const target = first.offsetLeft - 16; if (wrap.clientWidth === 0) return; activeChip = first; if (Math.abs(wrap.scrollLeft - target) > 4) wrap.scrollTo({ left: Math.max(0, target), behavior: chipScrolled ? "smooth" : "auto" }); chipScrolled = true; }
}
function setupUI() {
  $("matchTitle").textContent = `${data.match.home.name} v ${data.match.away.name} · ${data.match.competition} · MD${data.match.matchDay} · ${new Date(data.match.kickoff).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  $("score").textContent = data.match.result.replace(":", " : ");
  $("legendHome").textContent = "Köln control"; $("legendAway").textContent = "Bayern control";
  document.querySelectorAll("#viewSeg [data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  document.querySelectorAll("#cam3dBar [data-cam]").forEach(b => b.onclick = () => setCamPreset(b.dataset.cam));
  document.querySelectorAll("#surfaceSeg [data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll(".seg [data-speed]").forEach(b => b.onclick = () => { state.speed = +b.dataset.speed; document.querySelectorAll(".seg [data-speed]").forEach(x => x.classList.toggle("on", x === b)); });
  $("toggleShape").onclick = () => toggle("showShape", $("toggleShape"));
  $("toggleVelocity").onclick = () => toggle("showVelocity", $("toggleVelocity"));
  $("toggleOptions").onclick = () => toggle("showOptions", $("toggleOptions"));
  $("playBtn").onclick = () => setPlaying(!state.playing);
  $("stepBack").onclick = () => step(-1); $("stepFwd").onclick = () => step(1);
  $("swapAttack").onclick = () => { const cur = lastAnalysis ? lastAnalysis.attTeam : "home"; state.attackOverride = cur === "home" ? "away" : "home"; state.selectedId = null; lastFrameKey = ""; needsRender = true; };
  $("whatIfPresetBtn").onclick = () => runWhatIfPreset("block_cancelo");
  $("whatIfPocketBtn").onclick = () => runWhatIfPreset("open_musiala");
  $("resetWhatIf").onclick = () => clearWhatIf(true);
  $("exportBtn").onclick = exportFrame;
  $("infoBtn").onclick = () => { $("drawerBody").innerHTML = drawerHTML(data.match, analysis, xt.m, P, state, validation, cfVerification); $("drawer").classList.remove("hidden"); };
  $("drawerClose").onclick = () => $("drawer").classList.add("hidden");
  $("exportClose").onclick = () => $("exportBox").classList.add("hidden");
  $("exportBox").onclick = (e) => { if (e.target === $("exportBox")) $("exportBox").classList.add("hidden"); };
  $("drawer").addEventListener("click", (e) => { if (e.target === $("drawer")) $("drawer").classList.add("hidden"); });
  // bookmarks
  const bmWrap = $("bookmarks");
  analysis.bookmarks.forEach((b, i) => { const btn = document.createElement("button"); btn.className = `bm-${b.type}`; btn.dataset.i = i; btn.innerHTML = `<i></i>${clockText(b.period, b.focus)} ${b.label}`; btn.title = b.label; btn.onclick = () => { setPlaying(false); seek(b.period, b.frame); if (b.type === "linebreak" && b.passId) { const p = analysis.passes.find(q => q.id === b.passId); if (p) { seek(b.period, p.frame); state.selectedId = p.player; } } }; bmWrap.appendChild(btn); });
  // scrubber
  let scrubbing = false;
  const scrubTo = (e) => { const rect = scrub.getBoundingClientRect(); const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)); const [p, f] = fromGlobal(u); seek(p, f); };
  scrub.addEventListener("pointerdown", (e) => { scrubbing = true; scrub.setPointerCapture(e.pointerId); setPlaying(false); scrubTo(e); });
  scrub.addEventListener("pointermove", (e) => { const rect = scrub.getBoundingClientRect(); const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)); const [p, f] = fromGlobal(u); const tip = $("scrubTip"); tip.classList.remove("hidden"); tip.style.left = `${(e.clientX - rect.left)}px`; tip.textContent = clockText(p, f); if (scrubbing) scrubTo(e); });
  scrub.addEventListener("pointerleave", () => $("scrubTip").classList.add("hidden"));
  scrub.addEventListener("pointerup", (e) => {
    scrubbing = false;
    const rect = scrub.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top; if (y > 13) return;
    let best = null, bd = 6; for (const b of analysis.bookmarks) { if (b.type !== "goal" && b.type !== "shot" && b.type !== "var") continue; const d = Math.abs(globalPos(b.period, b.focus) * rect.width - x); if (d < bd) { bd = d; best = b; } }
    if (best) seek(best.period, best.frame);
  });
  setupPointer();
  // keyboard
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); setPlaying(!state.playing); }
    else if (k === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 25 : 1); }
    else if (k === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -25 : -1); }
    else if (k === "c") setMode("control"); else if (k === "p") setMode("value"); else if (k === "o") setMode("off");
    else if (k === "d") setView("2d"); else if (k === "b") setView("split"); else if (k === "g") setView("3d");
    else if (k === "s") toggle("showShape", $("toggleShape")); else if (k === "v") toggle("showVelocity", $("toggleVelocity")); else if (k === "x") toggle("showOptions", $("toggleOptions"));
    else if (k === "w") runWhatIfPreset("block_cancelo");
    else if (k === "e") exportFrame(); else if (k === "?") $("infoBtn").click(); else if (k === "Escape") { $("drawer").classList.add("hidden"); $("exportBox").classList.add("hidden"); clearWhatIf(true); }
    else if (k === "]" || k === "[") { const bms = analysis.bookmarks; const cur = bms.findIndex(b => b.period === state.periodId && b.frame >= state.frame - 1); let i = k === "]" ? (cur < 0 ? bms.length - 1 : cur) : cur - 1; if (k === "]" && bms[i] && bms[i].frame === state.frame && bms[i].period === state.periodId) i++; i = Math.max(0, Math.min(bms.length - 1, i)); const b = bms[i]; setPlaying(false); seek(b.period, b.frame); }
    else if (k === "1") seek(1, 0); else if (k === "2") seek(2, 0);
  });
  window.addEventListener("resize", layout);
}
function layout() {
  const rStage = stage.getBoundingClientRect();
  if (state.viewMode === "2d") {
    renderer.resize(Math.floor(rStage.width), Math.floor(rStage.height));
  } else if (state.viewMode === "3d") {
    renderer3d.resize(Math.floor(rStage.width), Math.floor(rStage.height));
  } else {
    const r2 = pane2d.getBoundingClientRect();
    const r3 = pane3d.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.floor(r2.width)), Math.max(1, Math.floor(r2.height)));
    renderer3d.resize(Math.max(1, Math.floor(r3.width)), Math.max(1, Math.floor(r3.height)));
  }
  needsRender = true; drawScrub(); drawPPDATrace();
}

// ---------------------------------------------------------------- export
function exportFrame() {
  if (!lastFrameData || !lastAnalysis) return;
  const fr = lastFrameData, an = lastAnalysis; const W = 1920, H = 1080, head = 92, foot = 64;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d");
  ctx.fillStyle = "#0b0d10"; ctx.fillRect(0, 0, W, H);
  const r2 = new PitchRenderer(document.createElement("canvas"), data.match.pitch); r2.flipX = renderer.flipX; r2.resize(W, H - head - foot, 1);
  const pc = r2.canvas.getContext("2d"); r2.drawPitch(pc);
  if (state.surfaceMode === "control" && state.surface) { r2.drawSurface(pc, state.surface, state.surfaceGrid, "control", an.attTeam); r2.drawFrontier(pc, state.surface, state.surfaceGrid); }
  else if (state.surfaceMode === "value" && state.valueSurface) r2.drawSurface(pc, state.valueSurface, state.surfaceGrid, "value", an.attTeam);
  if (state.showShape) { r2.drawShape(pc, an.shapes.home, "home"); r2.drawShape(pc, an.shapes.away, "away"); }
  for (const p of fr.players) if (p.tracked) r2.drawGhost(pc, p.tracked, p, shirts.get(p.id));
  if (an.options && fr.inPlay) r2.drawOptions(pc, an.options, an.origin, fr.players, an.showPass ? { recipient: an.pass.recipient } : null, state.selectedId);
  r2.drawPlayers(pc, fr.players, shirts, { selectedId: state.selectedId, carrierId: an.carrier ? an.carrier.id : null, showVelocity: state.showVelocity, offsideIds: an.offsideIds });
  r2.drawBall(pc, fr.ball);
  if (an.options && fr.inPlay) r2.drawOptionChips(pc, an.options, fr.players, state.whatIf.size > 0);
  ctx.drawImage(r2.canvas, 0, head);
  // header
  ctx.fillStyle = "#e7e9ee"; ctx.font = "600 30px 'Barlow Condensed'"; ctx.textBaseline = "alphabetic";
  const live = liveScore(state.periodId, state.frame);
  ctx.fillText(`${data.match.home.name} ${live.home} – ${live.away} ${data.match.away.name}`, 28, 42);
  ctx.font = "700 40px 'Barlow Condensed'"; ctx.fillStyle = COLORS.best; ctx.textAlign = "right"; ctx.fillText(clockText(state.periodId, state.frame), W - 28, 46); ctx.textAlign = "left";
  ctx.font = "400 17px 'Switzer'"; ctx.fillStyle = "#8f98a8";
  const sel = state.selectedId ? names.get(state.selectedId) : null;
  const modeTxt = state.surfaceMode === "control" ? `pitch control for ${data.match[an.attTeam].name}` : state.surfaceMode === "value" ? `pass value (Δ xT) for ${data.match[an.attTeam].name}` : "no surface";
  ctx.fillText(`${data.match.competition} MD${data.match.matchDay} · ${state.periodId === 1 ? "1st" : "2nd"} half · frame ${state.frame} · ${modeTxt}${sel ? ` · selected ${sel.shirt} ${sel.first} ${sel.last}` : ""}${state.whatIf.size ? " · what-if positions (ghosts show tracked positions)" : ""}`, 28, 72);
  // metrics strip
  const s = an.shapes; const txt = [`Köln def line ${s.home.defensiveLineHeight.toFixed(1)} m · hull ${Math.round(s.home.hullArea)} m²`, `Bayern def line ${s.away.defensiveLineHeight.toFixed(1)} m · hull ${Math.round(s.away.hullArea)} m²`];
  if (an.options && an.options.best) txt.push(`best option ${names.get(an.options.best.id).last} P ${Math.round(an.options.best.prob * 100)}% · Δ xT ${fmt.d3(an.options.best.gain)}`);
  ctx.font = "400 15px 'JetBrains Mono'"; ctx.fillStyle = "#c9cfd9"; ctx.fillText(txt.join("    "), 28, H - 38);
  ctx.font = "400 13px 'Switzer'"; ctx.fillStyle = "#8f98a8";
  ctx.fillText(`Tracking & event data: DFL / Sportec Solutions, via Bassek, Rein, Weber & Memmert (2025) Sci Data, figshare 10.6084/m9.figshare.28196177 · CC BY 4.0. Pitch control: Spearman (2018), reference parameters. xT: 12×8 grid trained on the open Wyscout dataset (Pappalardo et al. 2019, CC BY 4.0).`, 28, H - 16);
  const name = `pressing-matters_P${state.periodId}_f${state.frame}_${clockText(state.periodId, state.frame).replace(":", "m")}s.png`;
  c.toBlob((blob) => {
    if (exportURL) URL.revokeObjectURL(exportURL);
    exportURL = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = exportURL; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    $("exportImg").src = exportURL; $("exportLink").href = exportURL; $("exportLink").download = name;
    $("exportName").textContent = `${name} · ${W}×${H} · ${(blob.size / 1024).toFixed(0)} KB`;
    $("exportBox").classList.remove("hidden");
  }, "image/png");
}

window.__studio = {
  state,
  seek: async (p, f) => {
    await seek(p, f);
    render();
    await new Promise((r) => setTimeout(r, 18));
    render();
  },
  setWhatIf: async (pid, x, y, selId = pid) => {
    state.whatIfAnim = null;
    state.selectedId = selId;
    state.attackOverride = "away";
    state.whatIfFrame = `${state.periodId}:${state.frame}`;
    state.whatIf.set(pid, { x, y, ball: false });
    lastFrameKey = "";
    needsRender = true;
    render();
    await new Promise((r) => setTimeout(r, 18));
    render();
  },
  clearWhatIf: async () => {
    clearWhatIf(true);
    state.selectedId = null;
    state.attackOverride = null;
    lastFrameKey = "";
    render();
    await new Promise((r) => setTimeout(r, 18));
    render();
  },
  toViewport: (wx, wy) => {
    const rect = canvas.getBoundingClientRect();
    const [sx, sy] = renderer.toScreen(wx, wy);
    return { x: rect.left + sx, y: rect.top + sy };
  },
};

boot();
