import { G, PLANETS, SUN, displayRadius, KMS_PER_AUYR } from './data.js';

const DEG = Math.PI / 180;
const SOFT2 = 1e-8;
const ETA = 0.025; // fraction of the local dynamical time per step
const DT_MAX = 0.004; // years
const BELT_MIN_MASS = 1e-5; // only bodies heavier than this tug the asteroid belt

let nextId = 1;

// Convert J2000 elements to a heliocentric state in scene coordinates (y = ecliptic north).
export function elementsToState([a, e, I, L, varpi, Omega], mu) {
  I *= DEG; L *= DEG; varpi *= DEG; Omega *= DEG;
  const w = varpi - Omega;
  let M = (L - varpi) % (2 * Math.PI);
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 30; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const b = a * Math.sqrt(1 - e * e);
  const px = a * (Math.cos(E) - e), py = b * Math.sin(E);
  const Edot = Math.sqrt(mu / (a * a * a)) / (1 - e * Math.cos(E));
  const vx = -a * Math.sin(E) * Edot, vy = b * Math.cos(E) * Edot;
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Omega), sO = Math.sin(Omega), cI = Math.cos(I), sI = Math.sin(I);
  const r = (x, y) => [
    (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y,
    (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y,
    sw * sI * x + cw * sI * y,
  ];
  const [X, Y, Z] = r(px, py);
  const [VX, VY, VZ] = r(vx, vy);
  // ecliptic (X, Y, Z) -> scene (X, Z, -Y)
  return { x: X, y: Z, z: -Y, vx: VX, vy: VZ, vz: -VY };
}

export function makeBody(spec, state) {
  const n = spec.id && +String(spec.id).split('-').pop();
  if (n >= nextId) nextId = n + 1;
  return {
    id: spec.id || `${spec.type || 'body'}-${nextId++}`,
    name: spec.name,
    type: spec.type || spec.id,
    kind: spec.kind || 'planet',
    tagline: spec.tagline || spec.blurb || '',
    mass: spec.mass,
    radiusKm: spec.radiusKm,
    color: spec.color,
    tex: spec.tex,
    rings: !!spec.rings,
    luminosity: spec.luminosity || 0,
    spawned: !!spec.spawned,
    x: state.x, y: state.y, z: state.z,
    vx: state.vx, vy: state.vy, vz: state.vz,
    ax: 0, ay: 0, az: 0,
    alive: true,
    escaped: false,
    boundToSun: null,
    moonOf: null, moonSince: 0,
    born: state.t || 0,
  };
}

export class Sim {
  constructor() {
    this.bodies = [];
    this.t = 0;
    this.events = [];
    this.scaleMode = 'visible';
    this.belt = null;
    this.listeners = [];
    this.sampleDt = 0.01;
    this.nextSample = 0;
    this.onSample = null;
  }

  on(fn) { this.listeners.push(fn); }
  emit(ev) {
    ev.t = this.t;
    this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
  }

  initSolarSystem({ belt = 900 } = {}) {
    this.bodies = [];
    this.t = 0;
    this.events = [];
    this.climate = null;
    this.stability = null;
    this._accReady = false;
    this.nextSample = 0;
    this.bodies.push(makeBody(SUN, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }));
    for (const p of PLANETS) this.bodies.push(makeBody({ ...p, kind: 'planet' }, elementsToState(p.el, G * (1 + p.mass))));
    this.recenter();
    this.initBelt(belt);
  }

  // Move to the barycentric, zero-momentum frame.
  recenter() {
    let M = 0, cx = 0, cy = 0, cz = 0, px = 0, py = 0, pz = 0;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      M += b.mass; cx += b.mass * b.x; cy += b.mass * b.y; cz += b.mass * b.z;
      px += b.mass * b.vx; py += b.mass * b.vy; pz += b.mass * b.vz;
    }
    for (const b of this.bodies) {
      b.x -= cx / M; b.y -= cy / M; b.z -= cz / M;
      b.vx -= px / M; b.vy -= py / M; b.vz -= pz / M;
    }
  }

  initBelt(n) {
    const pos = new Float64Array(n * 3), vel = new Float64Array(n * 3);
    const sun = this.get('sun');
    for (let i = 0; i < n; i++) {
      const a = 2.15 + Math.random() * 1.2;
      const el = [a, Math.random() * 0.15, (Math.random() - 0.5) * 18, Math.random() * 360, Math.random() * 360, Math.random() * 360];
      const s = elementsToState(el, G);
      pos[i * 3] = s.x + sun.x; pos[i * 3 + 1] = s.y + sun.y; pos[i * 3 + 2] = s.z + sun.z;
      vel[i * 3] = s.vx + sun.vx; vel[i * 3 + 1] = s.vy + sun.vy; vel[i * 3 + 2] = s.vz + sun.vz;
    }
    this.belt = { n, pos, vel, alive: new Uint8Array(n).fill(1), version: 0 };
  }

  get(id) { return this.bodies.find((b) => b.id === id && b.alive); }
  alive() { return this.bodies.filter((b) => b.alive); }
  radius(b) { return displayRadius(b, this.scaleMode); }

  // The star that dominates gravity at body b (largest m/r^2), excluding b itself.
  dominantStar(b) {
    let best = null, bestF = 0;
    for (const s of this.bodies) {
      if (!s.alive || s === b || (s.kind !== 'star' && s.kind !== 'blackhole' && s.kind !== 'neutron')) continue;
      const d2 = (s.x - b.x) ** 2 + (s.y - b.y) ** 2 + (s.z - b.z) ** 2;
      const f = s.mass / d2;
      if (f > bestF) { bestF = f; best = s; }
    }
    return best;
  }

  addBody(spec, state) {
    const b = makeBody({ ...spec, spawned: true }, { ...state, t: this.t });
    this.bodies.push(b);
    this._accReady = false;
    this.emit({ kind: 'spawn', a: b.id, name: b.name });
    return b;
  }

  computeAccel(list) {
    for (const b of list) { b.ax = 0; b.ay = 0; b.az = 0; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const r2 = dx * dx + dy * dy + dz * dz + SOFT2;
        const inv = G / (r2 * Math.sqrt(r2));
        const fa = b.mass * inv, fb = a.mass * inv;
        a.ax += dx * fa; a.ay += dy * fa; a.az += dz * fa;
        b.ax -= dx * fb; b.ay -= dy * fb; b.az -= dz * fb;
      }
    }
  }

  timestep(list) {
    let dt = DT_MAX;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const m = a.mass + b.mass;
        if (m < 1e-9) continue;
        const r2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2;
        const tdyn = Math.sqrt((r2 * Math.sqrt(r2)) / (G * m));
        if (ETA * tdyn < dt) dt = ETA * tdyn;
      }
    }
    return Math.max(dt, 2e-7);
  }

  // Advance the simulation by up to `span` years, using at most `budget` substeps.
  // Returns the time actually simulated.
  advance(span, budget = 500) {
    let done = 0, steps = 0;
    let list = this.alive();
    while (done < span && steps < budget) {
      const dt = Math.min(this.timestep(list), span - done);
      this.step(list, dt);
      done += dt; steps++;
      if (this.onSample && this.t >= this.nextSample) { this.onSample(); this.nextSample = this.t + this.sampleDt; }
      if (this.handleCollisions(list)) list = this.alive();
    }
    this.lastSteps = steps;
    this.checkStatus(list);
    return done;
  }

  step(list, dt) {
    // kick-drift-kick leapfrog
    const h = dt / 2;
    if (!this._accReady) this.computeAccel(list);
    for (const b of list) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; }
    this.computeAccel(list);
    for (const b of list) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; }
    this._accReady = true;
    this.stepBelt(list, dt);
    this.t += dt;
  }

  stepBelt(list, dt) {
    const B = this.belt;
    if (!B) return;
    const movers = list.filter((b) => b.mass > BELT_MIN_MASS);
    const { pos, vel, alive, n } = B;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const k = i * 3;
      let ax = 0, ay = 0, az = 0;
      const px = pos[k] + vel[k] * dt * 0.5, py = pos[k + 1] + vel[k + 1] * dt * 0.5, pz = pos[k + 2] + vel[k + 2] * dt * 0.5;
      for (const m of movers) {
        const dx = m.x - px, dy = m.y - py, dz = m.z - pz;
        const r2 = dx * dx + dy * dy + dz * dz + SOFT2;
        const rc = this.radius(m);
        if (r2 < rc * rc) { alive[i] = 0; B.version++; break; }
        const f = (G * m.mass) / (r2 * Math.sqrt(r2));
        ax += dx * f; ay += dy * f; az += dz * f;
      }
      vel[k] += ax * dt; vel[k + 1] += ay * dt; vel[k + 2] += az * dt;
      pos[k] = px + vel[k] * dt * 0.5; pos[k + 1] = py + vel[k + 1] * dt * 0.5; pos[k + 2] = pz + vel[k + 2] * dt * 0.5;
    }
  }

  handleCollisions(list) {
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const r = this.radius(a) + this.radius(b);
        const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
        if (d2 < r * r) { this.merge(a, b); changed = true; }
      }
    }
    if (changed) this._accReady = false;
    return changed;
  }

  merge(a, b) {
    const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
    const M = big.mass + small.mass;
    const relV = Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz);
    // where and how the smaller body arrived, for the impact effect
    const geo = { nx: small.x - big.x, ny: small.y - big.y, nz: small.z - big.z, rvx: small.vx - big.vx, rvy: small.vy - big.vy, rvz: small.vz - big.vz };
    // kinetic energy of the collision in the centre-of-mass frame, in joules
    const joules = 0.5 * ((big.mass * small.mass) / (big.mass + small.mass)) * relV * relV * 1.989e30 * (KMS_PER_AUYR * 1000) ** 2;
    for (const k of ['x', 'y', 'z']) {
      big[k] = (big[k] * big.mass + small[k] * small.mass) / M;
      big['v' + k] = (big['v' + k] * big.mass + small['v' + k] * small.mass) / M;
    }
    const ratio = small.mass / big.mass;
    if (big.kind === 'planet' && small.kind === 'planet') big.radiusKm = Math.cbrt(big.radiusKm ** 3 + small.radiusKm ** 3);
    if (small.kind === 'blackhole' && big.kind !== 'blackhole') {
      // a black hole always wins, regardless of who is heavier
      big.kind = 'blackhole'; big.name = `${small.name}`; big.luminosity = 0; big.color = '#000000'; big.tex = undefined;
    }
    big.mass = M;
    small.alive = false;
    big._dirty = true;
    this.emit({ kind: 'impact', a: big.id, b: small.id, aName: big.name, bName: small.name, bKind: small.kind, aKind: big.kind,
      ratio, relV, joules, ...geo, x: big.x, y: big.y, z: big.z, spawnedB: small.spawned, spawnedA: big.spawned });
  }

  // Bookkeeping that can produce story events: escapes, captures, new moons, Earth's climate.
  checkStatus(list) {
    let M = 0, cx = 0, cy = 0, cz = 0;
    for (const b of list) { M += b.mass; cx += b.mass * b.x; cy += b.mass * b.y; cz += b.mass * b.z; }
    cx /= M; cy /= M; cz /= M;
    this.com = { x: cx, y: cy, z: cz };
    for (const b of list) {
      const star = this.dominantStar(b);
      if (star && b !== star) {
        const dx = b.x - star.x, dy = b.y - star.y, dz = b.z - star.z;
        const r = Math.hypot(dx, dy, dz);
        const v2 = (b.vx - star.vx) ** 2 + (b.vy - star.vy) ** 2 + (b.vz - star.vz) ** 2;
        const energy = v2 / 2 - (G * (star.mass + b.mass)) / r;
        const bound = energy < 0;
        if (b.boundToSun === false && bound && b.spawned && r < 60) this.emit({ kind: 'capture', a: b.id, name: b.name, star: star.name });
        b.boundToSun = bound;
        b.orbit = bound ? { a: -(G * (star.mass + b.mass)) / (2 * energy), r, star: star.id } : { r, star: star.id };
        if (b.orbit.a) b.orbit.period = Math.sqrt(b.orbit.a ** 3 / (star.mass + b.mass));
        if (bound) {
          const mu = G * (star.mass + b.mass);
          const vx = b.vx - star.vx, vy = b.vy - star.vy, vz = b.vz - star.vz;
          const hx = dy * vz - dz * vy, hy = dz * vx - dx * vz, hz = dx * vy - dy * vx;
          const ex = (vy * hz - vz * hy) / mu - dx / r, ey = (vz * hx - vx * hz) / mu - dy / r, ez = (vx * hy - vy * hx) / mu - dz / r;
          b.orbit.e = Math.hypot(ex, ey, ez);
        }
      }
      const dcom = Math.hypot(b.x - cx, b.y - cy, b.z - cz);
      if (!b.escaped && dcom > 120 && b.boundToSun === false) {
        b.escaped = true;
        this.emit({ kind: 'escape', a: b.id, name: b.name, spawned: b.spawned });
      }
      if (dcom > 4000 && b.id !== 'sun') { b.alive = false; this._accReady = false; }
      this.checkMoon(b, list);
    }
    this.updateClimate();
    this.updateStability();
  }

  // Osculating a and e of b around `star` (null if unbound).
  elements(b, star) {
    const mu = G * (star.mass + b.mass);
    const dx = b.x - star.x, dy = b.y - star.y, dz = b.z - star.z;
    const vx = b.vx - star.vx, vy = b.vy - star.vy, vz = b.vz - star.vz;
    const r = Math.hypot(dx, dy, dz);
    const energy = (vx * vx + vy * vy + vz * vz) / 2 - mu / r;
    if (energy >= 0) return null;
    const hx = dy * vz - dz * vy, hy = dz * vx - dx * vz, hz = dx * vy - dy * vx;
    const ex = (vy * hz - vz * hy) / mu - dx / r, ey = (vz * hx - vx * hz) / mu - dy / r, ez = (vx * hy - vy * hx) / mu - dz / r;
    return { a: -mu / (2 * energy), e: Math.hypot(ex, ey, ez) };
  }

  // 100% = every original planet still on its original orbit around the Sun.
  updateStability() {
    let sum = 0, n = 0;
    const sun = this.get('sun');
    for (const id of PLANETS.map((p) => p.id)) {
      n++;
      const b = this.get(id);
      if (!b || !sun) continue;
      const el = this.elements(b, sun);
      if (!el) continue;
      if (b.a0 == null) { b.a0 = el.a; b.e0 = el.e; }
      const da = Math.abs(el.a - b.a0) / b.a0;
      const de = Math.abs(el.e - b.e0);
      sum += Math.exp(-da * 6) * Math.exp(-de * 5);
    }
    const s = (sum / n) * 100;
    this.stability = this.stability == null ? s : this.stability + (s - this.stability) * 0.2;
  }

  checkMoon(b, list) {
    if (b.kind === 'star' || b.kind === 'blackhole' || b.kind === 'neutron') return;
    let host = null;
    for (const p of list) {
      if (p === b || p.mass <= b.mass * 3 || p.kind !== 'planet') continue;
      const star = this.dominantStar(p);
      if (!star) continue;
      const D = Math.hypot(p.x - star.x, p.y - star.y, p.z - star.z);
      const hill = D * Math.cbrt(p.mass / (3 * star.mass));
      const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
      const r = Math.hypot(dx, dy, dz);
      if (r > hill * 0.5) continue;
      const v2 = (b.vx - p.vx) ** 2 + (b.vy - p.vy) ** 2 + (b.vz - p.vz) ** 2;
      if (v2 / 2 - (G * (p.mass + b.mass)) / r < 0) { host = p; break; }
    }
    if (host) {
      if (b.moonOf !== host.id) { b.moonOf = host.id; b.moonSince = this.t; b.moonAnnounced = false; }
      else if (!b.moonAnnounced && this.t - b.moonSince > 0.15) {
        b.moonAnnounced = true;
        this.emit({ kind: 'moon', a: b.id, name: b.name, host: host.id, hostName: host.name, spawned: b.spawned });
      }
    } else b.moonOf = null;
  }

  updateClimate() {
    const earth = this.get('earth');
    if (!earth) { this.climate = null; return; }
    let S = 0;
    for (const s of this.bodies) {
      if (!s.alive || !s.luminosity) continue;
      const d2 = (s.x - earth.x) ** 2 + (s.y - earth.y) ** 2 + (s.z - earth.z) ** 2;
      S += s.luminosity / d2;
    }
    const T = 255 * Math.pow(Math.max(S, 1e-9), 0.25) + 33 - 273; // °C, with a fixed greenhouse bonus
    const c = (this.climate ||= { T, hot: 0, cold: 0, state: 'ok' });
    c.T = T; c.S = S;
    const dt = this.t - (c.lastT ?? this.t);
    c.lastT = this.t;
    c.hot = T > 100 ? c.hot + dt : 0;
    c.cold = T < -60 ? c.cold + dt : 0;
    if (c.state === 'ok' && c.hot > 0.5) { c.state = 'boiled'; this.emit({ kind: 'climate', what: 'boiled' }); }
    if (c.state === 'ok' && c.cold > 2) { c.state = 'frozen'; this.emit({ kind: 'climate', what: 'frozen' }); }
    if (c.state !== 'ok' && T > -20 && T < 50) { c.state = 'ok'; c.hot = 0; c.cold = 0; this.emit({ kind: 'climate', what: 'recovered' }); }
  }

  // Integrate a hypothetical copy forward to preview a launch. Returns positions of the probe.
  predict(probe, years, maxPts = 600, refId = 'sun', maxSteps = 8000) {
    const clones = this.alive().map((b) => ({ ...b }));
    const p = { ...probe, ax: 0, ay: 0, az: 0 };
    clones.push(p);
    const ref = clones.find((b) => b.id === refId) || { x: 0, y: 0, z: 0 };
    const pts = [];
    const sampleEvery = years / maxPts;
    let t = 0, next = 0, steps = 0, hit = null;
    this.computeAccel(clones);
    while (t < years && steps < maxSteps) {
      const dt = Math.min(this.timestep(clones), years - t);
      const h = dt / 2;
      for (const b of clones) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; }
      this.computeAccel(clones);
      for (const b of clones) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; }
      t += dt; steps++;
      if (t >= next) { pts.push([p.x, p.y, p.z, t, ref.x, ref.y, ref.z]); next += sampleEvery; }
      for (const b of clones) {
        if (b === p) continue;
        const r = this.radius(b) + this.radius(p);
        if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 + (b.z - p.z) ** 2 < r * r) { hit = b; break; }
      }
      if (hit) { pts.push([p.x, p.y, p.z, t, ref.x, ref.y, ref.z]); break; }
    }
    return { pts, hit, clones, t };
  }

  // Integrate a probe backwards in time from `state` for `years`, carrying the rest of the system
  // along, and return where it must start to arrive at `state` (leapfrog is time-reversible).
  rewind(probeSpec, state, years) {
    const clones = this.alive().map((b) => ({ ...b, vx: -b.vx, vy: -b.vy, vz: -b.vz }));
    const p = { ...probeSpec, ...state, vx: -state.vx, vy: -state.vy, vz: -state.vz, ax: 0, ay: 0, az: 0 };
    clones.push(p);
    this.computeAccel(clones);
    let t = 0;
    while (t < years) {
      const dt = Math.min(this.timestep(clones), years - t);
      const h = dt / 2;
      for (const b of clones) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; }
      this.computeAccel(clones);
      for (const b of clones) { b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; }
      t += dt;
    }
    return { x: p.x, y: p.y, z: p.z, vx: -p.vx, vy: -p.vy, vz: -p.vz };
  }

  serialize({ belt = true } = {}) {
    const keep = ['id', 'name', 'type', 'kind', 'tagline', 'mass', 'radiusKm', 'color', 'tex', 'rings', 'luminosity', 'spawned', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'escaped', 'born', 'a0', 'e0'];
    return {
      t: this.t,
      bodies: this.alive().map((b) => Object.fromEntries(keep.map((k) => [k, b[k]]))),
      belt: belt && this.belt && {
        n: this.belt.n,
        pos: Array.from(this.belt.pos, (v) => +v.toFixed(5)),
        vel: Array.from(this.belt.vel, (v) => +v.toFixed(5)),
        alive: Array.from(this.belt.alive),
      },
      events: this.events.slice(-200),
    };
  }

  load(data) {
    this.t = data.t || 0;
    this.bodies = data.bodies.map((b) => makeBody(b, b));
    for (const b of this.bodies) {
      const d = data.bodies.find((x) => x.id === b.id);
      b.born = d?.born ?? 0; b.a0 = d?.a0; b.e0 = d?.e0; b.escaped = !!d?.escaped;
    }
    this.stability = null;
    this.events = data.events || [];
    this._accReady = false;
    if (data.belt) {
      const n = data.belt.n;
      this.belt = { n, pos: Float64Array.from(data.belt.pos), vel: Float64Array.from(data.belt.vel), alive: Uint8Array.from(data.belt.alive), version: 1 };
    } else this.initBelt(0);
    this.climate = null;
  }
}
