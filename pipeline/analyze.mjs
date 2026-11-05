// Match-wide analysis with the SAME model code the app runs live. Produces app/data/analysis.json:
// pass log (option values, line breaks), bookmarks, PPDA (match, halves, rolling), physical profiles.
import fs from "node:fs/promises";
import { MatchData, nodeLoader, snapshot, chunkVelocity } from "../app/src/data.js";
import { DEFAULT_PARAMS, derivedParams, makeScene, applyOffside, controlAtTarget, makeWork } from "../app/src/models/pitchcontrol.js";
import { XT } from "../app/src/models/xt.js";
import { teamShape, lineBreaks } from "../app/src/models/shape.js";
import { ppda, isPass, isDefensiveAction } from "../app/src/models/ppda.js";
import { PhysicalAccumulator, PHYS } from "../app/src/models/physical.js";
import { buildScene, ballCarrier, passOptions, laneRisk } from "../app/src/models/options.js";

const base = new URL("../app/data", import.meta.url).pathname;
const data = await MatchData.load(base, nodeLoader(base));
const xt = new XT(JSON.parse(await fs.readFile(`${base}/xt.json`, "utf8")));
const P = derivedParams(DEFAULT_PARAMS);
const M = data.match;
const dirHome = { 1: M.periods[0].homeAttacksRight ? 1 : -1, 2: M.periods[1].homeAttacksRight ? 1 : -1 };
const dirOf = (team, period) => team === "home" ? dirHome[period] : -dirHome[period];
const t0 = performance.now();
// load everything (Node has the memory); ~14 MB
for (const per of M.periods) for (let c = 0; c < per.chunks.length; c++) await data.loadChunk(per.id, c);
console.log("chunks loaded", ((performance.now() - t0) / 1000).toFixed(1), "s");

// ---- attach tracked ball positions to events without coordinates (fouls etc.)
for (const e of data.events) {
  const snap = snapshot(data, e.period, Math.min(Math.max(e.frame, 0), data.period(e.period).frames - 1));
  if (snap) { e.ballPos = [+snap.ball.x.toFixed(2), +snap.ball.y.toFixed(2)]; if (!e.pos) e.posSource = "tracking"; }
}

