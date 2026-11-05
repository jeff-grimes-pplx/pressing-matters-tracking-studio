// Physical profile from smoothed velocities (see velocity.js). Thresholds follow common practice:
// high-speed running > 5.5 m/s (19.8 km/h), sprinting > 7.0 m/s (25.2 km/h) sustained >= 1 s,
// high acceleration > 3 m/s² sustained >= 0.5 s. Distances integrate speed over 0.04 s frames.
// Top speed is the highest 0.52 s mean speed (13 frames), which suppresses single-frame tracking spikes.
export const PHYS = Object.freeze({ dt: 0.04, hsr: 5.5, sprint: 7.0, sprintMinFrames: 25, accel: 3.0, accelMinFrames: 13, accelSmooth: 12 });

/** Accumulates one player's profile from a speed series (m/s per frame). */
export class PhysicalAccumulator {
  constructor() { this.frames = 0; this.distance = 0; this.hsrDistance = 0; this.sprintDistance = 0; this.sprints = 0; this.topSpeed = 0; this.accelerations = 0; this._run = 0; this._accRun = 0; this._prevSpeeds = []; }
  push(speed) {
    const dt = PHYS.dt; this.frames++;
    const d = speed * dt; this.distance += d;
    if (speed > PHYS.hsr) this.hsrDistance += d;
    if (speed > PHYS.sprint) { this.sprintDistance += d; this._run++; if (this._run === PHYS.sprintMinFrames) this.sprints++; } else this._run = 0;
    // acceleration over a 0.48 s window
    this._prevSpeeds.push(speed); if (this._prevSpeeds.length > PHYS.accelSmooth + 1) this._prevSpeeds.shift();
    if (this._prevSpeeds.length > PHYS.accelSmooth) {
      let mean = 0; for (const v of this._prevSpeeds) mean += v; mean /= this._prevSpeeds.length;
      if (mean > this.topSpeed) this.topSpeed = mean; // top speed = highest 0.5 s mean, robust to single-frame spikes
      const a = (speed - this._prevSpeeds[0]) / (PHYS.accelSmooth * dt);
      if (a > PHYS.accel) { this._accRun++; if (this._accRun === PHYS.accelMinFrames) this.accelerations++; } else this._accRun = 0;
    }
  }
  summary() { return { frames: this.frames, minutes: this.frames * PHYS.dt / 60, distance: this.distance, hsrDistance: this.hsrDistance, sprintDistance: this.sprintDistance, sprints: this.sprints, topSpeed: this.topSpeed, accelerations: this.accelerations }; }
}
