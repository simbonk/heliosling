import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import './style.css';
import { inject } from '@vercel/analytics';
import { Sim, orbitShape, orbitChange } from './physics.js';
import { SPAWNABLES, KMS_PER_AUYR, START_YEAR, PLANETS } from './data.js';
import { createRenderer, makeStarfield, BodyViews, Trails, Ghosts, Belt, SpaceDust, Effects } from './render.js';
import { GalaxyView } from './galaxy.js';
import { Aim, haloTex } from './aim.js';
import { Audio } from './audio.js';
import { makeLensPass, makeGravityGrid } from './shaders.js';
import { MISSIONS, describe, starsFor } from './missions.js';
import TRICK_SHOTS from './trickshots.json';
import { buildSave, downloadJSON, readFile, decodeShare, encodeShot, decodeShot, store } from './save.js';
import { planetTexture, earthNightTexture } from './textures.js';
import { icon, orb } from './icons.js';
import { $, el, modal, closeModal, sheet, toast as popToast, fmtMass, fmtNum, installFastTap } from './ui.js';

// Initialize Vercel Web Analytics
inject();

const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const DRIFT_DIR = new THREE.Vector3(0.5, Math.sqrt(3) / 2, 0); // ~60° to the ecliptic, like the real Sun
const REAL_DRIFT = 230 / KMS_PER_AUYR; // AU/yr

// ---------------------------------------------------------------- state
const settings = Object.assign({
  frame: 'helio', // solar view: 'helio' (Sun-centred) or 'bary' (inertial)
  drift: 4, // AU/yr, stylised galactic drift for the helix view
  trailLength: 0.6,
  belt: true,
  slowmo: false,
  lensing: true,
  bloom: true,
  labels: true,
  trails: true,
  // keep the ghosts of disturbed planets' original orbits on, per view; off, they flash briefly then fade.
  // On in the flat Solar view, where they help most; the Helix view looks cleaner without.
  origOrbits: { solar: true, helix: false },
  grid: true,
  hz: false,
  reels: true, // chase + three replays after each launch
  scale: 'visible',
}, migrateSettings(store.get('sss.settings', {})));
// v2 flipped the defaults: gravity wells on, habitable zone off
function migrateSettings(saved) {
  if (saved.origOrbits && typeof saved.origOrbits !== 'object') delete saved.origOrbits;
  if ((saved.v || 1) < 2) { delete saved.grid; delete saved.hz; }
  saved.v = 2;
  return saved;
}
const saveSettings = () => store.set('sss.settings', settings);

const DEFAULT_SPEED = 0.25, DEFAULT_GALAXY_SPEED = 12;
const S = {
  view: 'solar', // switched to 'helix' at boot
  playing: true,
  speed: DEFAULT_SPEED, // sim years per real second
  galaxySpeed: DEFAULT_GALAXY_SPEED, // Myr per real second
  galaxyPlaying: true,
  selected: null,
  slow: 1,
  shake: 0,
  shots: 0,
  lastShot: null,
  mission: null,
  missionStars: store.get('gm.missions', {}),
};

// ---------------------------------------------------------------- scene
const stage = $('#stage');
const { renderer, labelRenderer, scene, camera, controls, composer, bloom } = createRenderer(stage);
if (MOBILE) renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const lens = makeLensPass();
composer.passes.splice(1, 0, lens);
scene.add(makeStarfield());

const sim = new Sim();
sim.scaleMode = settings.scale;
const views = new BodyViews(scene, sim);
const trails = new Trails(scene, sim);
trails.length = settings.trailLength;
const ghosts = new Ghosts(scene, sim);
const belt = new Belt(scene);
const dust = new SpaceDust(scene);
const effects = new Effects(scene, { maxParticles: MOBILE ? 320 : 700 });

// marks the shot while it flies (and in its replays), so it's easy to keep an eye on
const tracker = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), color: 0xfff4c8, sizeAttenuation: false, depthTest: false, transparent: true }));
tracker.renderOrder = 11;
tracker.visible = false;
scene.add(tracker);
const _tp = new THREE.Vector3();
function updateTracker(t) {
  const id = S.flight?.id || S.reel?.F.id;
  const b = id && sim.get(id);
  tracker.visible = !!b;
  if (!b) return;
  toRender(b, _tp);
  tracker.position.copy(_tp);
  // at least a fixed size on screen, and always wide enough to ring the body when it's up close
  const fit = (3.6 * sim.radius(b)) / Math.max(1e-6, camera.position.distanceTo(_tp));
  tracker.scale.setScalar(Math.max(S.cinema ? 0.05 : 0.065, fit) * (1 + Math.sin(t * 5) * 0.1));
  tracker.material.rotation = t * 1.4;
  // up close the body speaks for itself, and a big ring gets heavy: fade it back
  tracker.material.opacity = (S.cinema ? 0.6 : 0.95) * THREE.MathUtils.clamp(0.16 / fit, 0.3, 1) * (rig.mode === 'ride' ? 0.35 : 1); // riding behind it, it's already front and centre
}
const galaxy = new GalaxyView(scene, { stars: MOBILE ? 30000 : 60000 });
const grid = makeGravityGrid();
scene.add(grid);
const hzGroup = new THREE.Group();
scene.add(hzGroup);
const audio = new Audio();

const driftArrow = new THREE.ArrowHelper(DRIFT_DIR, new THREE.Vector3(), 3, 0xffd27a, 0.4, 0.2);
driftArrow.line.material.transparent = true;
driftArrow.line.material.opacity = 0.6;
scene.add(driftArrow);
const driftLabelEl = el('div', 'label drift-label', '<b>Direction of Sun\'s motion →</b><small>~230 km/s around the Milky Way</small>');
const driftLabel = new CSS2DObject(driftLabelEl);
driftArrow.add(driftLabel);
driftLabel.position.set(0, 3.2, 0);

// ---------------------------------------------------------------- frames
// the Solar view always keeps the Sun at the centre; the Helix view rides along with the galaxy
const frame = () => (S.view === 'helix' ? 'galactic' : 'helio');
function refBody() {
  const sun = sim.get('sun');
  if (sun) return sun;
  let best = null;
  for (const b of sim.bodies) if (b.alive && (!best || b.mass > best.mass)) best = b;
  return best;
}
const refId = () => refBody()?.id;
const drift = () => DRIFT_DIR.clone().multiplyScalar(settings.drift);

function toRenderXYZ(x, y, z, out) {
  if (frame() === 'helio') { const r = refBody(); return out.set(x - (r?.x || 0), y - (r?.y || 0), z - (r?.z || 0)); }
  return out.set(x, y, z);
}
const toRender = (b, out) => toRenderXYZ(b.x, b.y, b.z, out);
function fromRender(v) {
  if (frame() === 'helio') { const r = refBody(); return { x: v.x + (r?.x || 0), y: v.y + (r?.y || 0), z: v.z + (r?.z || 0) }; }
  return { x: v.x, y: v.y, z: v.z };
}
function trailOffset(ts, rx, ry, rz, out) {
  const f = frame();
  if (f === 'helio') return out.set(-rx, -ry, -rz);
  if (f === 'galactic') return out.copy(DRIFT_DIR).multiplyScalar(settings.drift * (ts - sim.t));
  return out.set(0, 0, 0);
}
// Seen from the Sun, a trail longer than one orbit just retraces itself: keep it to about one
// lap (in the moving frames the laps spread out into the helix, so leave those alone).
function trailSpan(b) {
  if (frame() !== 'helio' || b.kind === 'star') return Infinity;
  const star = sim.dominantStar(b);
  if (!star) return Infinity;
  const r = Math.hypot(b.x - star.x, b.y - star.y, b.z - star.z);
  const v2 = (b.vx - star.vx) ** 2 + (b.vy - star.vy) ** 2 + (b.vz - star.vz) ** 2;
  const mu = 4 * Math.PI * Math.PI * star.mass;
  const energy = v2 / 2 - mu / r;
  if (energy >= 0) return Infinity; // unbound: show the whole path
  const a = -mu / (2 * energy);
  return 0.92 * Math.sqrt(a ** 3 / star.mass);
}

function predictedToRender(p, out) {
  const f = frame();
  if (f === 'helio') return out.set(p[0] - p[4], p[1] - p[5], p[2] - p[6]);
  if (f === 'galactic') return out.set(p[0], p[1], p[2]).addScaledVector(DRIFT_DIR, settings.drift * p[3]);
  return out.set(p[0], p[1], p[2]);
}
const refRender = () => { const r = refBody(); return r ? toRender(r, new THREE.Vector3()) : new THREE.Vector3(); };
// velocity in the render frame, for the ride-along camera
function renderVel(b) {
  const v = new THREE.Vector3(b.vx, b.vy, b.vz);
  const f = frame(), r = refBody();
  if (f === 'helio' && r) v.sub(new THREE.Vector3(r.vx, r.vy, r.vz));
  if (f === 'galactic') v.addScaledVector(DRIFT_DIR, settings.drift);
  return v;
}

sim.onSample = () => trails.sample(refBody());

// ---------------------------------------------------------------- camera rig
const rig = {
  mode: 'system', // system | follow | top | ride | free
  lastFocus: null,
  offsetGoal: null, // desired camera offset from target, glided toward
};

function focusPoint() {
  if (S.view === 'galaxy') return galaxy.focus.clone();
  if ((rig.mode === 'follow' || rig.mode === 'ride') && S.selected) {
    const b = sim.get(S.selected);
    if (b) return toRender(b, new THREE.Vector3());
  }
  if (rig.mode === 'free') return null;
  return refRender();
}

function setCamMode(mode) {
  if ((mode === 'follow' || mode === 'ride') && !sim.get(S.selected)) {
    const last = [...sim.bodies].reverse().find((b) => b.alive && b.spawned);
    if (!last && mode === 'ride') return toast('Select or launch something to ride along with.');
    if (!sim.get(S.selected)) select(last ? last.id : 'earth');
  }
  rig.mode = mode;
  controls.enabled = mode !== 'ride';
  const dist = camera.position.distanceTo(controls.target);
  if (mode === 'top') rig.offsetGoal = new THREE.Vector3(0, Math.max(dist, 1e-3), 0.0001 * dist);
  if (mode === 'follow') {
    const b = sim.get(S.selected);
    const r = b ? sim.radius(b) : 0.05;
    const d = Math.max(r * 9, 0.05);
    const off = camera.position.clone().sub(controls.target).setLength(d);
    rig.offsetGoal = off;
  }
  updateRail();
}

// One clear way to pick what the camera stays centred on.
function centerOn(id) {
  const b = sim.get(id);
  if (!b) return;
  S.selected = id;
  if (id === refId() && frame() === 'helio') { setCamMode('system'); fitDefault(); }
  else setCamMode('follow');
  renderInfo();
  updateRail();
}
const centerName = () => {
  const b = (rig.mode === 'follow' || rig.mode === 'ride') && sim.get(S.selected);
  return b ? b.name : refBody()?.name || 'Sun';
};
const fitDefault = () => fit(false);

// First press frames the inner system out to Jupiter (plus anything you launched); press again for everything.
function fit(wide = S.fitWide) {
  const c = focusPoint() || controls.target.clone();
  let R = 0.5;
  const v = new THREE.Vector3();
  if (S.view === 'galaxy') R = 120;
  else for (const b of sim.bodies) {
    if (!b.alive || b.escaped) continue;
    const d = toRender(b, v).distanceTo(c);
    if (d < (wide ? 80 : b.spawned || b.hostile ? 30 : 6)) R = Math.max(R, d);
  }
  S.fitWide = !wide;
  const dist = (R * 1.15) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.aspect < 1 ? 1 / camera.aspect : 1) * 0.8;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(0, 0.5, 1).normalize();
  rig.offsetGoal = dir.multiplyScalar(dist);
  if (rig.mode === 'follow' || rig.mode === 'ride' || rig.mode === 'free') setCamMode('system');
}

function updateCamera(dt, dtSim) {
  // the slingshot view: stand behind the object, looking where it'll go
  if (aim.mode === 'heading' && S.view !== 'galaxy') {
    const v = aim.slingView();
    const a = S.slingCam ? 1 - Math.exp(-dt * 8) : 1 - Math.exp(-dt * 3.5);
    if (!S.slingCam) S.slingCam = { t: 0 };
    S.slingCam.t += dt;
    if (S.slingCam.t > 1.2) S.slingCam.settled = true;
    const k = S.slingCam.settled ? 1 - Math.exp(-dt * 6) : a;
    camera.position.lerp(v.pos, k);
    controls.target.lerp(v.target, k);
    camera.up.lerp(v.up, k).normalize();
    camera.lookAt(controls.target);
    controls.enabled = false;
    rig.lastFocus = null;
    return;
  }
  if (S.slingCam) { S.slingCam = null; camera.up.set(0, 1, 0); controls.enabled = rig.mode !== 'ride'; }
  if (rig.mode === 'ride' && S.selected && S.view !== 'galaxy') {
    const b = sim.get(S.selected);
    if (!b) { setCamMode('system'); return; }
    const p = toRender(b, new THREE.Vector3());
    const v = renderVel(b);
    const dir = v.lengthSq() > 0 ? v.normalize() : new THREE.Vector3(1, 0, 0);
    const k = Math.max(sim.radius(b) * 10, 0.03);
    const want = p.clone().addScaledVector(dir, -k).add(new THREE.Vector3(0, k * 0.35, 0));
    const a = 1 - Math.exp(-dt * 5);
    camera.position.lerp(want, a);
    controls.target.lerp(p.clone().addScaledVector(dir, k * 2), a);
    camera.lookAt(controls.target);
    rig.lastFocus = p;
    return;
  }
  const f = focusPoint();
  if (f) {
    if (!rig.lastFocus) rig.lastFocus = f.clone();
    const move = f.clone().sub(rig.lastFocus);
    camera.position.add(move);
    controls.target.add(move);
    rig.lastFocus.copy(f);
    const gap = f.clone().sub(controls.target);
    if (gap.lengthSq() > 1e-14) {
      const step = gap.multiplyScalar(1 - Math.exp(-dt * 5));
      camera.position.add(step);
      controls.target.add(step);
    }
  } else if (frame() === 'galactic' && dtSim) {
    rig.lastFocus = null;
  } else rig.lastFocus = null;
  if (rig.offsetGoal) {
    const off = camera.position.clone().sub(controls.target);
    off.lerp(rig.offsetGoal, 1 - Math.exp(-dt * 4));
    camera.position.copy(controls.target).add(off);
    if (off.distanceTo(rig.offsetGoal) < rig.offsetGoal.length() * 0.01) rig.offsetGoal = null;
  }
  controls.update();
  if (S.shake > 0.001) {
    const d = camera.position.distanceTo(controls.target) * 0.01 * S.shake;
    camera.position.add(new THREE.Vector3((Math.random() - 0.5) * d, (Math.random() - 0.5) * d, (Math.random() - 0.5) * d));
    S.shake *= Math.exp(-dt * 4);
  }
}