// ---- pass log
const passes = data.events.filter(e => (e.kind === "Play" || e.action === "Play"));
const log = [];
const nextEventAfter = (e) => { const i = data.events.indexOf(e); for (let j = i + 1; j < data.events.length; j++) { const n = data.events[j]; if (n.period === e.period && n.frame > e.frame && (n.pos || n.ballPos)) return n; } return null; };
for (const e of passes) {
  const per = data.period(e.period); if (e.frame < 0 || e.frame >= per.frames) continue;
  const snap = snapshot(data, e.period, e.frame); if (!snap) continue;
  const team = e.Team, dir = dirOf(team, e.period), defTeam = team === "home" ? "away" : "home";
  const passer = snap.players.find(p => p.id === e.Player);
  const recipient = e.Recipient ? snap.players.find(p => p.id === e.Recipient) : null;
  // reception / end point
  let endFrame = null, end = null;
  if (recipient && e.Evaluation !== "unsuccessful") {
    for (let f = e.frame + 3; f < Math.min(per.frames, e.frame + 150); f++) {
      const s = snapshot(data, e.period, f); const r = s.players.find(p => p.id === recipient.id); if (!r) break;
      if (Math.hypot(s.ball.x - r.x, s.ball.y - r.y) < 1.5) { endFrame = f; end = [r.x, r.y]; break; }
    }
  }
  if (!end) { const n = nextEventAfter(e); if (n && n.frame - e.frame < 150) { endFrame = n.frame; end = n.pos || n.ballPos; } }
  if (!end) { const f = Math.min(per.frames - 1, e.frame + 50); const s = snapshot(data, e.period, f); endFrame = f; end = [s.ball.x, s.ball.y]; }
  const start = passer ? [passer.x, passer.y] : (e.pos || [snap.ball.x, snap.ball.y]);
  // defending shape and line breaks at the pass frame
  const defShape = teamShape(snap.players.filter(p => p.team === defTeam), -dir);
  const breaks = lineBreaks(start[0], start[1], end[0], end[1], defShape);
  // option values at the pass frame
  const scene = buildScene(snap.players, team, { x: start[0], y: start[1] }, makeScene);
  const off = applyOffside(scene, P);
  const carrier = passer || ballCarrier(snap.players, team, snap.ball);
  const opts = passOptions(snap.players, scene, team, carrier ? carrier.id : null, xt, dir, P, off);
  const actual = recipient ? opts.options.find(o => o.id === recipient.id) : null;
  log.push({ id: e.id, period: e.period, frame: e.frame, endFrame, team, player: e.Player, recipient: e.Recipient || null, success: e.Evaluation !== "unsuccessful",
    openPlay: e.FromOpenPlay === "true", setPiece: e.kind !== "Play" ? e.kind : null, cross: e.sub === "Cross" || e.FlatCross === "true", height: e.Height, start: start.map(v => +v.toFixed(2)), end: end.map(v => +v.toFixed(2)),
    length: +Math.hypot(end[0] - start[0], end[1] - start[1]).toFixed(1),
    xtStart: +xt.at(start[0], start[1], dir).toFixed(4), xtEnd: +xt.at(end[0], end[1], dir).toFixed(4),
    breaks: breaks.filter(b => b.through).map(b => b.line), breaksAround: breaks.filter(b => !b.through).map(b => b.line),
    defLineHeight: +defShape.defensiveLineHeight.toFixed(1), defLength: +defShape.length.toFixed(1), defWidth: +defShape.width.toFixed(1),
    actual: actual && !actual.offside ? { control: +actual.control.toFixed(3), laneRisk: +actual.laneRisk.toFixed(3), prob: +actual.prob.toFixed(3), value: +actual.value.toFixed(4), gain: +actual.gain.toFixed(4), rank: actual.rank, of: opts.ranked.length } : (actual ? { offside: true } : null),
    best: opts.best ? { id: opts.best.id, control: +opts.best.control.toFixed(3), prob: +opts.best.prob.toFixed(3), value: +opts.best.value.toFixed(4), gain: +opts.best.gain.toFixed(4) } : null,
    endControl: +controlAtTarget(scene, end[0], end[1], P, makeWork(scene.n)).toFixed(3), endProb: +((1 - laneRisk(scene, start[0], start[1], end[0], end[1], P)) * controlAtTarget(scene, end[0], end[1], P, makeWork(scene.n))).toFixed(3),
    ballXT: +opts.ballXT.toFixed(4) });
}
console.log("passes analysed", log.length, "line-breaking (through)", log.filter(p => p.breaks.length).length, "defence-line breaks", log.filter(p => p.breaks.includes("defence")).length);

// ---- PPDA
const ppdaOut = {};
for (const team of ["home", "away"]) {
  ppdaOut[team] = { match: ppda(data.events, team, dirHome), halves: [1, 2].map(p => ppda(data.events, team, dirHome, { period: p, from: -Infinity, to: Infinity })) };
}
// rolling: 5-minute window (7500 frames) ending every 30 s (750 frames) — "rolling" uses elapsed clock
const rolling = [];
for (const per of M.periods) for (let f = 750; f <= per.frames; f += 750) {
  const row = { period: per.id, frame: f };
  for (const team of ["home", "away"]) { const r = ppda(data.events, team, dirHome, { period: per.id, from: f - 7500, to: f }); row[team] = r; }
  rolling.push(row);
}
console.log("PPDA", JSON.stringify(ppdaOut));

