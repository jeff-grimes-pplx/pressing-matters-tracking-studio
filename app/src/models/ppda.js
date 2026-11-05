// PPDA — passes allowed per defensive action (Trainor 2014 convention).
// For the pressing team P over a frame range: opponent open-play passes that START in the zone divided by
// P's defensive actions (tackle attempts, interceptions, fouls) in the zone. Zone = the 60% of the pitch
// furthest from P's own goal, i.e. depth-from-own-goal >= 0.4 * pitch length. Positions are the event
// positions; events without coordinates (fouls) use the tracked ball position at the event frame.
export const PPDA_PARAMS = Object.freeze({ zoneFraction: 0.4, length: 105 });

export function isPass(e) { return (e.kind === "Play" || e.action === "Play") && e.FromOpenPlay === "true"; }
export function isDefensiveAction(e, team) {
  if (e.kind === "TacklingGame") {
    // the player WITHOUT ball control is the one making the defensive challenge
    const defTeam = e.WinnerRole === "withoutBallControl" ? e.WinnerTeam : e.LoserTeam;
    return defTeam === team;
  }
  if (e.kind === "BallClaiming") return e.Team === team && e.Type === "InterceptedBall";
  if (e.kind === "Foul") return e.TeamFouler === team;
  return false;
}
export function depthFromOwnGoal(e, dir, length = 105) {
  const x = e.pos ? e.pos[0] : (e.ballPos ? e.ballPos[0] : NaN);
  return dir * x + length / 2;
}
/** dirs: {1: dirHome, 2: dirHome} attacking direction of the HOME team per period. */
export function ppda(events, team, dirs, range = null, params = PPDA_PARAMS) {
  let passes = 0, actions = 0; const opp = team === "home" ? "away" : "home";
  for (const e of events) {
    if (range && (e.period !== range.period || e.frame < range.from || e.frame > range.to)) continue;
    if (range === null && e.period === undefined) continue;
    const dirHome = dirs[e.period]; const dir = team === "home" ? dirHome : -dirHome;
    const depth = depthFromOwnGoal(e, dir, params.length);
    if (Number.isNaN(depth) || depth < params.zoneFraction * params.length) continue;
    if (isPass(e) && e.Team === opp) passes++;
    else if (isDefensiveAction(e, team)) actions++;
  }
  return { passes, actions, ppda: actions ? passes / actions : null };
}