controls.addEventListener('start', () => { rig.offsetGoal = null; });

// ---------------------------------------------------------------- aiming
const aim = new Aim({
  scene, camera, controls, renderer, sim, audio,
  toRender, toRenderXYZ, fromRender, refRender, refId, predictedToRender,
  onLaunch: launch,
  onAimChange: () => renderAimBar(),
});

function startAim(type) {
  if (S.view === 'galaxy') setView('helix');
  const spec = SPAWNABLES.find((s) => s.type === type);
  audio.ensure();
  S.wasPlaying = S.playing;
  setPlaying(false);
  aim.begin(spec);
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.type === type));
}

function launch(spec, st, shot) {
  const before = sim.serialize();
  const missionData = S.mission ? JSON.parse(JSON.stringify(S.mission.data)) : null;
  const b = sim.addBody(spec, st);
  recordSnap(performance.now(), true);
  const sunNow = sim.get('sun');
  const jup = sim.get('jupiter');
  b.launch = {
    speed: shot.speed,
    sunDist: sunNow ? Math.hypot(b.x - sunNow.x, b.y - sunNow.y, b.z - sunNow.z) : 99,
    dist: { jupiter: jup ? Math.hypot(b.x - jup.x, b.y - jup.y, b.z - jup.z) : 99 },
  };
  launches.push({ t: sim.t, body: { ...b } });
  S.lastShot = { before, missionData, shot, shots: S.shots };
  S.shots++;
  if (S.mission) S.mission.shots++;
  audio.launch(Math.min(1, shot.speed / 200));
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  setPlaying(true);
  updateDock();
  log({ kind: 'launch', t: sim.t, name: spec.name, speed: shot.speed, host: st.host?.name });
  startFlight(b, shot);
}

function resetToShot() {
  if (!S.lastShot) return toast('Nothing to undo yet. Launch something first.');
  const { before, missionData, shot, shots } = S.lastShot;
  loadSim(before, { keepMission: true });
  if (S.mission && missionData) S.mission.data = missionData;
  S.shots = shots;
  setPlaying(false);
  S.wasPlaying = true;
  aim.arm(shot);
  toast('Undone. Same aim is set up: adjust it and launch again.');
}

// ---------------------------------------------------------------- universe lifecycle
// Planets start from J2000 elements, then we integrate forward to today so they sit where
// they really are now, and the contrails already have a few decades of history.
const J2000 = Date.UTC(2000, 0, 1, 12);
function freshUniverse() {
  abortReel();
  forgetLaunches();
  S.zoneTold = false; S.lastZone = null;
  views.clear();
  trails.reset();
  ghosts.reset();
  sim.initSolarSystem({ belt: 0 });
  sim.sampleDt = 0.01;
  sim.nextSample = 0;
  const years = (Date.now() - J2000) / (365.25 * 864e5);
  sim.advance(years, 1e9);
  sim.events.length = 0;
  for (const b of sim.bodies) b.orb0 = null; // ghosts show the orbits as they are today, not in 2000
  sim.initBelt(settings.belt ? (MOBILE ? 500 : 900) : 0);
  rig.lastFocus = null;
  S.lastShot = null;
  S.shots = 0;
  S.selected = null;
  log.clear();
  sim.checkStatus(sim.alive());
  renderInfo();
}

function resetVisuals({ keepHistory = false } = {}) {
  if (!S.replay && !keepHistory) { snaps.length = 0; hist.length = 0; ghosts.reset(); } // a different universe: its lost planets aren't ours
  S.rewinding = null;
  document.body.classList.remove('rewinding');
  views.clear();
  trails.reset();
  sim.nextSample = sim.t;
  rig.lastFocus = null;
  renderInfo();
}

function loadSim(data, { keepMission = false } = {}) {
  abortReel();
  forgetLaunches();
  if (!keepMission) endMission(true);
  sim.load(data);
  if (!settings.belt && sim.belt) sim.initBelt(0);
  resetVisuals();
  S.selected = null;
  sim.checkStatus(sim.alive());
}

// ---------------------------------------------------------------- events
sim.on((ev) => {
  if (S.replay || S.reel) {
    // re-running the past: show the effects, but don't log, score or record anything
    if (S.replay && ev.kind === 'impact' && ev.a === S.replay.r.a && ev.b === S.replay.r.b && !S.replay.endAt) S.replay.endAt = performance.now() + 4500;
    if (ev.kind === 'impact') reelImpact(ev);
    if (ev.kind !== 'impact') return;
  } else {
    if (ev.kind === 'impact') flightImpact(ev);
    if (ev.kind === 'impact') {
      ev.replay = replayFor(ev);
      ev.severe = MAJOR.has(ev.b) || (ev.aKind === 'blackhole' && MAJOR.has(ev.a));
    }
    if (ev.kind !== 'spawn') log(ev);
  }
  if (ev.kind === 'impact') {
    const big = sim.get(ev.a);
    if (big) {
      const p = toRender(big, new THREE.Vector3());
      const dist = camera.position.distanceTo(p);
      const kind = ev.aKind === 'blackhole' ? 'blackhole' : ev.aKind === 'star' ? 'star' : ev.ratio > 0.1 ? 'giant' : 'rock';
      effects.impact({
        at: p, followId: big.id, kind, joules: ev.joules,
        R: Math.max(sim.radius(big), dist * 0.01),
        normal: new THREE.Vector3(ev.nx, ev.ny, ev.nz),
        rel: new THREE.Vector3(ev.rvx, ev.rvy, ev.rvz),
        color: big.color,
      });
      const near = dist < camera.position.distanceTo(controls.target) * 3;
      if (near) S.shake = Math.min(1.5, S.shake + 0.4 + Math.max(0, Math.log10(ev.joules || 1) - 22) * 0.12 + ev.ratio);
      audio.thud(Math.min(1, ev.ratio * 5 + 0.3));
    }
    if (S.selected === ev.b) select(ev.a);
  }
  if (S.mission && !S.replay && !S.reel) {
    const r = S.mission.def.onEvent?.(ev, game(), S.mission.data);
    if (r) missionResult(r);
  }
});

// ---------------------------------------------------------------- launch follow-up
// Angry Birds style: after a launch the camera follows the shot from above, live, for up to ~10 s (or until
// it hits something and the dust settles), then the same flight re-runs three times from
// different angles, about 10 s each, before handing back to the present (the view from the target
// only when it hit something). Skippable throughout.
const REEL_SECONDS = 10;
const REEL_CAMS = ['Side view', 'Top-down', 'From the target'];

function startFlight(b, shot) {
  const F = {
    id: b.id, name: b.name, shot, t0: sim.t, snap: sim.snapshot(), trail: trails.count,
    userSpeed: S.speed, elapsed: 0, hitAt: 0, hitT: null, target: shot.hitId || null,
    save: sim.serialize({ belt: false }), // in case it's worth keeping
  };
  S.flight = F;
  // pace it so the predicted impact lands at ~7 s, or ~1 predicted path plays in 10 s
  const years = shot.hitIn ? shot.hitIn / 0.7 : shot.years || 1;
  S.speed = THREE.MathUtils.clamp(years / REEL_SECONDS, 0.002, 50);
  // follow it from well back and above, so you see where it's going as well as the shot
  S.selected = b.id;
  setCamMode('follow');
  const host = sim.get(shot.host) || sim.dominantStar(b);
  const d = host ? Math.hypot(b.x - host.x, b.y - host.y, b.z - host.z) : 1;
  const v = renderVel(b);
  const back = v.lengthSq() > 0 ? v.normalize().negate() : camera.position.clone().sub(controls.target).normalize();
  rig.offsetGoal = back.multiplyScalar(0.6).add(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(THREE.MathUtils.clamp(d * 1.2, sim.radius(b) * 15, 80));
  document.body.classList.add('flying');
  reelBar(`<span><b>In flight</b> ${b.name}</span>`, [['Skip ▸', () => endFlight()]]);
}

function reelBar(label, buttons) {
  const bar = $('#replaybar');
  bar.hidden = false;
  bar.classList.remove('offer-save');
  bar.innerHTML = `${label}<span class="rb-btns">${buttons.map(([t], i) => `<button data-b="${i}" class="${i === buttons.length - 1 ? 'primary' : ''}">${t}</button>`).join('')}</span>`;
  bar.querySelectorAll('[data-b]').forEach((el) => { el.onclick = buttons[+el.dataset.b][1]; });
}

function tickFlight(dt, now) {
  const F = S.flight;
  if (!F) return;
  F.elapsed += dt;
  const settled = F.hitAt && now - F.hitAt > 2500;
  const gone = !F.hitAt && !sim.get(F.id);
  if (settled || gone || F.elapsed > REEL_SECONDS) endFlight();
}

function flightImpact(ev) {
  const F = S.flight;
  if (!F || F.hitAt || (ev.a !== F.id && ev.b !== F.id)) return;
  F.hitAt = performance.now();
  F.hitT = sim.t;
  F.target = ev.a === F.id ? ev.b : ev.a;
}

function endFlight() {
  const F = S.flight;
  if (!F) return;
  S.flight = null;
  F.tEnd = sim.t;
  if (settings.reels === false) return wrapUp(F);
  S.reel = { F, present: sim.snapshot(), presentTrail: trails.count, tEnd: sim.t, i: -1 };
  nextReel();
}

// watching it come in from the target only makes sense when it hit one
const reelCount = (F) => (F.hitT ? REEL_CAMS.length : 2);

function nextReel() {
  const R = S.reel;
  if (!R) return;
  R.i++;
  if (R.i >= reelCount(R.F)) return finishReels();
  const F = R.F;
  sim.restore(F.snap);
  trails.rewindTo(F.trail);
  cinema(true);
  R.elapsed = 0;
  R.hitSeen = 0;
  R.base = Math.max(1e-6, (R.tEnd - F.t0) / (REEL_SECONDS * (F.hitT ? 0.75 : 1)));
  S.speed = R.base;
  S.playing = true;
  aimReelCamera(R.i);
  document.body.classList.add('reeling');
  reelBar(`<span><b>▶ Replay ${R.i + 1}/${reelCount(F)}</b> ${REEL_CAMS[R.i]}</span>`, [
    ['Skip ▸', () => nextReel()],
    ['Done', () => finishReels()],
  ]);
  updateDock();
}

// what the replay looks at: whatever it hit, or the star it was launched around
function reelFocus(F) {
  return [F.target, F.shot.host].map((id) => id && sim.get(id)).find(Boolean) || sim.dominantStar(sim.get(F.id) || {});
}

function aimReelCamera(i) {
  const F = S.reel.F;
  const shotBody = sim.get(F.id);
  const focus = reelFocus(F);
  S.selected = focus?.id || F.id;
  setCamMode('follow');
  if (!focus || !shotBody) return;
  const ab = new THREE.Vector3(shotBody.x - focus.x, shotBody.y - focus.y, shotBody.z - focus.z);
  const gap = ab.length();
  const Ra = sim.radius(focus);
  if (i === 2) {
    // from behind and above what it hit, far enough back to see the shot coming in
    const back = ab.clone().normalize().negate().add(new THREE.Vector3(0, 0.7, 0)).normalize();
    rig.offsetGoal = back.multiplyScalar(THREE.MathUtils.clamp(gap * 2.2 + Ra * 8, Ra * 16, 400));
    return;
  }
  if (i === 1) {
    // straight down on the whole flight
    const D = THREE.MathUtils.clamp(gap * 2.6 + Ra * 4, Ra * 8, 400);
    rig.offsetGoal = new THREE.Vector3(0, D, D * 0.001);
    return;
  }
  // side-on, so the shot crosses the frame into its target
  ab.normalize();
  const side = ab.clone().cross(new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  const dir = side.normalize().add(new THREE.Vector3(0, 0.4, 0)).addScaledVector(ab, -0.2).normalize();
  rig.offsetGoal = dir.multiplyScalar(THREE.MathUtils.clamp(gap * 1.5 + Ra * 2, Ra * 6, 300));
}

function reelImpact(ev) {
  const R = S.reel;
  if (R && !R.hitSeen && (ev.a === R.F.id || ev.b === R.F.id)) R.hitSeen = R.elapsed || 1e-3;
}

function tickReel(dt) {
  const R = S.reel;
  if (!R) return;
  R.elapsed += dt;
  const F = R.F;
  // slow motion into the impact, then a slower aftermath
  if (F.hitT) {
    const left = (F.hitT - sim.t) / Math.max(1e-9, F.hitT - F.t0);
    S.speed = R.base * (R.hitSeen ? 0.4 : THREE.MathUtils.clamp(left / 0.3, 0.15, 1));
  }
  // the chase cam has nothing to chase once the shot is swallowed: look at what it hit
  if (rig.mode === 'ride' && !sim.get(F.id)) {
    const f = reelFocus(F);
    if (f) { S.selected = f.id; setCamMode('follow'); }
  }
  const after = R.hitSeen ? R.elapsed - R.hitSeen > 2.5 : sim.t >= R.tEnd;
  if (after || R.elapsed > REEL_SECONDS * 1.8) nextReel();
}

function finishReels() {
  const R = S.reel;
  if (!R) return;
  S.reel = null;
  sim.restore(R.present);
  if (R.F.fromSave) resetVisuals(); // back from a saved universe: its trails don't belong here
  else trails.count = R.presentTrail;
  cinema(false);
  wrapUp(R.F);
}

// drop any chase or replay without restoring anything (undo, load, reset)
function abortReel() {
  const F = S.flight || S.reel?.F;
  if (!F) return;
  S.flight = null;
  S.reel = null;
  cinema(false);
  S.speed = F.userSpeed;
  document.body.classList.remove('flying', 'reeling');
  $('#replaybar').hidden = true;
  controls.enabled = true;
  if (rig.mode === 'ride') rig.mode = 'system';
}

// back to normal play: the user's speed, the camera on whatever matters now
// The resting view after a launch plays out or something is removed: the helix, from its home
// angle, keeping whatever time speed the user had.
function backToHelix() {
  const speed = S.speed;
  if (S.view !== 'helix') setView('helix');
  else homeCamera('helix');
  S.selected = null;
  S.speed = speed;
}

function wrapUp(F) {
  S.speed = F.userSpeed;
  document.body.classList.remove('flying', 'reeling');
  $('#replaybar').hidden = true;
  controls.enabled = true;
  if (!S.switchingView) backToHelix();
  S.playing = true;
  updateDock();
  renderInfo();
  updateRail();
  if (F.save && !F.fromSave && !S.switchingView) offerSave(F);
  if (F.shared) keepSharedShot(F.shared);
}

// ---------------------------------------------------------------- saved shots
// Shots worth keeping: the universe at the moment of launch plus what happened, so the replays
// can be watched again any time. Kept apart from the running game, so Reset leaves them alone.
const SHOTS_KEY = 'sss.shots';
const MAX_SHOTS = 40;
const savedShots = () => store.get(SHOTS_KEY, []);

function offerSave(F) {
  reelBar(`<span class="rb-save">${icon('bookmark')}<span><b>Save this shot?</b> Keep it to replay later</span></span>`, [
    ['No', () => { $('#replaybar').hidden = true; }],
    ['Save…', () => { $('#replaybar').hidden = true; promptSave(F); }],
  ]);
  const bar = $('#replaybar');
  bar.classList.add('offer-save');
  clearTimeout(S.saveOfferT);
  // don't nag: the question goes away by itself
  S.saveOfferT = setTimeout(() => { if (bar.classList.contains('offer-save') && !S.flight && !S.reel) bar.hidden = true; }, 15000);
}

function shotTitle(F) {
  const t = F.target && F.save.bodies.find((b) => b.id === F.target);
  return F.hitT && t ? `${F.name} hits ${t.name}` : `${F.name} launch`;
}

function promptSave(F) {
  modal({
    title: 'Save shot',
    body: `<label class="save-name">Name<input id="shot-name" maxlength="60" value="${shotTitle(F).replace(/"/g, '&quot;')}"></label>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Save', primary: true, onClick: () => {
        const name = ($('#shot-name').value || '').trim() || shotTitle(F);
        const list = savedShots();
        list.unshift({
          id: `s${Date.now().toString(36)}`, name, at: Date.now(), view: S.view === 'galaxy' ? 'helix' : S.view, data: F.save,
          meta: { id: F.id, name: F.name, host: F.shot.host || null, target: F.target, hitDt: F.hitT != null ? F.hitT - F.t0 : null, dur: (F.tEnd ?? sim.t) - F.t0 },
        });
        try { store.set(SHOTS_KEY, list.slice(0, MAX_SHOTS)); } catch { return toast('Could not save: storage is full', 'sticky'); }
        closeModal();
        pushLog({ icon: '💾', text: `Saved “${name}”` });
      } },
    ],
  });
  setTimeout(() => { const i = $('#shot-name'); i?.focus(); i?.select(); }, 50);
}

function openSaved() {
  const list = savedShots();
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rows = list.length ? list.map((r) => `<div class="shot-row" data-id="${r.id}"><div><b>${r.name.replace(/</g, '&lt;')}</b><small>${fmt(r.at)} · ${r.meta.hitDt != null ? 'impact' : 'flight'}</small></div><button data-play="${r.id}" class="primary">▶ Watch</button><button data-share="${r.id}" aria-label="Share ${r.name.replace(/"/g, '')}">${icon('share')}</button><button data-del="${r.id}" aria-label="Delete ${r.name.replace(/"/g, '')}">✕</button></div>`).join('')
    : `<div class="shot-empty">${icon('bookmark')}<p><b>Nothing saved yet.</b> Go make something cool. After every launch plays out you'll be asked whether to keep it, and anything you save lands here to rewatch.</p></div>`;
  sheet('Saved shots', `<div class="shot-list">${rows}</div>`, (box) => {
    box.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => { closeModal(); playShot(savedShots().find((r) => r.id === b.dataset.play)); }; });
    box.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => shareShot(savedShots().find((r) => r.id === b.dataset.share)); });
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => {
      store.set(SHOTS_KEY, savedShots().filter((r) => r.id !== b.dataset.del));
      b.closest('.shot-row').remove();
    }; });
  });
}