// ---- physical profiles per player (full match) and cumulative distance per chunk
const phys = {};
for (const per of M.periods) {
  for (let c = 0; c < per.chunks.length; c++) {
    const chunk = data.chunks.get(data.key(per.id, c));
    for (let s = 0; s < chunk.ns; s++) {
      const id = chunk.slots[s]; const acc = (phys[id] ||= { acc: new PhysicalAccumulator(), cumulative: [] });
      for (let f = 0; f < chunk.n; f++) {
        if (Number.isNaN(chunk.x[f * chunk.ns + s])) continue;
        const [vx, vy] = chunkVelocity(chunk, s, f); acc.acc.push(Math.sqrt(vx * vx + vy * vy));
      }
      acc.cumulative.push({ period: per.id, chunk: c, distance: +acc.acc.distance.toFixed(1), sprints: acc.acc.sprints, hsr: +acc.acc.hsrDistance.toFixed(1), top: +acc.acc.topSpeed.toFixed(3), accels: acc.acc.accelerations });
    }
  }
}
const physical = Object.fromEntries(Object.entries(phys).map(([id, v]) => [id, { ...v.acc.summary(), cumulative: v.cumulative }]));

// ---- bookmarks
const bookmarks = [];
const name = id => { const p = data.players.get(id); return p ? p.short : id; };
for (const e of data.events) {
  if (e.kind === "ShotAtGoal" || e.action === "ShotAtGoal") {
    const goal = e.result === "SuccessfulShot";
    bookmarks.push({ period: e.period, frame: Math.max(0, e.frame - 200), focus: e.frame, type: goal ? "goal" : "shot", team: e.Team, label: `${goal ? "Goal" : "Shot"} · ${name(e.Player)}${e.xG ? ` · xG ${(+e.xG).toFixed(2)}` : ""}`, xg: e.xG ? +e.xG : null });
  }
  if (e.kind === "GoalDisallowed") bookmarks.push({ period: e.period, frame: Math.max(0, e.frame - 250), focus: e.frame, type: "var", team: e.Team, label: `Goal disallowed (VAR) · ${name(e.Player)}` });
}
// best line-breaking passes by xT gain, open play
const lb = log.filter(p => p.openPlay && p.success && p.breaks.includes("defence") && p.actual).sort((a, b) => b.actual.gain - a.actual.gain).slice(0, 6);
for (const p of lb) bookmarks.push({ period: p.period, frame: Math.max(0, p.frame - 75), focus: p.frame, type: "linebreak", team: p.team, label: `Line-breaking pass · ${name(p.player)} → ${name(p.recipient)}`, passId: p.id });
// high turnovers (possession change in the opponent's half after a tackle)
for (const e of data.events) if (e.kind === "TacklingGame" && e.PossessionChange === "true" && e.pos) {
  const winnerTeam = e.WinnerTeam; const dir = dirOf(winnerTeam, e.period); const depth = dir * e.pos[0] + 52.5;
  if (depth > 70) bookmarks.push({ period: e.period, frame: Math.max(0, e.frame - 150), focus: e.frame, type: "press", team: winnerTeam, label: `High turnover · ${name(e.Winner)}` });
}
bookmarks.sort((a, b) => a.period - b.period || a.frame - b.frame);
bookmarks.unshift({ period: 1, frame: 0, focus: 0, type: "kickoff", label: "Kick-off" }, { period: 2, frame: 0, focus: 0, type: "kickoff", label: "Second half" });
bookmarks.sort((a, b) => a.period - b.period || a.frame - b.frame);

const out = { generated: new Date().toISOString(), params: P, dirHome, passes: log, ppda: { ...ppdaOut, rolling, windowFrames: 7500, stepFrames: 750 }, physical, bookmarks,
  events: data.events.filter(e => !e.pos && e.ballPos).map(e => ({ id: e.id, ballPos: e.ballPos })) };
await fs.writeFile(`${base}/analysis.json`, JSON.stringify(out));
console.log("bookmarks", bookmarks.length, "analysis.json", (await fs.stat(`${base}/analysis.json`)).size, "bytes", ((performance.now() - t0) / 1000).toFixed(1), "s");