// A link that plays the shot for whoever opens it. Phones get the share sheet, desktops a copied link.
async function shareShot(rec) {
  if (!rec) return;
  const url = `${location.origin}${location.pathname}#s=${await encodeShot(rec)}`;
  const text = `Watch my Heliosling shot: ${rec.name}`;
  if (navigator.share && MOBILE) {
    try { await navigator.share({ title: rec.name, text, url }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone who opens it gets to watch your shot.'); }
  catch { prompt('Copy this link to share your shot:', url); }
}

// someone sent you a shot: watch it, then choose whether to keep it
function keepSharedShot(rec) {
  reelBar(`<span class="rb-save">${icon('bookmark')}<span><b>Keep this shot?</b> Save it to your shots</span></span>`, [
    ['No', () => { $('#replaybar').hidden = true; }],
    ['Save', () => {
      $('#replaybar').hidden = true;
      store.set(SHOTS_KEY, [{ ...rec, id: 'shot-' + Date.now().toString(36), at: Date.now() }, ...savedShots()].slice(0, MAX_SHOTS));
      toast('Saved. Find it under 🔖 Saved.');
    }],
  ]);
}

// Watch a saved shot's replays, then come back to the game exactly as it was.
function playShot(rec) {
  if (!rec) return;
  if (S.replay) endReplay();
  if (S.flight || S.reel) abortReel();
  if (aim.active) aim.cancel();
  if (S.view !== rec.view) { S.switchingView = true; setView(rec.view); S.switchingView = false; }
  const present = sim.snapshot();
  const userSpeed = S.speed;
  sim.load(rec.data);
  resetVisuals();
  const m = rec.meta;
  const F = {
    id: m.id, name: m.name, shot: { host: m.host, hitId: m.target }, t0: sim.t, snap: sim.snapshot(), trail: trails.count,
    userSpeed, hitT: m.hitDt != null ? sim.t + m.hitDt : null, target: m.target, fromSave: true, shared: rec.shared ? rec : null,
  };
  S.reel = { F, present, presentTrail: 0, tEnd: sim.t + m.dur, i: -1 };
  nextReel();
}

// The last run, offered once on load as a small floating pill that gets out of the way as soon as
// you start doing something (it's also in the menu).
function resumeLastRun() {
  const auto = store.get('gm.autosave');
  $('#resume-pill')?.remove();
  try { applySave(auto); } catch {}
}
function showResumePill(auto) {
  const pill = el('button', 'resume-pill', `${icon('history')}<span>Resume last run <small>year ${(START_YEAR + auto.sim.t).toFixed(1)}</small></span>`);
  pill.id = 'resume-pill';
  pill.onclick = resumeLastRun;
  document.body.appendChild(pill);
  const gone = () => { pill.classList.add('gone'); setTimeout(() => pill.remove(), 400); };
  setTimeout(gone, 12000);
  const away = (e) => { if (!pill.contains(e.target)) { gone(); window.removeEventListener('pointerdown', away, true); } };
  setTimeout(() => window.addEventListener('pointerdown', away, true), 1500);
}

// ---------------------------------------------------------------- event log
// Everything that happens lands here instead of popping up over the action. Collapsed, it shows
// the latest line; tap it for a scrollable history. Collisions carry a close-up replay.
const chronicle = [];
const LOG = { open: false, unread: 0 };
function pushLog(item) {
  const prev = chronicle[chronicle.length - 1];
  const now = performance.now();
  // the same thing again moments later (debris raining onto the Sun...) counts up on one line
  if (prev && prev.text === item.text && !item.action && !item.replay && now - prev.at < 4000) { prev.n = (prev.n || 1) + 1; prev.at = now; }
  else chronicle.push({ t: sim.t, at: now, ...item });
  if (chronicle.length > 300) chronicle.shift();
  if (!LOG.open) LOG.unread++;
  renderLog(true);
}
function log(ev) {
  const d = ev.kind === 'launch'
    ? { icon: '🎱', text: `${ev.name} launched at ${ev.speed.toFixed(1)} km/s${ev.host ? ` (rel. ${ev.host})` : ''}` }
    : describe(ev);
  pushLog({ t: ev.t ?? sim.t, ...d, kind: ev.kind, replay: ev.replay, severe: ev.severe });
}
log.clear = () => { chronicle.length = 0; LOG.unread = 0; renderLog(); };
// UI messages go to the log too; only the resume offer at startup still pops up
function toast(html, kind = 'note') {
  if (kind === 'sticky') return popToast(html, kind);
  pushLog({ icon: '', text: html, kind });
}

// The log sits as an icon with an unread count. Something new flashes up beneath it for a few
// seconds, then tucks away; a burst of events shows as the latest plus "+N more" rather than a
// stream. Tap the icon (or the flash) to open the full list and scroll back through it.
const logText = (c) => `<i class="ldot ${c.severe ? 'severe' : c.kind || ''}"></i>${String(c.text).replace(/\p{Extended_Pictographic}\uFE0F?\s*/gu, '')}${c.n > 1 ? ` <b class="lx">×${c.n}</b>` : ''}`;
function renderLog(fresh) {
  const box = $('#log');
  const list = box.querySelector('.log-list');
  const keep = list ? list.scrollTop : 0;
  const row = (c, i) => `<li class="${c.kind || ''}${c.severe ? ' severe' : ''}"><span class="ts">${stamp(c.t)}</span><span class="tx">${logText(c)}</span>${c.replay ? `<button class="replay" data-r="${i}">${icon('replay')} Replay</button>` : ''}${c.action ? `<button class="replay" data-act="${i}">${c.action.label}</button>` : ''}</li>`;
  box.classList.toggle('open', LOG.open);
  box.innerHTML = `<button class="log-head" aria-expanded="${LOG.open}" aria-label="Event log">${icon('list')}${LOG.unread && !LOG.open ? `<b class="lh-n">${LOG.unread > 99 ? '99+' : LOG.unread}</b>` : ''}</button>
    ${LOG.open ? `<div class="log-panel"><header>Event log<button class="log-x" aria-label="Close">✕</button></header><ol class="log-list">${chronicle.length ? chronicle.map(row).reverse().join('') : '<li class="muted">Nothing yet. Launch something!</li>'}</ol></div>` : ''}`;
  if (LOG.open) {
    box.querySelector('.log-list').scrollTop = keep;
    box.querySelector('.log-x').onclick = () => { LOG.open = false; renderLog(); };
  }
  box.querySelector('.log-head').onclick = () => { LOG.open = !LOG.open; LOG.unread = 0; hideLogFlash(); renderLog(); };
  box.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => startReplay(chronicle[+b.dataset.r]?.replay); });
  box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => { chronicle[+b.dataset.act]?.action?.run(); LOG.open = false; renderLog(); }; });
  if (fresh && !LOG.open) flashLog();
}

function flashLog() {
  const last = chronicle[chronicle.length - 1];
  if (!last || S.cinema) return;
  let f = $('#log-flash');
  if (!f) {
    f = el('button', 'log-flash');
    f.id = 'log-flash';
    f.onclick = () => { LOG.open = true; LOG.unread = 0; hideLogFlash(); renderLog(); };
    document.body.appendChild(f);
  }
  const now = performance.now();
  const recent = chronicle.filter((c) => now - c.at < 3000).length;
  f.innerHTML = `<span class="lf-tx">${logText(last)}</span>${recent > 1 ? `<span class="lf-more">+${recent - 1} more</span>` : ''}`;
  f.classList.remove('gone');
  f.classList.toggle('severe', !!last.severe);
  $('#log').classList.remove('flash'); void $('#log').offsetWidth; $('#log').classList.add('flash');
  clearTimeout(LOG.flashT);
  // important things linger a little longer
  LOG.flashT = setTimeout(hideLogFlash, last.severe || last.replay ? 4500 : 2800);
}
function hideLogFlash() {
  clearTimeout(LOG.flashT);
  $('#log-flash')?.classList.add('gone');
}

// ---------------------------------------------------------------- replays
// A rolling buffer of light snapshots (bodies only, no belt). When two bodies collide, the
// snapshot from a few seconds earlier is kept with the log entry, so the moment can be
// re-run close up before the present is restored.
const snaps = [];
let snapT = 0;
function recordSnap(now, force) {
  if (!force && now - snapT < 250) return;
  snapT = now;
  snaps.push({ t: sim.t, bodies: sim.serialize({ belt: false }).bodies });
  if (snaps.length > 24) snaps.shift();
}
const MAJOR = new Set(['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
function replayFor(ev) {
  const has = (s) => s.bodies.some((b) => b.id === ev.a) && s.bodies.some((b) => b.id === ev.b);
  const from = snaps.slice(-14).find((s) => s.t < sim.t && has(s));
  if (!from) return null;
  return { from, tEvent: sim.t, a: ev.a, b: ev.b, title: `${ev.aName} and ${ev.bName}` };
}

// Replays render like a cut scene: full resolution, stronger glow, denser debris, no HUD,
// letterbox bars, a slowly circling camera and slow motion into the moment of impact.
function cinema(on) {
  if (on === !!S.cinema) return;
  if (on) {
    S.cinema = { pr: renderer.getPixelRatio(), bloom: [bloom.strength, bloom.radius, bloom.threshold] };
    const pr = Math.min(devicePixelRatio, 2);
    renderer.setPixelRatio(pr);
    composer.setPixelRatio?.(pr);
    bloom.strength = 1.15; bloom.radius = 0.75;
    bloom.enabled = true;
    effects.hq = true;
  } else {
    const c = S.cinema;
    renderer.setPixelRatio(c.pr);
    composer.setPixelRatio?.(c.pr);
    [bloom.strength, bloom.radius, bloom.threshold] = c.bloom;
    effects.hq = false;
    S.cinema = null;
  }
  composer.setSize(innerWidth, innerHeight);
  document.body.classList.toggle('cinema', on);
}

function startReplay(r) {
  if (!r || S.replay) return;
  if (S.flight) { const F = S.flight; S.flight = null; wrapUp(F); }
  if (S.reel) finishReels();
  if (S.view === 'galaxy') setView('helix');
  aim.cancel();
  LOG.open = false;
  renderLog();
  S.replay = { r, present: sim.serialize(), speed: S.speed, playing: S.playing, selected: S.selected, mode: rig.mode, off: camera.position.clone().sub(controls.target), endAt: 0 };
  sim.load({ t: r.from.t, bodies: r.from.bodies });
  resetVisuals();
  cinema(true);
  // a few real seconds to the impact; tickReplay eases into slow motion as it gets close
  S.replay.base = Math.max(1e-5, (r.tEvent - r.from.t) / 4);
  S.speed = S.replay.base;
  const a = sim.get(r.a), b = sim.get(r.b);
  S.selected = r.a;
  setCamMode('follow');
  if (a && b) {
    // look from the side of the approach, so the impactor crosses the frame into the target
    const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const gap = ab.length();
    ab.normalize();
    const side = ab.clone().cross(new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    const dir = side.normalize().add(new THREE.Vector3(0, 0.45, 0)).addScaledVector(ab, -0.25).normalize();
    const Ra = sim.radius(a);
    rig.offsetGoal = dir.multiplyScalar(THREE.MathUtils.clamp(gap * 1.8 + Ra * 2, Ra * 7, Ra * 60));
  }
  document.body.classList.add('replaying');
  const bar = $('#replaybar');
  bar.hidden = false;
  bar.innerHTML = `<span><b>▶ Replay</b> ${r.title}</span><button class="primary" id="replay-end">Back to now</button>`;
  bar.querySelector('#replay-end').onclick = endReplay;
  S.playing = true;
  updateDock();
  renderInfo();
  updateRail();
}

function endReplay() {
  const R = S.replay;
  if (!R) return;
  S.replay = null;
  cinema(false);
  sim.load(R.present);
  if (!settings.belt && sim.belt) sim.initBelt(0);
  resetVisuals({ keepHistory: true }); // back in the same timeline: Rewind can still reach back past the replay
  S.speed = R.speed;
  S.selected = sim.get(R.selected) ? R.selected : null;
  rig.mode = R.mode === 'ride' ? 'follow' : R.mode;
  controls.enabled = true;
  rig.offsetGoal = R.off;
  document.body.classList.remove('replaying');
  $('#replaybar').hidden = true;
  setPlaying(R.playing);
  renderInfo();
  updateRail();
}

function tickReplay(now) {
  const R = S.replay;
  if (!R) return;
  const span = R.r.tEvent - R.r.from.t;
  // slow motion: full speed far out, down to ~1/8 just before contact, then a slow aftermath
  const left = (R.r.tEvent - sim.t) / span;
  const f = R.endAt ? 0.3 : THREE.MathUtils.clamp(left / 0.35, 0.12, 1);
  S.speed = R.base * f;
  // the camera circles slowly and creeps in, unless it is still gliding to its start
  if (!rig.offsetGoal) {
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.0025 * (R.endAt ? 0.6 : 1));
    if (!R.endAt) off.multiplyScalar(0.9992);
    camera.position.copy(controls.target).add(off);
  }
  // the impact replayed (or the re-run drifted and missed): linger a moment, then come back
  if (!R.endAt && sim.t > R.r.tEvent + span * 0.5 + 1e-4) R.endAt = now + 1500;
  if (R.endAt && now > R.endAt) endReplay();
}

const stamp = (t) => `T+${t < 1 ? `${(t * 365.25).toFixed(0)}d` : `${t.toFixed(t < 100 ? 2 : 0)}y`}`;

// ---------------------------------------------------------------- missions
const game = () => ({ sim, shots: S.mission?.shots || 0 });

function startMission(def) {
  closeModal();
  endMission(true);
  freshUniverse();
  S.mission = { def, data: {}, shots: 0 };
  S.speed = def.speed;
  def.setup?.(game(), S.mission.data);
  setView('solar');
  setPlaying(false);
  fit(def.id === 'thief');
  updateDock();
  $('#mission-hud').hidden = false;
  renderMissionHud();
  modal({
    title: `🎯 ${def.title}`,
    body: `<p>${def.desc}</p><p class="tip">💡 ${def.tip}</p><p class="muted">Fewer launches earn more stars. Undo takes you back to just before your last launch.</p>`,
    actions: [{ label: `Pick ${SPAWNABLES.find((s) => s.type === def.suggest).name}`, primary: true, onClick: () => { closeModal(); startAim(def.suggest); } }, { label: 'Look around first', onClick: closeModal }],
  });
}

function endMission(silent) {
  if (!S.mission) return;
  S.mission = null;
  $('#mission-hud').hidden = true;
  if (!silent) toast('Back to the sandbox.');
}

function missionResult(r) {
  const m = S.mission;
  if (!m || m.done) return;
  m.done = true;
  setPlaying(false);
  const def = m.def;
  if (r === 'win') {
    const stars = starsFor(m.shots);
    S.missionStars[def.id] = Math.max(S.missionStars[def.id] || 0, stars);
    store.set('gm.missions', S.missionStars);
    audio.chime();
    const next = MISSIONS[MISSIONS.indexOf(def) + 1];
    modal({
      title: 'Mission complete',
      body: `<div class="stars">${'★'.repeat(stars)}<span>${'★'.repeat(3 - stars)}</span></div><p><b>${def.title}</b> in ${m.shots} launch${m.shots === 1 ? '' : 'es'}.</p>${stars < 3 ? '<p class="muted">Do it in one launch for three stars.</p>' : ''}`,
      actions: [
        ...(next ? [{ label: `Next: ${next.title}`, primary: true, onClick: () => startMission(next) }] : []),
        { label: 'Replay', onClick: () => startMission(def) },
        { label: 'Keep playing here', onClick: () => { closeModal(); endMission(); setPlaying(true); } },
      ],
    });
  } else {
    audio.thud(1);
    modal({
      title: 'Mission failed',
      body: `<p>${def.title}: not this time.</p>`,
      actions: [
        ...(S.lastShot ? [{ label: 'Undo last launch', primary: true, onClick: () => { closeModal(); m.done = false; resetToShot(); } }] : []),
        { label: 'Restart mission', primary: !S.lastShot, onClick: () => startMission(def) },
        { label: 'Quit to sandbox', onClick: () => { closeModal(); endMission(); } },
      ],
    });
  }
}

function renderMissionHud() {
  const m = S.mission;
  if (!m) return;
  $('#mission-hud').innerHTML = `<div class="mh-title">🎯 ${m.def.title}</div><div class="mh-status">${m.def.status?.(game(), m.data) || ''}</div><div class="mh-shots">Launches ${m.shots}</div><button class="mh-quit" aria-label="Quit mission">✕</button>`;
  $('#mission-hud .mh-quit').onclick = () => endMission();
}

// ---------------------------------------------------------------- selection & info
function select(id) {
  S.selected = id;
  renderInfo();
  if (!id && (rig.mode === 'follow' || rig.mode === 'ride')) setCamMode('system');
}
views.onLabelClick = (id) => { select(id); };

function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bestD = e.pointerType === 'touch' ? 40 : 24;
  const v = new THREE.Vector3();
  for (const b of sim.bodies) {
    if (!b.alive) continue;
    toRender(b, v).project(camera);
    if (v.z > 1) continue;
    const sx = (v.x + 1) / 2 * r.width, sy = (1 - v.y) / 2 * r.height;
    const pr = (sim.radius(b) / camera.position.distanceTo(toRender(b, new THREE.Vector3()))) * (r.height / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const d = Math.max(0, Math.hypot(sx - x, sy - y) - pr);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

let tap = null;
renderer.domElement.addEventListener('pointerdown', (e) => { tap = { x: e.clientX, y: e.clientY, t: performance.now() }; audio.ensure(); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!tap || aim.active || S.view === 'galaxy') return;
  const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
  if (moved < 8 && performance.now() - tap.t < 400) {
    const b = pick(e);
    select(b ? b.id : null);
  }
  tap = null;
});
renderer.domElement.addEventListener('dblclick', (e) => {
  if (aim.active) return;
  const b = pick(e);
  if (b) centerOn(b.id);
});

function renderInfo() {
  const box = $('#info');
  const b = S.selected && sim.get(S.selected);
  if (!b || S.view === 'galaxy') { box.hidden = true; return; }
  box.hidden = false;
  const star = sim.dominantStar(b);
  const rows = [];
  rows.push(['Mass', fmtMass(b.mass)]);
  rows.push(['Radius', `${fmtNum(b.radiusKm)} km`]);
  if (star && star !== b) {
    const d = Math.hypot(b.x - star.x, b.y - star.y, b.z - star.z);
    const v = Math.hypot(b.vx - star.vx, b.vy - star.vy, b.vz - star.vz) * KMS_PER_AUYR;
    rows.push([`From ${star.name}`, `${d.toFixed(d < 10 ? 3 : 1)} AU`]);
    rows.push(['Speed', `${v.toFixed(1)} km/s`]);
    if (b.boundToSun && b.orbit?.a) {
      rows.push(['Orbit', `a ${b.orbit.a.toFixed(2)} AU · e ${(b.orbit.e ?? 0).toFixed(3)}`]);
      rows.push(['Year length', b.orbit.period < 1 ? `${(b.orbit.period * 365.25).toFixed(0)} days` : `${b.orbit.period.toFixed(2)} yr`]);
    } else rows.push(['Orbit', '<span class="bad">Unbound · escaping</span>']);
  }
  if (b.moonOf) rows.push(['Moon of', sim.get(b.moonOf)?.name || '?']);
  if (b.id === 'earth' && sim.climate) rows.push(['Surface', earthStatus().html]);
  const centred = (rig.mode === 'follow' && S.selected === b.id) || (b.id === refId() && rig.mode === 'system');
  box.innerHTML = `
    <div class="info-head"><span class="dot" style="background:${b.kind === 'blackhole' ? '#ff9a4a' : b.color}"></span><div><h3>${b.name}</h3><small>${b.tagline || b.kind}</small></div><button class="x" aria-label="Close">✕</button></div>
    <button class="details-toggle">${box.classList.contains('open') ? 'Hide details ▴' : 'Details ▾'}</button>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="info-actions">
      <button data-a="center" class="${centred ? 'on' : ''}">◎ ${centred ? 'Centred' : `Center on ${b.name}`}</button>
      <button data-a="ride" class="${rig.mode === 'ride' ? 'on' : ''}">Ride along</button>
      <button data-a="remove" class="danger" aria-label="Remove ${b.name}">Remove</button>
    </div>`;
  box.querySelector('.x').onclick = () => select(null);
  box.querySelector('.details-toggle').onclick = () => { box.classList.toggle('open'); renderInfo(); };
  box.querySelector('[data-a=center]').onclick = () => centerOn(b.id);
  box.querySelector('[data-a=ride]').onclick = () => setCamMode(rig.mode === 'ride' ? 'follow' : 'ride');
  box.querySelector('[data-a=remove]').onclick = () => removeBody(b);
}

function removeBody(b) {
  const p = toRender(b, new THREE.Vector3());
  effects.impact({ at: p, kind: 'puff', color: '#9fd0ff', joules: 1e20, R: Math.max(sim.radius(b), camera.position.distanceTo(p) * 0.01) });
  audio.thud(0.8);
  b.alive = false;
  sim._accReady = false;
  pushLog({ icon: '✕', text: `${b.name} was removed` });
  select(null);
  backToHelix();
  updateDock();
}

// Earth's climate from total starlight: in the habitable zone, too close, or too far.
function earthStatus() {
  const c = sim.climate;
  if (!c) return { text: 'Earth is gone', short: 'Gone', html: '<span class="bad">Gone</span>', cls: 'bad', zone: 'gone' };
  const T = c.T;
  const zone = c.S > 1.11 ? 'hot' : c.S < 0.36 ? 'cold' : 'ok';
  let label;
  if (c.state === 'boiled') label = 'Oceans boiled';
  else if (c.state === 'frozen') label = 'Frozen solid';
  else label = zone === 'ok' ? 'In the habitable zone' : zone === 'hot' ? 'Too close to the Sun' : 'Too far from the Sun';
  const cls = c.state !== 'ok' ? 'bad' : zone === 'ok' ? 'good' : Math.abs(T - 15) > 60 ? 'bad' : 'warn';
  return { text: `${T.toFixed(0)}°C · ${label}`, short: `${T.toFixed(0)}°C · ${zone === 'ok' && c.state === 'ok' ? 'Habitable' : label}`, html: `<span class="${cls}">${T.toFixed(0)} °C · ${label}</span>`, cls, zone };
}

// ---------------------------------------------------------------- view switching
// Each view has a home camera. Picking a view (even the one you're on) always lands there,
// so you can't get lost: Sun-centred, unfollowed, at that view's default angle and zoom.
const PORTRAIT = () => MOBILE && innerWidth < innerHeight;
const HOME = {
  helix: () => new THREE.Vector3(-9, 3.2, 7).multiplyScalar(PORTRAIT() ? 1.5 : 1),
  solar: () => new THREE.Vector3(-2.2, 5.5, 6.5).multiplyScalar(PORTRAIT() ? 1.6 : 1),
  galaxy: () => new THREE.Vector3(-30, 45, 70),
};
function homeCamera(v = S.view) {
  rig.mode = 'system';
  rig.offsetGoal = null;
  rig.lastFocus = null;
  controls.enabled = true;
  const f = v === 'galaxy' ? galaxy.focus.clone() : refRender();
  controls.target.copy(f);
  camera.position.copy(f).add(HOME[v]());
  camera.up.set(0, 1, 0);
  controls.update();
}

function setView(v) {
  if (S.replay) endReplay();
  S.switchingView = true; // the tab decides the camera, not the end of a launch
  if (S.flight) { const F = S.flight; S.flight = null; wrapUp(F); }
  if (S.reel) finishReels();
  S.switchingView = false;
  if (aim.active) aim.cancel();
  S.rewinding = null;
  document.body.classList.remove('rewinding');
  S.view = v;
  const solar = v !== 'galaxy';
  views.group.visible = trails.group.visible = ghosts.group.visible = solar;
  views.group.traverse((o) => { if (o.isCSS2DObject) o.visible = solar; });
  if (belt.points) belt.points.visible = solar;
  galaxy.setVisible(!solar);
  controls.maxDistance = solar ? 20000 : 2000;
  // back to default time speeds too
  S.speed = 0.25;
  S.galaxySpeed = 12;
  homeCamera(v);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.body.dataset.view = v;
  updateDock();
  renderInfo();
  updateRail();
}

// ---------------------------------------------------------------- time controls
function setPlaying(p) {
  if (S.view === 'galaxy') S.galaxyPlaying = p;
  else S.playing = p;
  updateDock();
}
const isPlaying = () => (S.view === 'galaxy' ? S.galaxyPlaying : S.playing);

const SPEED_MIN = Math.log10(0.01), SPEED_MAX = Math.log10(50);
const GSPEED_MIN = Math.log10(0.5), GSPEED_MAX = Math.log10(60);
function speedFromSlider(v) {
  const [a, b] = S.view === 'galaxy' ? [GSPEED_MIN, GSPEED_MAX] : [SPEED_MIN, SPEED_MAX];
  return 10 ** (a + (b - a) * v);
}
function sliderFromSpeed() {
  const [a, b] = S.view === 'galaxy' ? [GSPEED_MIN, GSPEED_MAX] : [SPEED_MIN, SPEED_MAX];
  const s = S.view === 'galaxy' ? S.galaxySpeed : S.speed;
  return (Math.log10(s) - a) / (b - a);
}
function speedText() {
  if (S.view === 'galaxy') return `${S.galaxySpeed < 10 ? S.galaxySpeed.toFixed(1) : S.galaxySpeed.toFixed(0)} Myr/s`;
  const s = S.speed;
  if (s < 1 / 12) return `${(s * 365.25).toFixed(s < 0.03 ? 1 : 0)} days/s`;
  if (s < 1) return `${(s * 12).toFixed(1)} months/s`;
  return `${s.toFixed(s < 10 ? 1 : 0)} yr/s`;
}

function updateDock() {
  $('#btn-play').innerHTML = isPlaying() ? '<svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  $('#btn-play').setAttribute('aria-label', isPlaying() ? 'Pause' : 'Play');
  $('#speed').value = sliderFromSpeed();
  $('#speed').style.setProperty('--fill', `${(sliderFromSpeed() * 100).toFixed(1)}%`);
  $('#speed-label').textContent = speedText();
  $('#btn-reset').disabled = S.view === 'galaxy';
  $('#btn-back').disabled = S.view === 'galaxy'; // when there's no more history, a press says so rather than doing nothing
}

$('#btn-play').onclick = () => { audio.ensure(); if (aim.active) aim.cancel(); setPlaying(!isPlaying()); };
$('#btn-reset').onclick = () => resetFlow();
$('#btn-back').onclick = () => rewind();

// ---------------------------------------------------------------- rewind time
// Every quarter second of play we keep a full in-memory snapshot (about 30 s worth). Rewind
// animates back through them, contrails shrinking as it goes, then plays forward from there.
// Each extra press while rewinding goes further back.
const hist = [];
let histT = 0;
const REWIND_STEP = 40; // 10 seconds of play per press (history is sampled every 250 ms)
function recordHist(now) {
  if (now - histT < 250) return;
  histT = now;
  hist.push({ ...sim.snapshot(), trailCount: trails.count });
  if (hist.length > 480) hist.shift(); // the last two minutes of play
  if (hist.length === 2) updateDock();
}
function rewind() {
  if (S.view === 'galaxy' || S.replay || S.reel) return;
  if (S.flight) abortReel();
  if (hist.length < 2) return toast('Nothing to rewind yet. Let time run for a moment.');
  if (aim.active) aim.cancel();
  audio.click(0.6);
  const R = S.rewinding || (S.rewinding = { at: hist.length - 1, target: hist.length - 1, wasPlaying: S.playing, from: sim.t });
  if (R.target === 0) return toast('That is as far back as Rewind goes (the last two minutes of play).');
  R.target = Math.max(0, R.target - REWIND_STEP);
  document.body.classList.add('rewinding');
  $('#btn-back').classList.add('on');
}
function tickRewind(dt) {
  const R = S.rewinding;
  if (!R) return;
  // ease back: faster when far from the target, about a second per press
  const speed = Math.max(30, (R.at - R.target) * 1.6);
  R.pos = (R.pos ?? R.at) - speed * dt;
  const i = Math.max(R.target, Math.round(R.pos));
  if (i !== R.at) {
    R.at = i;
    const h = hist[i];
    sim.restore(h);
    trails.rewindTo(h.trailCount);
    if (S.selected && !sim.get(S.selected)) S.selected = null;
  }
  if (R.at <= R.target) {
    hist.length = R.target + 1; // the old future is gone; it gets re-run from here
    // ...but anything you launched in it still gets launched again when time gets back there
    S.pending = launches.filter((l) => l.t > sim.t && !sim.get(l.body.id)).sort((a, b) => a.t - b.t);
    S.rewinding = null;
    document.body.classList.remove('rewinding');
    $('#btn-back').classList.remove('on');
    pushLog({ icon: '⏪', text: `Rewound ${fmtYears(R.from - sim.t)} to year ${(START_YEAR + sim.t).toFixed(2)}`, kind: 'note' });
    setPlaying(true);
    renderInfo();
  }
}
// Every launch, kept so a rewind can replay it rather than undo it.
const launches = [];
function forgetLaunches() { launches.length = 0; S.pending = null; }

// advance the game, re-launching anything a rewind went back past at the exact moment it first flew
function advancePlay(span, maxSteps) {
  const P = S.pending;
  if (!P?.length || S.replay || S.reel) return sim.advance(span, maxSteps);
  let done = 0;
  while (P.length && P[0].t <= sim.t + (span - done)) {
    const gap = P[0].t - sim.t;
    if (gap > 0) {
      done += sim.advance(gap, maxSteps);
      if (sim.t < P[0].t - 1e-9) return done; // ran out of steps this frame; carry on next frame
    }
    const l = P.shift();
    sim.readd(l.body);
    pushLog({ icon: '↻', text: `${l.body.name} launches again, as before`, kind: 'note' });
  }
  return done + sim.advance(span - done, maxSteps);
}
const fmtYears = (y) => (y < 1 / 12 ? `${(y * 365.25).toFixed(0)} days` : y < 1 ? `${(y * 12).toFixed(1)} months` : `${y.toFixed(1)} years`);
$('#speed').oninput = (e) => {
  e.target.style.setProperty('--fill', `${(+e.target.value * 100).toFixed(1)}%`);
  const v = speedFromSlider(+e.target.value);
  if (S.view === 'galaxy') S.galaxySpeed = v; else S.speed = v;
  $('#speed-label').textContent = speedText();
};

// ---------------------------------------------------------------- arsenal & aim bar
function buildArsenal() {
  const box = $('#arsenal');
  box.innerHTML = '';
  for (const s of SPAWNABLES) {
    const c = el('button', 'chip', `<span class="ic">${orb(s)}</span><span class="nm">${s.name}</span><span class="ms">${fmtMass(s.mass, true)}</span>`);
    c.dataset.type = s.type;
    c.title = s.blurb;
    c.onclick = () => (aim.active && aim.spec?.type === s.type ? (aim.cancel(), c.classList.remove('active')) : startAim(s.type));
    box.appendChild(c);
  }
}

const STEPS = [['place', 'Place'], ['heading', 'Pull & let go']];
function renderAimBar() {
  const h = aim.hud();
  const bar = $('#aimbar');
  document.body.classList.toggle('aiming', !!h);
  if (!h) {
    bar.hidden = true;
    bar.dataset.key = '';
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    // cancelling resumes time if it was running before
    if (S.wasPlaying && !S.playing && !S.mission?.done) setPlaying(true);
    S.wasPlaying = false;
    return;
  }
  bar.hidden = false;
  const s = h.spec;
  const key = h.mode + s.type;
  if (bar.dataset.key !== key) {
    bar.dataset.key = key;
    const idx = STEPS.findIndex(([m]) => m === h.mode);
    const steps = STEPS.map(([, name], i) => `<span class="${i < idx ? 'done' : i === idx ? 'on' : ''}"><i>${i < idx ? '✓' : i + 1}</i>${name}</span>`).join('');
    let body = '';
    if (h.mode === 'place') body = `<div class="aim-msg"><b>${s.icon} ${s.name}</b> Tap anywhere in space to place it.</div>`;
    if (h.mode === 'heading') body = `
      <div class="aim-msg"><b>Pull back &amp; let go.</b> Sideways aims, further is faster. Drag the sky to look around: left/right turns, up/down tilts.</div>
      <div class="aim-row"><div class="aim-live"></div><button data-a="back" class="aim-back">Back</button></div>`;
    const back = h.mode === 'place' ? 'Cancel' : 'Back';
    const next = '';
    // the slingshot step keeps Back beside the tilt, so the panel leaves room to see the shot
    const actions = h.mode === 'heading' ? '' : `<div class="aim-actions"><button data-a="back">${back}</button>${next ? `<button data-a="next" class="primary">${next}</button>` : ''}</div>`;
    bar.innerHTML = `<div class="wiz-steps">${steps}</div>${body}${actions}`;
    // a step change swallows taps for a moment so a repeated tap can't skip straight to Launch
    const guarded = (fn) => () => { const n = performance.now(); if (n - (S.stepAt || 0) < 350) return; S.stepAt = n; fn(); };
    bar.querySelector('[data-a=back]').onclick = guarded(() => aim.back());
    const nx = bar.querySelector('[data-a=next]');
    if (nx) nx.onclick = guarded(() => aim.next());
    const tilt = bar.querySelector('#tilt');
    if (tilt) tilt.oninput = (e) => aim.setElevation(+e.target.value);
    requestAnimationFrame(frameAim);
  }
  // live values, without rebuilding controls under the user's finger
  const tilt = bar.querySelector('#tilt');
  if (tilt && document.activeElement !== tilt) tilt.value = h.elev.toFixed(0);
  const tv = bar.querySelector('#tilt-val');
  if (tv) tv.textContent = `${h.elev.toFixed(0)}°`;
  const live = bar.querySelector('.aim-live');
  if (live) {
    if (!h.aiming) live.innerHTML = `<span class="muted">Solid ring: circular orbit. Dashed: escape speed.${Math.abs(h.elev) >= 1 ? ` Tilted ${h.elev > 0 ? 'up' : 'down'} ${Math.abs(h.elev).toFixed(0)}°.` : ''}</span>`;
    else {
      const hit = h.hit ? `<span class="bad">⚠ Hits ${h.hit} in ${h.hitIn < 1 ? `${(h.hitIn * 12).toFixed(1)} months` : `${h.hitIn.toFixed(1)} yr`}</span>` : '<span class="muted">No impact predicted</span>';
      const kind = Math.abs(h.mult - 1) < 0.01 ? 'circular orbit' : Math.abs(h.mult - Math.SQRT2) < 0.01 ? 'escape speed' : `${h.mult.toFixed(2)}× orbit speed`;
      const tilt = Math.abs(h.elev) >= 1 ? ` · tilted ${h.elev > 0 ? 'up' : 'down'} ${Math.abs(h.elev).toFixed(0)}°` : '';
      live.innerHTML = `${hit} · <span class="muted"><b class="mono">${h.speed.toFixed(1)} km/s</b> · ${kind}${tilt}</span>`;
    }
  }
}

// While aiming, centre the view on the free space between the top bar and the wizard
// (the slingshot view then frames the object itself, in that space).
const viewShift = { cur: 0, goal: 0 };
function frameAim() {
  if (!aim.active) { viewShift.goal = 0; return; }
  const cmp = $('.sling-compass');
  const top = Math.max($('.topbar').getBoundingClientRect().bottom, $('#telemetry').getBoundingClientRect().bottom, cmp && !cmp.hidden ? cmp.getBoundingClientRect().bottom : 0) + 8;
  const bottom = $('.dock').getBoundingClientRect().top - 8;
  viewShift.goal = Math.max(0, innerHeight / 2 - (top + bottom) / 2);
}
aim.app.onPlaced = () => requestAnimationFrame(frameAim);
function applyViewShift(dt) {
  if (!aim.active) viewShift.goal = 0;
  viewShift.cur += (viewShift.goal - viewShift.cur) * (1 - Math.exp(-dt * 6));
  if (Math.abs(viewShift.cur) > 0.5) camera.setViewOffset(innerWidth, innerHeight, 0, viewShift.cur, innerWidth, innerHeight);
  else if (camera.view?.enabled) camera.clearViewOffset();
}

let aimBarPending = false;
const _renderAimBar = renderAimBar;
function throttledAimBar() {
  if (aimBarPending) return;
  aimBarPending = true;
  requestAnimationFrame(() => { aimBarPending = false; _renderAimBar(); });
}
aim.app.onAimChange = throttledAimBar;

// ---------------------------------------------------------------- right rail
const RAIL = [
  { id: 'orig', icon: icon('ghost'), label: 'Original orbits', act: () => toggleOrigOrbits() },
  { id: 'center', pill: true, label: 'Center the view on…', act: () => openCenterPicker() },
  { id: 'fit', icon: '⤢', label: 'Fit view (press again for the whole system)', act: () => fit() },
  { id: 'layers', icon: '◫', label: 'Layers', act: () => openLayers() },
];

function buildRail() {
  const box = $('#rail');
  box.innerHTML = '';
  for (const r of RAIL) {
    const b = el('button', r.pill ? 'rail-btn rail-pill' : 'rail-btn', r.pill ? '<span class="cn"></span>' : `<span>${r.icon}</span><em>${r.label}</em>`);
    b.dataset.id = r.id;
    b.setAttribute('aria-label', r.label);
    b.onclick = () => { audio.click(1); r.act(); updateRail(); };
    box.appendChild(b);
  }
  updateRail();
}

function updateRail() {
  $('#rail [data-id=orig]')?.classList.toggle('on', !!settings.origOrbits[S.view]);
  const c = $('#rail [data-id=center] .cn');
  if (c) c.innerHTML = `<small>${rig.mode === 'ride' ? 'Riding' : 'Centred on'}</small>◎ ${centerName()} ▾`;
}

function toggleOrigOrbits() {
  const on = (settings.origOrbits[S.view] = !settings.origOrbits[S.view]);
  saveSettings();
  const where = S.view === 'helix' ? 'Helix' : 'Solar';
  toast(on ? `Original orbits on in the ${where} view: dashed lines show where knocked planets used to go.` : `Original orbits off in the ${where} view: they show briefly after a planet is knocked, then fade.`);
}

function openCenterPicker() {
  const bodies = sim.bodies.filter((b) => b.alive);
  const cur = (rig.mode === 'follow' || rig.mode === 'ride') ? S.selected : refId();
  sheet('Center the view on…', `
    <div class="pick-list">${bodies.map((b) => `<button data-id="${b.id}" class="${b.id === cur ? 'on' : ''}"><span class="dot" style="background:${b.kind === 'blackhole' ? '#ff9a4a' : b.color}"></span><b>${b.name}</b><small>${b.spawned ? 'launched' : b.id === 'pluto' ? 'dwarf planet' : b.kind}</small></button>`).join('')}</div>
    <h4>Camera angle</h4>
    <div class="seg-row"><button data-cam="tilt">Tilted</button><button data-cam="top">Top-down</button><button data-cam="ride">Ride along</button></div>
    <p class="muted small">Tip: tap any planet, then “Center on”. Double-tap also centres.</p>`, (box) => {
    box.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => { closeModal(); centerOn(b.dataset.id); }; });
    box.querySelector('[data-cam=tilt]').onclick = () => { closeModal(); const d = camera.position.distanceTo(controls.target); rig.offsetGoal = new THREE.Vector3(-0.6, 0.35, 0.72).normalize().multiplyScalar(d); };
    box.querySelector('[data-cam=top]').onclick = () => { closeModal(); const d = camera.position.distanceTo(controls.target); rig.offsetGoal = new THREE.Vector3(0, d, d * 0.0001); };
    box.querySelector('[data-cam=ride]').onclick = () => { closeModal(); setCamMode('ride'); };
  });
}

function openLayers() {
  const rows = [
    ['hz', 'Habitable zone', 'Green band where liquid water can exist'],
    ['trails', 'Contrails', 'Paths each body has travelled'],
    ['labels', 'Labels', 'Names and live status'],
    ['grid', 'Gravity wells', 'Spacetime sheet: deeper funnel, stronger pull'],
    ['scale', 'True scale (1:1)', 'Real sizes: planets become specks'],
  ];
  sheet('Layers', rows.map(([k, t, d]) => `<label class="row check layer"><input type="checkbox" data-k="${k}" ${(k === 'scale' ? settings.scale === 'real' : settings[k]) ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join(''), (box) => {
    box.querySelectorAll('[data-k]').forEach((c) => { c.onchange = () => toggle(c.dataset.k); });
  });
}

function toggle(k) {
  if (k === 'scale') {
    settings.scale = settings.scale === 'real' ? 'visible' : 'real';
    sim.scaleMode = settings.scale;
    toast(settings.scale === 'real' ? 'True scale: planets are specks. Markers show where they are. Collisions get much harder!' : 'Visible scale: sizes exaggerated so you can see them. Distances and masses stay real.');
  } else settings[k] = !settings[k];
  views.showLabels = settings.labels;
  trails.visible = settings.trails;
  saveSettings();
  updateRail();
}

// ---------------------------------------------------------------- habitable zone rings
function hzTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 4;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0, 'rgba(110,255,170,0.95)');
  g.addColorStop(0.03, 'rgba(80,240,150,0.45)');
  g.addColorStop(0.12, 'rgba(80,230,140,0.3)');
  g.addColorStop(0.5, 'rgba(80,230,140,0.36)');
  g.addColorStop(0.88, 'rgba(80,230,140,0.3)');
  g.addColorStop(0.97, 'rgba(80,240,150,0.45)');
  g.addColorStop(1, 'rgba(110,255,170,0.95)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const HZ_TEX = hzTexture();
function updateHZ() {
  const want = new Set();
  if (settings.hz && S.view !== 'galaxy') {
    for (const s of sim.bodies) {
      if (!s.alive || !(s.luminosity > 0.0005)) continue;
      want.add(s.id);
      let m = hzGroup.getObjectByName(s.id);
      if (!m) {
        const L = Math.sqrt(s.luminosity), r0 = 0.95 * L, r1 = 1.67 * L;
        const geo = new THREE.RingGeometry(r0, r1, 160, 1);
        const pos = geo.attributes.position, uv = geo.attributes.uv, v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); uv.setXY(i, (v.length() - r0) / (r1 - r0), 0.5); }
        m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: HZ_TEX, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.name = s.id;
        // crisp glowing edges, so the band reads at any zoom
        for (const r of [r0, r1]) {
          const pts = Array.from({ length: 241 }, (_, i) => new THREE.Vector3(Math.cos((i / 240) * Math.PI * 2) * r, Math.sin((i / 240) * Math.PI * 2) * r, 0));
          const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8dffbf, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
          edge.name = 'edge';
          m.add(edge);
        }
        const el2 = el('div', 'label hz-label', '<b>Habitable zone</b><small>where Earth can keep liquid water</small>');
        const lab = new CSS2DObject(el2);
        lab.position.set(0, -r1, 0); // ring is rotated, so local -y is "in front"
        lab.center.set(0.5, 0);
        m.add(lab);
        hzGroup.add(m);
      }
      toRender(s, m.position);
      // a slow breathing glow draws the eye without flashing
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 700);
      m.material.opacity = 0.85 + 0.15 * pulse;
      for (const c of m.children) if (c.name === 'edge') c.material.opacity = 0.6 + 0.4 * pulse;
    }
  }
  for (const c of [...hzGroup.children]) {
    if (!want.has(c.name)) { c.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); o.geometry?.dispose(); }); c.removeFromParent(); }
  }
}


// ---------------------------------------------------------------- telemetry
function stabilityInfo() {
  const s = sim.stability ?? 100;
  const [label, cls] = s > 95 ? ['NOMINAL', 'good'] : s > 75 ? ['PERTURBED', 'warn'] : s > 40 ? ['UNSTABLE', 'bad'] : ['CHAOTIC COLLAPSE', 'bad pulse'];
  return { s, label, cls };
}
function renderTelemetry() {
  const box = $('#telemetry');
  if (S.view === 'galaxy') {
    box.innerHTML = `<div class="t-strip"><span>EPOCH</span><b>${galaxy.timeLabel()}</b><em>•</em><span>ORBIT</span><b>${((galaxy.t + 540) / 230).toFixed(2)} gal. yr</b></div><div class="t-note">Vertical bobbing ×3 for visibility</div>`;
    return;
  }
  const st = stabilityInfo();
  const year = START_YEAR + sim.t;
  const es = earthStatus();
  const dil = S.slow < 0.95 ? '<i class="badge">SLOW-MO</i>' : S.dilated ? '<i class="badge warn">BUSY</i>' : '';
  if (!box.querySelector('#earth-pill')) {
    box.innerHTML = `
      <div class="t-strip"><span>YEAR</span><b class="t-year"></b><em>•</em><i class="t-dot"></i><span>STABILITY</span><b class="t-stab"></b><i class="t-badge"></i></div>
      <button class="earth-pill" id="earth-pill" aria-label="Earth status, tap to center on Earth"><i class="globe"></i><span><b>Earth</b> <span class="t-earth"></span></span></button>`;
    box.querySelector('#earth-pill').onclick = () => { if (sim.get('earth')) centerOn('earth'); };
  }
  const set = (sel, txt) => { const n = box.querySelector(sel); if (n.textContent !== txt) n.textContent = txt; };
  set('.t-year', year.toFixed(2));
  set('.t-stab', `${st.s.toFixed(0)}% (${st.label})`);
  box.querySelector('.t-dot').className = `t-dot ${st.cls}`;
  set('.t-earth', es.text);
  box.querySelector('#earth-pill').className = `earth-pill ${es.cls}`;
  const badge = box.querySelector('.t-badge');
  set('.t-badge', dil ? (S.slow < 0.95 ? 'SLOW-MO' : 'BUSY') : '');
  badge.className = `t-badge ${dil ? (S.slow < 0.95 ? 'badge' : 'badge warn') : ''}`;
  // live status on Earth's label
  const earth = sim.get('earth');
  if (earth) {
    if (earth.tagline !== es.short) { earth.tagline = es.short; earth._dirty = true; }
    // An orbit that grazes the edge flips in and out every lap: say so the first time, then
    // only when a new state has held for a while (a real change, not the same wobble again).
    if (S.lastZone && S.lastZone !== es.zone && sim.t > 0) {
      const settled = sim.t - (S.zoneSince ?? 0) > 1.5;
      if (!S.zoneTold || settled) toast(es.zone === 'ok' ? 'Earth is back in the habitable zone' : `Earth has left the habitable zone: ${es.text}`);
      S.zoneTold = true;
      S.zoneSince = sim.t;
    }
    if (S.lastZone !== es.zone && !S.lastZone) S.zoneSince = sim.t;
    S.lastZone = es.zone;
  }
}

// ---------------------------------------------------------------- stop / save / load / share
// Reset: offer to save first (saves are small JSON snapshots), then start a fresh solar system.
function resetFlow() {
  const wasPlaying = S.playing;
  setPlaying(false);
  aim.cancel();
  const save = buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift });
  const kb = (JSON.stringify(save).length / 1024).toFixed(0);
  const changed = sim.bodies.some((b) => b.spawned) || chronicle.length > 0;
  // a fresh start means today's date at the starting time speed, too
  const fresh = () => { closeModal(); endMission(true); freshUniverse(); S.speed = DEFAULT_SPEED; S.galaxySpeed = DEFAULT_GALAXY_SPEED; updateDock(); fitDefault(); setPlaying(true); };
  if (!changed) { fresh(); toast('Reset to today\'s solar system.'); return; }
  modal({
    title: 'Reset the solar system?',
    body: `<p>You'll lose this run: ${S.shots} launch${S.shots === 1 ? '' : 'es'} and ${chronicle.length} event${chronicle.length === 1 ? '' : 's'}. Want to save it first?</p>
           <p class="muted small">A save stores positions and velocities, not video, so it's only about ${kb} KB. Load it later from the menu.</p>`,
    actions: [
      { label: 'Save, then reset', primary: true, onClick: () => { downloadJSON(save, `solar-system-${Math.round(START_YEAR + sim.t)}-${Date.now().toString(36)}.json`); fresh(); toast('Saved. Back to today\'s solar system.'); } },
      { label: 'Reset without saving', onClick: fresh },
      { label: 'Cancel', onClick: () => { closeModal(); setPlaying(wasPlaying); } },
    ],
  });
}


function applySave(data) {
  loadSim(data.sim);
  if (data.settings?.drift) settings.drift = data.settings.drift;
  if (data.settings?.frame) settings.frame = data.settings.frame;
  if (data.settings?.view && data.settings.view !== 'galaxy') setView(data.settings.view);
  if (data.settings?.speed) S.speed = data.settings.speed;
  setPlaying(false);
  fit();
  updateDock();
  toast(`Loaded a universe from year ${(START_YEAR + sim.t).toFixed(1)}. Press play.`);
}

function loadFromFile() {
  const inp = el('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => { try { applySave(await readFile(inp.files[0])); closeModal(); } catch (e) { toast(`⚠ ${e.message}`); } };
  inp.click();
}

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const f = e.dataTransfer.files[0];
  if (f) try { applySave(await readFile(f)); } catch (err) { toast(`⚠ ${err.message}`); }
});

setInterval(() => {
  if (S.view === 'galaxy' || S.mission || S.replay || S.reel || !sim.bodies.some((b) => b.spawned)) return;
  store.set('gm.autosave', buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift }));
}, 15000);

// ---------------------------------------------------------------- menus
function openMissions() {
  sheet('Challenges', MISSIONS.map((m) => {
    const st = S.missionStars[m.id] || 0;
    return `<button class="mission" data-id="${m.id}"><div><b>${m.title}</b><small class="lvl lvl-${m.level.toLowerCase()}">${m.level}</small></div><p>${m.desc}</p><div class="stars small">${'★'.repeat(st)}<span>${'★'.repeat(3 - st)}</span></div></button>`;
  }).join(''), (box) => {
    box.querySelectorAll('.mission').forEach((b) => { b.onclick = () => startMission(MISSIONS.find((m) => m.id === b.dataset.id)); });
  });
}

// Bug reports and feature requests become GitHub issues: the form fills in a new-issue page on
// the repo, with what the person saw plus the details we'd ask for anyway.
const REPO = 'https://github.com/simbonk/heliosling';
function openFeedback() {
  sheet('Bugs & ideas', `<form class="feedback">
    <div class="seg fb-kind" role="radiogroup">
      <label><input type="radio" name="kind" value="bug" checked><span>🐞 Bug</span></label>
      <label><input type="radio" name="kind" value="feature"><span>✨ Feature idea</span></label>
    </div>
    <label class="fb-field"><span>Title</span><input name="title" maxlength="120" required placeholder="Rewind skips back too far"></label>
    <label class="fb-field"><span class="fb-what">What happened?</span><textarea name="body" rows="5" required placeholder="What you did, what you expected, what you saw"></textarea></label>
    <label class="fb-check"><input type="checkbox" name="env" checked><span>Include device and simulation details</span></label>
    <p class="muted">This opens a prefilled GitHub issue. You'll need a GitHub account to post it.</p>
    <button class="primary" type="submit">Continue to GitHub</button>
  </form>`, (box) => {
    const f = box.querySelector('form');
    const what = box.querySelector('.fb-what');
    f.kind.forEach((r) => { r.onchange = () => {
      const bug = f.kind.value === 'bug';
      what.textContent = bug ? 'What happened?' : 'What would you like?';
      f.title.placeholder = bug ? 'Rewind skips back too far' : 'Let me launch from the Moon';
      f.body.placeholder = bug ? 'What you did, what you expected, what you saw' : 'The idea, and what it would let you do';
    }; });
    f.onsubmit = (e) => {
      e.preventDefault();
      const bug = f.kind.value === 'bug';
      let body = f.body.value.trim();
      if (f.env.checked) {
        body += `\n\n---\n**Details**\n- Page: ${location.origin}${location.pathname}\n- Browser: ${navigator.userAgent}\n- Screen: ${innerWidth}×${innerHeight} @${devicePixelRatio}x\n- View: ${S.view}, year ${(START_YEAR + sim.t).toFixed(1)}, ${sim.alive().length} bodies, speed ${S.speed.toPrecision(2)} yr/s`;
      }
      const q = new URLSearchParams({ title: `${bug ? '[Bug]' : '[Idea]'} ${f.title.value.trim()}`, body, labels: bug ? 'bug' : 'enhancement' });
      window.open(`${REPO}/issues/new?${q}`, '_blank', 'noopener');
      closeModal();
      toast('Thanks! Finish posting it on GitHub.');
    };
    f.title.focus();
  });
}

// Hand-picked shots that come with the game, found by running the simulation: watch them like
// your own saved shots, then go and do better.
function openTrickShots() {
  const rows = TRICK_SHOTS.map((r) => `<div class="shot-row trick" data-id="${r.id}"><div><b>${r.name}</b><small>${r.blurb}</small></div><button data-play="${r.id}" class="primary">▶ Watch</button></div>`).join('');
  sheet('Trick shots', `<p class="muted menu-note">A few shots worth seeing. Each one plays out in its own universe, then you're back in yours.</p><div class="shot-list">${rows}</div>
    <p class="muted menu-note">Made something worth featuring? Share it from your saved shots and send us the link.</p>
    <a class="menu-link" href="${REPO}/issues/new?title=${encodeURIComponent('Trick shot: ')}&body=${encodeURIComponent('Share link:\n\nWhat happens:\n')}" target="_blank" rel="noopener">Suggest a trick shot ↗</a>`, (box) => {
    box.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => { closeModal(); playShot(TRICK_SHOTS.find((r) => r.id === b.dataset.play)); }; });
  });
}

function openMenu() {
  sheet('Menu', `
    <div class="menu-grid">
      ${store.get('gm.autosave')?.sim?.bodies?.some((b) => b.spawned) ? `<button data-m="resume">${icon('history')} Resume last run</button>` : ''}
      <button data-m="save">Save .json</button>
      <button data-m="load">Load .json</button>
      <button data-m="tricks">Trick shots</button>
      <button data-m="tour">Take the tour</button>
    </div>
    <h4>Bugs & ideas</h4>
    <p class="muted menu-note">Heliosling is fully open source. Found a bug or have an idea? Tell us on GitHub, or read and change the code yourself.</p>
    <div class="menu-grid">
      <button data-m="feedback">Report a bug or idea</button>
      <a class="menu-link" href="${REPO}/issues" target="_blank" rel="noopener">Open issues ↗</a>
      <a class="menu-link" href="${REPO}" target="_blank" rel="noopener">Source code ↗</a>
    </div>
    <label class="row check menu-sound"><input type="checkbox" id="set-sound"> Sound</label>
    <h4>Advanced settings</h4>
    <label class="row">Helix drift speed <span id="drift-val"></span>
      <input type="range" id="set-drift" min="0" max="1" step="0.001"></label>
    <label class="row">Contrail length <input type="range" id="set-trail" min="0.05" max="1" step="0.01"></label>
    <label class="row check"><input type="checkbox" id="set-belt"> Asteroid belt</label>
    <label class="row check"><input type="checkbox" id="set-reels"> Follow cam and replays after each launch</label>
    <label class="row check"><input type="checkbox" id="set-slowmo"> Auto slow-mo on close calls</label>
    <label class="row check"><input type="checkbox" id="set-lens"> Gravitational lensing</label>
    <label class="row check"><input type="checkbox" id="set-bloom"> Glow (bloom)</label>
  `, (box) => {
    box.querySelector('[data-m=save]').onclick = () => { downloadJSON(buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift }), `universe-${Math.round(START_YEAR + sim.t)}.json`); toast('Saved.'); };
    box.querySelector('[data-m=load]').onclick = loadFromFile;
    const res = box.querySelector('[data-m=resume]');
    if (res) res.onclick = () => { closeModal(); resumeLastRun(); };
    box.querySelector('[data-m=tour]').onclick = () => { closeModal(); startTour(); };
    box.querySelector('[data-m=feedback]').onclick = openFeedback;
    box.querySelector('[data-m=tricks]').onclick = openTrickShots;
    // phones have no room for the sound button in the top bar, so it lives here instead
    const snd = box.querySelector('#set-sound');
    snd.checked = !audio.muted;
    snd.onchange = () => { audio.ensure(); audio.setMuted(!snd.checked); updateSound(); };
    const dr = box.querySelector('#set-drift'), dv = box.querySelector('#drift-val');
    const toD = (x) => 0.2 * (REAL_DRIFT / 0.2) ** x, fromD = (d) => Math.log(d / 0.2) / Math.log(REAL_DRIFT / 0.2);
    const showD = () => { dv.textContent = `${(settings.drift * KMS_PER_AUYR).toFixed(0)} km/s${settings.drift >= REAL_DRIFT * 0.98 ? ' (real)' : ' (stylised)'}`; };
    dr.value = fromD(settings.drift); showD();
    dr.oninput = () => { settings.drift = toD(+dr.value); showD(); saveSettings(); };
    const tr = box.querySelector('#set-trail');
    tr.value = settings.trailLength;
    tr.oninput = () => { settings.trailLength = trails.length = +tr.value; saveSettings(); };
    const chk = (id, key, after) => { const c = box.querySelector(id); c.checked = settings[key]; c.onchange = () => { settings[key] = c.checked; saveSettings(); after?.(); }; };
    chk('#set-belt', 'belt', () => { if (settings.belt) sim.initBelt(MOBILE ? 500 : 900); else sim.initBelt(0); });
    chk('#set-reels', 'reels');
    chk('#set-slowmo', 'slowmo');
    chk('#set-lens', 'lensing');
    chk('#set-bloom', 'bloom', () => { bloom.enabled = settings.bloom; });
  });
}


function openHelp() {
  modal({
    title: 'Controls',
    body: `
      <p>${MOBILE ? 'One finger orbits, pinch zooms, two fingers pan.' : 'Drag to orbit, scroll to zoom, right-drag to pan.'} Tap a planet to center on it.</p>
      ${MOBILE ? '' : `<div class="keys">
        <span><kbd>Space</kbd> play / pause</span><span><kbd>[</kbd> <kbd>]</kbd> speed</span><span><kbd>B</kbd> rewind</span>
        <span><kbd>F</kbd> fit</span><span><kbd>0</kbd>–<kbd>9</kbd> center on Sun / planets</span><span><kbd>V</kbd> next view</span>
        <span><kbd>H</kbd> habitable zone</span><span><kbd>G</kbd> gravity wells</span><span><kbd>L</kbd> labels</span>
        <span><kbd>←</kbd> <kbd>→</kbd> turn aim</span><span><kbd>↑</kbd> <kbd>↓</kbd> faster / slower</span><span><kbd>Enter</kbd> launch</span>
      </div>`}`,
    actions: [
      { label: 'Take the tour', primary: true, onClick: () => { closeModal(); startTour(); } },
      { label: 'Close', onClick: closeModal },
    ],
  });
}

// ---------------------------------------------------------------- tour
// Offered once on the first visit (the answer is remembered) and always in the menu. Each step
// spotlights the part of the screen it talks about; steps without a target sit mid-screen.
const TOUR_KEY = 'hs.tour';
const TOUR = [
  { t: 'Welcome to Heliosling', b: "This is our solar system, right now: every planet where it really is today, moving under real gravity. Your job is to throw things at it and see what happens." },
  { el: '#views', t: 'Three ways to look', b: '<b>Helix</b>: the Sun flies through the galaxy, so the planets trace corkscrews. <b>Solar</b>: the classic Sun-centred view. <b>Milky Way</b>: the Sun\'s 230-million-year lap around the galaxy.' },
  { el: '#arsenal', t: '1. Pick something to throw', b: 'Asteroids, comets, rogue planets, whole stars, a black hole. Swipe the bar for more, then tap one.' },
  { t: '2. Tap where it starts', b: 'Tap anywhere in space to drop it there. Its starting aim is a neat orbit around whatever pulls hardest at that spot, usually the Sun.', fig: 'place' },
  { t: '3. Pull back and let go', b: 'The camera drops in behind a slingshot. <b>Pull further</b> to throw harder. <b>Pull to one side</b> to aim the other way. The <b>solid ring</b> is the speed for a circular orbit, and the <b>dashed ring</b> is escape speed. A ghost path shows where it will go, and warns you about a hit. <b>Drag the sky</b> to turn or tip the shot up and down, or tap a name on the compass strip to face it.', fig: 'sling' },
  { t: '4. Watch the fireworks', b: 'The camera chases your shot, then replays it from the side and from above. If it hit something, you also get the view from the target. Liked it? Save it when asked.' },
  { el: '.timebar', t: 'Time controls', b: 'Play or pause, <b>rewind</b> 10 seconds per press, and drag the slider to speed time up or slow it down.' },
  { el: '#btn-reset', t: 'Start over', b: 'Puts the solar system back to how it is today. It offers to save your mess first.' },
  { el: '#earth-pill', t: 'Keep an eye on Earth', b: 'Its temperature, and whether it is still in the habitable zone. Tap it to fly to Earth.' },
  { el: '#btn-saved', t: 'Your saved shots', b: 'Every shot you saved, ready to rewatch.' },
  { el: '#btn-menu', t: 'The menu', b: 'Has <b>trick shots</b> to watch for ideas, this tour again, and a way to report bugs or ideas.' },
];

const TOUR_FIG = {
  place: `<svg viewBox="0 0 220 90" class="tour-fig" aria-hidden="true"><circle cx="40" cy="45" r="14" fill="#ffcc66"/><ellipse cx="40" cy="45" rx="90" ry="26" fill="none" stroke="currentColor" stroke-opacity=".25"/><circle cx="160" cy="34" r="6" fill="#9a8f84"/><circle cx="160" cy="34" r="13" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/><path d="M178 58 l-10 -12 m10 12 l2 -14" stroke="var(--accent)" stroke-width="2" fill="none"/><text x="184" y="74" fill="currentColor" font-size="11">tap</text></svg>`,
  sling: `<svg viewBox="0 0 220 110" class="tour-fig" aria-hidden="true"><circle cx="110" cy="40" r="26" fill="none" stroke="currentColor" stroke-opacity=".35"/><circle cx="110" cy="40" r="38" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 4"/><path d="M110 98 V60 M110 60 Q106 50 92 44 M110 60 Q114 50 128 44" stroke="#d8a878" stroke-width="5" fill="none" stroke-linecap="round"/><line x1="92" y1="44" x2="104" y2="76" stroke="#e06a4a" stroke-width="2"/><line x1="128" y1="44" x2="104" y2="76" stroke="#e06a4a" stroke-width="2"/><circle cx="104" cy="76" r="7" fill="#9a8f84"/><path d="M110 30 L118 6" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 3"/><path d="M118 6 l-7 3 m7 -3 l1 7" stroke="var(--accent)" stroke-width="2" fill="none"/><text x="140" y="92" fill="currentColor" font-size="11">pull back</text><text x="124" y="16" fill="currentColor" font-size="11">flies this way</text></svg>`,
};

function startTour(i = 0) {
  endTour();
  closeModal();
  if (aim.active) aim.cancel();
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = '<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-live="polite"></div>';
  document.body.appendChild(root);
  const hole = root.querySelector('.tour-hole'), card = root.querySelector('.tour-card');
  const go = (k) => {
    if (k < 0) return;
    if (k >= TOUR.length) return endTour(true);
    i = k;
    const st = TOUR[i];
    const target = st.el && document.querySelector(st.el);
    const r = target && target.getClientRects().length ? target.getBoundingClientRect() : null;
    card.innerHTML = `<div class="tour-step">${i + 1} / ${TOUR.length}</div><h3>${st.t}</h3>${st.fig ? TOUR_FIG[st.fig] : ''}<p>${st.b}</p>
      <div class="tour-actions"><button class="tour-skip">${i === TOUR.length - 1 ? '' : 'Skip tour'}</button><span>${i ? '<button class="tour-prev">Back</button>' : ''}<button class="primary tour-next">${i === TOUR.length - 1 ? 'Start flinging' : 'Next'}</button></span></div>`;
    root.classList.toggle('centered', !r);
    if (r) {
      const pad = 6;
      Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const below = r.top + r.height / 2 < innerHeight / 2;
      card.style.top = below ? `${Math.min(r.bottom + 14, innerHeight - card.offsetHeight - 12)}px` : '';
      card.style.bottom = below ? '' : `${Math.max(innerHeight - r.top + 14, 12)}px`;
    } else {
      Object.assign(hole.style, { left: '50%', top: '50%', width: '0px', height: '0px' });
      card.style.top = card.style.bottom = '';
    }
    card.querySelector('.tour-next').onclick = () => go(i + 1);
    card.querySelector('.tour-prev')?.addEventListener('click', () => go(i - 1));
    card.querySelector('.tour-skip').onclick = () => endTour(true);
    card.querySelector('.tour-next').focus();
  };
  root.onclick = (e) => { if (e.target === root || e.target === hole) go(i + 1); };
  S.tourKeys = (e) => {
    e.stopImmediatePropagation();
    if (e.key === 'Escape') endTour(true);
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') go(i - 1);
  };
  window.addEventListener('keydown', S.tourKeys, true);
  S.tourResize = () => go(i);
  window.addEventListener('resize', S.tourResize);
  go(i);
}

function endTour(done) {
  document.querySelector('.tour')?.remove();
  if (S.tourKeys) window.removeEventListener('keydown', S.tourKeys, true);
  if (S.tourResize) window.removeEventListener('resize', S.tourResize);
  S.tourKeys = S.tourResize = null;
  if (done) store.set(TOUR_KEY, 'seen');
}

// first visit only: ask once, and remember the answer either way
function offerTour() {
  if (store.get(TOUR_KEY)) return;
  modal({
    title: 'New to Heliosling?',
    body: '<p>Take a one-minute tour of how to pick, place and fling things. You can always find it later in the menu.</p>',
    actions: [
      { label: 'Take the tour', primary: true, onClick: () => { closeModal(); startTour(); } },
      { label: 'No thanks', onClick: () => { closeModal(); store.set(TOUR_KEY, 'skipped'); } },
    ],
  });
}

$('#btn-saved').onclick = openSaved;
$('#btn-menu').onclick = openMenu;
$('#btn-sound').onclick = () => { audio.ensure(); audio.setMuted(!audio.muted); updateSound(); };
function updateSound() { $('#btn-sound').innerHTML = icon(audio.muted ? 'mute' : 'volume'); $('#btn-sound').setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute'); }
document.querySelectorAll('#views button').forEach((b) => { b.onclick = () => setView(b.dataset.view); });

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (aim.active && ['Escape', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') { e.preventDefault(); setPlaying(!isPlaying()); }
  else if (e.key === 'Escape') { closeModal(); select(null); }
  else if (k === '[' || k === ']') {
    const f = k === ']' ? 1.5 : 1 / 1.5;
    if (S.view === 'galaxy') S.galaxySpeed = Math.min(60, Math.max(0.5, S.galaxySpeed * f));
    else S.speed = Math.min(50, Math.max(0.01, S.speed * f));
    updateDock();
  } else if (k === 'r') resetToShot();
  else if (k === 'b') rewind();
  else if (k === 'f') fit();
  else if (k === 't') setCamMode('top');
  else if (k === 'c') setCamMode('system');
  else if (k === 'g') toggle('grid');
  else if (k === 'h') toggle('hz');
  else if (k === 'l') toggle('labels');
  else if (k === 'm') { audio.setMuted(!audio.muted); updateSound(); }
  else if (k === 'v') setView({ solar: 'helix', helix: 'galaxy', galaxy: 'solar' }[S.view]);
  else if (k === '?') openHelp();
  else if (/^[0-9]$/.test(k)) {
    const id = k === '0' ? 'sun' : PLANETS[+k - 1]?.id;
    if (id && sim.get(id)) centerOn(id);
  } else return;
  updateRail();
});

// ---------------------------------------------------------------- slow-mo near close calls
function closeCallFactor() {
  let f = 1;
  const list = sim.alive();
  for (const a of list) {
    if (!a.spawned && !a.hostile) continue;
    for (const b of list) {
      if (a === b || b.mass < 1e-9) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const r = sim.radius(a) + sim.radius(b);
      const ratio = d / r;
      if (ratio < 6) {
        const closing = ((a.x - b.x) * (a.vx - b.vx) + (a.y - b.y) * (a.vy - b.vy) + (a.z - b.z) * (a.vz - b.vz)) < 0;
        const rel = Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz);
        // aim for the encounter to take about two real seconds
        const want = (r * 4) / Math.max(rel, 1e-6) / 2 / S.speed;
        if (closing || ratio < 3) f = Math.min(f, Math.max(0.02, Math.min(1, want)));
      }
    }
  }
  return f;
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
let teleT = 0, infoT = 0, missionT = 0;
const tmp = new THREE.Vector3();
// If the phone can't keep up, render at fewer pixels so taps and the HUD stay responsive.
let frameEma = 16, slowSince = 0;
function adaptQuality(now, ms) {
  frameEma += (ms - frameEma) * 0.05;
  if (frameEma < 30 || renderer.getPixelRatio() <= 1) { slowSince = 0; return; }
  slowSince ||= now;
  if (now - slowSince > 2000) {
    const pr = Math.max(1, renderer.getPixelRatio() - 0.25);
    renderer.setPixelRatio(pr);
    composer.setPixelRatio?.(pr);
    composer.setSize(innerWidth, innerHeight);
    slowSince = 0;
    frameEma = 20;
  }
}

function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  if (document.visibilityState === 'visible' && now - last < 500 && !S.cinema) adaptQuality(now, now - last);
  last = now;
  let dtSim = 0;
  if (S.view !== 'galaxy') {
    if (S.rewinding) tickRewind(dt);
    else if (S.playing && !aim.active) {
      const target = settings.slowmo && !S.replay && !S.reel && !S.flight ? closeCallFactor() : 1; // these pace themselves
      S.slow += (target - S.slow) * (target < S.slow ? 0.5 : 0.04);
      const span = S.speed * dt * S.slow;
      sim.sampleDt = Math.min(0.05, Math.max(0.002, S.speed / 90));
      dtSim = advancePlay(span, MOBILE ? 350 : 700);
      S.dilated = dtSim < span * 0.8;
      if (S.replay) tickReplay(now);
      else if (S.reel) tickReel(dt);
      else { recordSnap(now); recordHist(now); tickFlight(dt, now); }
      if (S.mission && !S.mission.done && !S.replay && !S.reel && now - missionT > 100) {
        missionT = now;
        const r = S.mission.def.tick?.(game(), S.mission.data);
        if (r) missionResult(r);
      }
    } else { S.slow = 1; S.dilated = false; }
    views.showLabels = settings.labels && !S.cinema;
    views.update(toRender, camera, S.selected, dt, { h: renderer.domElement.clientHeight });
    views.declutter(camera, S.selected, { w: innerWidth, h: innerHeight });
    trails.visible = settings.trails;
    trails.update(toRender, trailOffset, trailSpan);
    const sun = sim.get('sun');
    ghosts.pinned = !!settings.origOrbits[S.view];
    ghosts.update(sun && toRender(sun, new THREE.Vector3()), (was, b) => orbitChange(was, orbitShape(b, sun)), dt);
    belt.update(settings.belt ? sim.belt : null, toRenderXYZ);
    const gal = frame() === 'galactic';
    const ref = refRender();
    dust.update(DRIFT_DIR.clone().multiplyScalar(settings.drift * sim.t), ref, gal);
    driftArrow.visible = gal;
    driftLabel.visible = gal;
    if (gal) {
      const s = camera.position.distanceTo(controls.target) * 0.12;
      driftArrow.position.copy(ref).addScaledVector(DRIFT_DIR, s * 0.4);
      driftArrow.setLength(s, s * 0.15, s * 0.07);
      driftLabel.position.set(0, 1.05, 0);
    }
    effects.update(dt, (id, out) => { const b = sim.get(id); if (!b) return false; toRender(b, out); return true; });
    aim.update(now / 1000);
    updateTracker(now / 1000);
    const camDist = camera.position.distanceTo(controls.target);
    grid.visible = settings.grid && !S.cinema;
    if (grid.visible) grid.update(sim.bodies, toRender, ref, Math.max(4, Math.min(80, camDist * 1.4)));
    updateHZ();
    const holes = settings.lensing ? sim.bodies.filter((b) => b.alive && b.kind === 'blackhole') : [];
    lens.update(holes, camera, sim, toRender, { w: innerWidth, h: innerHeight });
  } else {
    if (S.galaxyPlaying) {
      galaxy.update(dt, S.galaxySpeed);
      if (galaxy.t >= 0 && !S.reachedToday) { S.reachedToday = true; toast('🌍 Today. The Sun keeps going...'); }
    } else galaxy.update(0, 0);
    lens.enabled = false;
    grid.visible = false;
    driftArrow.visible = false;
    driftLabel.visible = false;
    dust.update(tmp, tmp, false);
    updateHZ();
  }
  updateCamera(dt, dtSim);
  applyViewShift(dt);
  audio.drone(S.view === 'galaxy' ? S.galaxySpeed / 12 : S.speed * S.slow, isPlaying() && !aim.active);
  if (now - teleT > 120) { teleT = now; renderTelemetry(); if (S.mission) renderMissionHud(); }
  if (now - infoT > 500 && S.selected) { infoT = now; renderInfo(); }
  bloom.enabled = settings.bloom || !!S.cinema;
  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frameLoop);
}


// ---------------------------------------------------------------- boot
installFastTap();
$('#btn-reset').innerHTML = icon('reset');
$('#btn-saved').insertAdjacentHTML('afterbegin', icon('bookmark'));
$('#btn-menu').innerHTML = icon('menu');
$('#btn-back').innerHTML = icon('rewind');
buildArsenal();
buildRail();
updateSound();
views.showLabels = settings.labels;
trails.visible = settings.trails;
bloom.enabled = settings.bloom;
document.body.dataset.view = 'solar';
document.body.classList.toggle('mobile', MOBILE);
freshUniverse();
setView('helix');
updateDock();

(async () => {
  const hash = location.hash.match(/#u=([\w-]+)/);
  if (hash) {
    try { applySave(await decodeShare(hash[1])); history.replaceState(null, '', location.pathname); return; }
    catch { toast('⚠ That share link looks broken. Here is a fresh solar system.'); }
  }
  const shot = location.hash.match(/#s=([\w-]+)/);
  if (shot) {
    history.replaceState(null, '', location.pathname);
    try { const rec = await decodeShot(shot[1]); playShot({ ...rec, shared: true }); return; }
    catch { toast('⚠ That shot link looks broken. Here is a fresh solar system.'); }
  }
  const auto = store.get('gm.autosave');
  if (auto?.sim?.bodies?.some((b) => b.spawned)) showResumePill(auto);
  offerTour();
})();

// generate the procedural textures behind the loading screen so the first frame doesn't hitch
await new Promise((r) => setTimeout(r, 30));
for (const b of sim.bodies) planetTexture(b.tex, b.color, b.kind);
earthNightTexture();
$('#loading').classList.add('done');
setTimeout(() => $('#loading').remove(), 600);
requestAnimationFrame(frameLoop);
