import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import './style.css';
import { Sim } from './physics.js';
import { SPAWNABLES, KMS_PER_AUYR, START_YEAR, PLANETS } from './data.js';
import { createRenderer, makeStarfield, BodyViews, Trails, Belt, SpaceDust, Effects } from './render.js';
import { GalaxyView } from './galaxy.js';
import { Aim } from './aim.js';
import { Audio } from './audio.js';
import { makeLensPass, makeGravityGrid } from './shaders.js';
import { MISSIONS, ACHIEVEMENTS, achievementsForEvent, describe, starsFor } from './missions.js';
import { buildSave, downloadJSON, readFile, encodeShare, decodeShare, store } from './save.js';
import { planetTexture, earthNightTexture } from './textures.js';
import { $, el, modal, closeModal, sheet, toast, fmtMass, fmtNum, installFastTap } from './ui.js';

const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const DRIFT_DIR = new THREE.Vector3(0.5, Math.sqrt(3) / 2, 0); // ~60° to the ecliptic, like the real Sun
const REAL_DRIFT = 230 / KMS_PER_AUYR; // AU/yr

// ---------------------------------------------------------------- state
const settings = Object.assign({
  frame: 'helio', // solar view: 'helio' (Sun-centred) or 'bary' (inertial)
  drift: 4, // AU/yr, stylised galactic drift for the helix view
  trailLength: 0.6,
  belt: true,
  slowmo: true,
  lensing: true,
  bloom: true,
  labels: true,
  trails: true,
  grid: true,
  hz: false,
  scale: 'visible',
}, migrateSettings(store.get('sss.settings', {})));
// v2 flipped the defaults: gravity wells on, habitable zone off
function migrateSettings(saved) {
  if ((saved.v || 1) < 2) { delete saved.grid; delete saved.hz; }
  saved.v = 2;
  return saved;
}
const saveSettings = () => store.set('sss.settings', settings);

const S = {
  view: 'solar', // switched to 'helix' at boot
  playing: true,
  speed: 0.25, // sim years per real second
  galaxySpeed: 12, // Myr per real second
  galaxyPlaying: true,
  selected: null,
  slow: 1,
  shake: 0,
  shots: 0,
  lastShot: null,
  mission: null,
  achievements: new Set(store.get('gm.achievements', [])),
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
const belt = new Belt(scene);
const dust = new SpaceDust(scene);
const effects = new Effects(scene, { maxParticles: MOBILE ? 320 : 700 });
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
const frame = () => (S.view === 'helix' ? 'galactic' : settings.frame);
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
  saved: {},
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
  const sunNow = sim.get('sun');
  const jup = sim.get('jupiter');
  b.launch = {
    speed: shot.speed,
    sunDist: sunNow ? Math.hypot(b.x - sunNow.x, b.y - sunNow.y, b.z - sunNow.z) : 99,
    dist: { jupiter: jup ? Math.hypot(b.x - jup.x, b.y - jup.y, b.z - jup.z) : 99 },
  };
  S.lastShot = { before, missionData, shot, shots: S.shots };
  S.shots++;
  if (S.mission) S.mission.shots++;
  audio.launch(Math.min(1, shot.speed / 200));
  unlock('first_shot');
  if (shot.speed > 500) unlock('speed_demon');
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  setPlaying(true);
  updateDock();
  log({ kind: 'launch', t: sim.t, name: spec.name, speed: shot.speed, host: st.host?.name });
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
  views.clear();
  trails.reset();
  sim.initSolarSystem({ belt: 0 });
  sim.sampleDt = 0.01;
  sim.nextSample = 0;
  const years = (Date.now() - J2000) / (365.25 * 864e5);
  sim.advance(years, 1e9);
  sim.events.length = 0;
  sim.initBelt(settings.belt ? (MOBILE ? 500 : 900) : 0);
  rig.lastFocus = null;
  S.lastShot = null;
  S.shots = 0;
  S.selected = null;
  log.clear();
  sim.checkStatus(sim.alive());
  renderInfo();
}

function resetVisuals() {
  views.clear();
  trails.reset();
  sim.nextSample = sim.t;
  rig.lastFocus = null;
  renderInfo();
}

function loadSim(data, { keepMission = false } = {}) {
  if (!keepMission) endMission(true);
  sim.load(data);
  if (!settings.belt && sim.belt) sim.initBelt(0);
  resetVisuals();
  S.selected = null;
  sim.checkStatus(sim.alive());
}

// ---------------------------------------------------------------- events
sim.on((ev) => {
  const d = describe(ev);
  if (ev.kind !== 'spawn') log(ev);
  for (const a of achievementsForEvent(ev, sim)) unlock(a);
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
  if (ev.kind === 'climate' || ev.kind === 'escape' || ev.kind === 'moon' || ev.kind === 'capture') toast(`${d.icon} ${d.text}`);
  if (S.mission) {
    const r = S.mission.def.onEvent?.(ev, game(), S.mission.data);
    if (r) missionResult(r);
  }
});

const chronicle = [];
function log(ev) {
  const d = ev.kind === 'launch'
    ? { icon: '🎱', text: `${ev.name} launched at ${ev.speed.toFixed(1)} km/s${ev.host ? ` (rel. ${ev.host})` : ''}` }
    : describe(ev);
  const item = { t: ev.t ?? sim.t, ...d, at: performance.now() };
  chronicle.push(item);
  if (chronicle.length > 300) chronicle.shift();
  renderTicker();
}
log.clear = () => { chronicle.length = 0; renderTicker(); };

function renderTicker() {
  const box = $('#ticker');
  const recent = chronicle.slice(-3);
  box.innerHTML = recent.map((c) => `<div class="tick" data-at="${c.at}"><span class="ts">${stamp(c.t)}</span> ${c.icon} ${c.text}</div>`).join('');
}
const stamp = (t) => `T+${t < 1 ? `${(t * 365.25).toFixed(0)}d` : `${t.toFixed(t < 100 ? 2 : 0)}y`}`;

function unlock(id) {
  if (S.achievements.has(id)) return;
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) return;
  S.achievements.add(id);
  store.set('gm.achievements', [...S.achievements]);
  toast(`<span class="ach">${a.icon}</span> <b>${a.title}</b> · ${a.desc}`, 'achievement');
  audio.chime();
}

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
    if (MISSIONS.every((x) => S.missionStars[x.id])) unlock('all_missions');
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
  chronicle.push({ t: sim.t, icon: '✕', text: `${b.name} was removed`, at: performance.now() });
  renderTicker();
  select(null);
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
function setView(v) {
  if (v === S.view) return;
  const prev = S.view;
  // remember camera framing per view
  rig.saved[prev] = { off: camera.position.clone().sub(controls.target), mode: rig.mode };
  if (aim.active && v === 'galaxy') aim.cancel();
  S.view = v;
  const solar = v !== 'galaxy';
  views.group.visible = trails.group.visible = solar;
  views.group.traverse((o) => { if (o.isCSS2DObject) o.visible = solar; });
  if (belt.points) belt.points.visible = solar;
  galaxy.setVisible(!solar);
  rig.lastFocus = null;
  const saved = rig.saved[v];
  if (v === 'galaxy') {
    rig.mode = 'system';
    const f = galaxy.focus.clone();
    controls.target.copy(f);
    camera.position.copy(f).add(saved?.off || new THREE.Vector3(-30, 45, 70));
    controls.maxDistance = 2000;
  } else {
    controls.maxDistance = 20000;
    if (prev === 'galaxy') {
      const f = refRender();
      controls.target.copy(f);
      camera.position.copy(f).add(saved?.off || new THREE.Vector3(0, 18, 34));
    }
    if (v === 'helix' && !saved) rig.offsetGoal = new THREE.Vector3(-9, 2.5, 7);
    if (saved) rig.mode = saved.mode === 'ride' ? 'system' : saved.mode;
  }
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
  $('#speed-label').textContent = speedText();
  $('#btn-rewind').disabled = !S.lastShot || S.view === 'galaxy';
  $('#btn-reset').disabled = S.view === 'galaxy';
}

$('#btn-play').onclick = () => { audio.ensure(); if (aim.active) aim.cancel(); setPlaying(!isPlaying()); };
$('#btn-rewind').onclick = () => resetToShot();
$('#btn-reset').onclick = () => resetFlow();
$('#speed').oninput = (e) => {
  const v = speedFromSlider(+e.target.value);
  if (S.view === 'galaxy') S.galaxySpeed = v; else S.speed = v;
  $('#speed-label').textContent = speedText();
};

// ---------------------------------------------------------------- arsenal & aim bar
function buildArsenal() {
  const box = $('#arsenal');
  box.innerHTML = '';
  for (const s of SPAWNABLES) {
    const c = el('button', 'chip', `<span class="ic">${s.icon}</span><span class="nm">${s.name}</span><span class="ms">${fmtMass(s.mass, true)}</span>`);
    c.dataset.type = s.type;
    c.title = s.blurb;
    c.onclick = () => (aim.active && aim.spec?.type === s.type ? (aim.cancel(), c.classList.remove('active')) : startAim(s.type));
    box.appendChild(c);
  }
}

const STEPS = [['place', 'Place'], ['heading', 'Aim'], ['speed', 'Speed']];
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
      <div class="aim-msg">Drag the <b>ring</b> to point it. Drag its <b>centre</b> to move it, or tap somewhere else.</div>
      <label class="tilt">Tilt <input type="range" min="-80" max="80" step="1" id="tilt" aria-label="Tilt above or below the planets' plane"><output id="tilt-val"></output></label>
      <div class="aim-live"></div>`;
    if (h.mode === 'speed') body = `
      <div class="speed-row"><input type="range" min="0" max="1" step="0.001" id="aim-speed" aria-label="Launch speed"><div class="aim-live"></div></div>
      <div class="presets">
        <button data-p="orbit">Circular orbit</button><button data-p="escape">Escape speed</button><button data-p="drop">Stop dead</button>
      </div>`;
    const back = h.mode === 'place' ? 'Cancel' : 'Back';
    const next = h.mode === 'heading' ? 'Next: speed →' : h.mode === 'speed' ? '🚀 Launch' : '';
    bar.innerHTML = `<div class="wiz-steps">${steps}</div>${body}
      <div class="aim-actions"><button data-a="back">${back}</button>${next ? `<button data-a="next" class="primary">${next}</button>` : ''}</div>`;
    // a step change swallows taps for a moment so a repeated tap can't skip straight to Launch
    const guarded = (fn) => () => { const n = performance.now(); if (n - (S.stepAt || 0) < 350) return; S.stepAt = n; fn(); };
    bar.querySelector('[data-a=back]').onclick = guarded(() => aim.back());
    const nx = bar.querySelector('[data-a=next]');
    if (nx) nx.onclick = guarded(() => aim.next());
    const tilt = bar.querySelector('#tilt');
    if (tilt) tilt.oninput = (e) => aim.setElevation(+e.target.value);
    const sp = bar.querySelector('#aim-speed');
    if (sp) sp.oninput = (e) => aim.setSpeed(Aim.toSpeed(+e.target.value));
    bar.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => aim.presetSpeed(b.dataset.p); });
  }
  // live values, without rebuilding controls under the user's finger
  const tilt = bar.querySelector('#tilt');
  if (tilt && document.activeElement !== tilt) tilt.value = h.elev.toFixed(0);
  const tv = bar.querySelector('#tilt-val');
  if (tv) tv.textContent = `${h.elev.toFixed(0)}°`;
  const sp = bar.querySelector('#aim-speed');
  if (sp && document.activeElement !== sp) sp.value = Aim.fromSpeed(h.speed);
  const live = bar.querySelector('.aim-live');
  if (live) {
    const hit = h.hit ? `<span class="bad">⚠ Hits ${h.hit} in ${h.hitIn < 1 ? `${(h.hitIn * 12).toFixed(1)} months` : `${h.hitIn.toFixed(1)} yr`}</span>` : '<span class="muted">No impact predicted</span>';
    live.innerHTML = h.mode === 'speed'
      ? `<b class="mono">${h.speed.toFixed(1)} km/s</b> <span class="muted">relative to ${h.host}</span><br>${hit}`
      : `${hit}`;
  }
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
  const c = $('#rail [data-id=center] .cn');
  if (c) c.innerHTML = `<small>${rig.mode === 'ride' ? 'Riding' : 'Centred on'}</small>◎ ${centerName()} ▾`;
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
  g.addColorStop(0, 'rgba(80,230,140,0.55)');
  g.addColorStop(0.04, 'rgba(80,230,140,0.12)');
  g.addColorStop(0.5, 'rgba(80,230,140,0.17)');
  g.addColorStop(0.96, 'rgba(80,230,140,0.12)');
  g.addColorStop(1, 'rgba(80,230,140,0.55)');
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
        const el2 = el('div', 'label hz-label', '<b>Habitable zone</b><small>liquid water possible</small>');
        const lab = new CSS2DObject(el2);
        lab.position.set(0, -r1, 0); // ring is rotated, so local -y is "in front"
        lab.center.set(0.5, 0);
        m.add(lab);
        hzGroup.add(m);
      }
      toRender(s, m.position);
    }
  }
  for (const c of [...hzGroup.children]) {
    if (!want.has(c.name)) { c.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); }); c.removeFromParent(); c.geometry.dispose(); }
  }
}

// ---------------------------------------------------------------- radar
const radar = $('#radar');
const rctx = radar.getContext('2d');
function drawRadar() {
  const dpr = Math.min(devicePixelRatio, 2);
  const size = radar.clientWidth;
  if (radar.width !== size * dpr) { radar.width = radar.height = size * dpr; }
  const W = radar.width, c = W / 2;
  rctx.clearRect(0, 0, W, W);
  if (S.view === 'galaxy') return;
  const scale = (r) => (Math.log1p(r * 3) / Math.log1p(55 * 3)) * (c - 4 * dpr);
  rctx.strokeStyle = 'rgba(120,170,255,0.18)';
  rctx.lineWidth = dpr;
  for (const r of [1, 5.2, 30]) { rctx.beginPath(); rctx.arc(c, c, scale(r), 0, Math.PI * 2); rctx.stroke(); }
  // camera heading wedge
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const ang = Math.atan2(dir.z, dir.x);
  rctx.fillStyle = 'rgba(120,200,255,0.08)';
  rctx.beginPath(); rctx.moveTo(c, c); rctx.arc(c, c, c, ang - 0.4, ang + 0.4); rctx.fill();
  const ref = refBody();
  if (!ref) return;
  for (const b of sim.bodies) {
    if (!b.alive) continue;
    const dx = b.x - ref.x, dz = b.z - ref.z;
    const r = Math.hypot(dx, dz);
    const rr = Math.min(scale(r), c - 3 * dpr);
    const x = c + (r > 0 ? (dx / r) * rr : 0), y = c + (r > 0 ? (dz / r) * rr : 0);
    const sz = (b.kind === 'star' || b.kind === 'blackhole' ? 3.2 : b.spawned ? 2.6 : 2) * dpr;
    rctx.fillStyle = b.kind === 'blackhole' ? '#ff9a4a' : b.color;
    rctx.beginPath(); rctx.arc(x, y, sz, 0, Math.PI * 2); rctx.fill();
    if (b.id === S.selected || b.spawned) { rctx.strokeStyle = b.id === S.selected ? '#fff' : 'rgba(255,255,255,0.5)'; rctx.beginPath(); rctx.arc(x, y, sz + 2 * dpr, 0, Math.PI * 2); rctx.stroke(); }
  }
}
radar.onclick = () => radar.classList.toggle('big');

// ---------------------------------------------------------------- telemetry
function stabilityInfo() {
  const s = sim.stability ?? 100;
  const [label, cls] = s > 95 ? ['NOMINAL', 'good'] : s > 75 ? ['PERTURBED', 'warn'] : s > 40 ? ['UNSTABLE', 'bad'] : ['CHAOTIC COLLAPSE', 'bad pulse'];
  return { s, label, cls };
}
function renderTelemetry() {
  const box = $('#telemetry');
  if (S.view === 'galaxy') {
    box.innerHTML = `<div><span>EPOCH</span><b>${galaxy.timeLabel()}</b></div><div><span>ORBIT</span><b>${((galaxy.t + 540) / 230).toFixed(2)} galactic yr</b></div><div class="muted small">Vertical bobbing ×3 for visibility</div>`;
    return;
  }
  const st = stabilityInfo();
  const year = START_YEAR + sim.t;
  const es = earthStatus();
  const dil = S.slow < 0.95 ? '<i class="badge">SLOW-MO</i>' : S.dilated ? '<i class="badge warn">BUSY</i>' : '';
  if (!box.querySelector('#earth-pill')) {
    box.innerHTML = `
      <div><span>YEAR</span><b class="t-year"></b><i class="t-badge"></i></div>
      <div><span>STABILITY</span><b class="t-stab"></b></div>
      <button class="earth-pill" id="earth-pill" aria-label="Earth status, tap to center on Earth"><span class="globe">🌍</span><span><b>Earth</b> <span class="t-earth"></span></span></button>`;
    box.querySelector('#earth-pill').onclick = () => { if (sim.get('earth')) centerOn('earth'); };
  }
  const set = (sel, txt) => { const n = box.querySelector(sel); if (n.textContent !== txt) n.textContent = txt; };
  set('.t-year', year.toFixed(2));
  set('.t-stab', `${st.s.toFixed(0)}% ${st.label}`);
  box.querySelector('.t-stab').className = `t-stab ${st.cls}`;
  set('.t-earth', es.text);
  box.querySelector('#earth-pill').className = `earth-pill ${es.cls}`;
  const badge = box.querySelector('.t-badge');
  set('.t-badge', dil ? (S.slow < 0.95 ? 'SLOW-MO' : 'BUSY') : '');
  badge.className = `t-badge ${dil ? (S.slow < 0.95 ? 'badge' : 'badge warn') : ''}`;
  // live status on Earth's label
  const earth = sim.get('earth');
  if (earth) {
    if (earth.tagline !== es.short) { earth.tagline = es.short; earth._dirty = true; }
    if (S.lastZone && S.lastZone !== es.zone && sim.t > 0) toast(es.zone === 'ok' ? '🌍 Earth is back in the habitable zone' : `🌍 Earth has left the habitable zone: ${es.text}`);
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
  const fresh = () => { closeModal(); endMission(true); freshUniverse(); fitDefault(); setPlaying(true); };
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

async function share(save = buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift })) {
  const code = await encodeShare(save);
  const url = `${location.origin}${location.pathname}#u=${code}`;
  try { await navigator.clipboard.writeText(url); toast('Share link copied. Anyone who opens it gets this exact universe.'); }
  catch { prompt('Copy this link:', url); }
  if (navigator.share && MOBILE) navigator.share({ title: 'My solar system experiment', url }).catch(() => {});
  unlock('sharer');
}

function applySave(data) {
  loadSim(data.sim);
  if (data.settings?.speed) S.speed = data.settings.speed;
  if (data.settings?.drift) settings.drift = data.settings.drift;
  if (data.settings?.frame) settings.frame = data.settings.frame;
  if (data.settings?.view && data.settings.view !== 'galaxy') setView(data.settings.view);
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
  if (S.view === 'galaxy' || S.mission || !sim.bodies.some((b) => b.spawned)) return;
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

function openTrophies() {
  sheet(`Achievements · ${S.achievements.size}/${ACHIEVEMENTS.length}`, `<div class="trophies">${ACHIEVEMENTS.map((a) => `<div class="trophy ${S.achievements.has(a.id) ? 'got' : ''}"><span>${S.achievements.has(a.id) ? a.icon : '🔒'}</span><b>${a.title}</b><small>${a.desc}</small></div>`).join('')}</div>`);
}

function openMenu() {
  sheet('Menu', `
    <div class="menu-grid">
      <button data-m="save">⬇ Save .json</button>
      <button data-m="load">⬆ Load .json</button>
      <button data-m="share">🔗 Copy share link</button>
      <button data-m="new">↺ Reset</button>
      <button data-m="log">📜 Event log</button>
      <button data-m="ach">🏆 Achievements · ${S.achievements.size}/${ACHIEVEMENTS.length}</button>
      <button data-m="help">❔ How it works</button>
    </div>
    <h4>Advanced settings</h4>
    <label class="row">Solar view frame
      <select id="set-frame"><option value="helio">Sun-centred</option><option value="bary">Inertial (barycentre)</option></select></label>
    <label class="row">Helix drift speed <span id="drift-val"></span>
      <input type="range" id="set-drift" min="0" max="1" step="0.001"></label>
    <label class="row">Contrail length <input type="range" id="set-trail" min="0.05" max="1" step="0.01"></label>
    <label class="row check"><input type="checkbox" id="set-belt"> Asteroid belt</label>
    <label class="row check"><input type="checkbox" id="set-slowmo"> Auto slow-mo on close calls</label>
    <label class="row check"><input type="checkbox" id="set-lens"> Gravitational lensing</label>
    <label class="row check"><input type="checkbox" id="set-bloom"> Glow (bloom)</label>
  `, (box) => {
    box.querySelector('[data-m=save]').onclick = () => { downloadJSON(buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift }), `universe-${Math.round(START_YEAR + sim.t)}.json`); toast('Saved.'); };
    box.querySelector('[data-m=load]').onclick = loadFromFile;
    box.querySelector('[data-m=share]').onclick = () => share();
    box.querySelector('[data-m=new]').onclick = () => { closeModal(); resetFlow(); };
    box.querySelector('[data-m=log]').onclick = openChronicle;
    box.querySelector('[data-m=help]').onclick = openHelp;
    box.querySelector('[data-m=ach]').onclick = openTrophies;
    const fr = box.querySelector('#set-frame');
    fr.value = settings.frame;
    fr.onchange = () => { settings.frame = fr.value; saveSettings(); rig.lastFocus = null; };
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
    chk('#set-slowmo', 'slowmo');
    chk('#set-lens', 'lensing');
    chk('#set-bloom', 'bloom', () => { bloom.enabled = settings.bloom; });
  });
}

function openChronicle() {
  sheet('Event log', chronicle.length ? `<div class="chronicle">${[...chronicle].reverse().map((c) => `<div><span class="ts">${stamp(c.t)}</span> ${c.icon} ${c.text}</div>`).join('')}</div>` : '<p class="muted">Nothing has happened yet. Launch something!</p>');
}

function openHelp() {
  modal({
    title: 'How it works',
    body: `
      <h4>Launch something</h4>
      <ol class="howto">
        <li><b>Pick</b> an object from the bar at the bottom.</li>
        <li><b>Place</b> it: tap exactly where it should start.</li>
        <li><b>Aim</b>: drag the ring around it to point it. The dotted line shows where it will go.</li>
        <li><b>Speed</b>: use the slider or a preset, then Launch. <b>Undo</b> takes you back to the moment before, with the same aim.</li>
      </ol>
      <h4>Look around</h4>
      <p>${MOBILE ? 'One finger orbits, pinch zooms, two fingers pan.' : 'Drag to orbit, scroll to zoom, right-drag to pan.'} Use <b>Centred on ▾</b> (right side) to follow Earth or anything else. Tapping a planet also offers “Center on”.</p>
      <h4>Views</h4>
      <p><b>Helix</b>: the solar system flies through the galaxy, so orbits trace corkscrews. <b>Solar</b>: the Sun stays still and orbits are ellipses. <b>Milky Way</b>: the Sun's 230-million-year lap around the galaxy.</p>
      <h4>Earth</h4>
      <p>The green band is the habitable zone. The Earth badge at the top left shows its temperature and whether it is still in the zone.</p>
      ${MOBILE ? '' : `<h4>Keyboard</h4>
      <div class="keys">
        <span><kbd>Space</kbd> play / pause</span><span><kbd>[</kbd> <kbd>]</kbd> speed</span><span><kbd>R</kbd> undo launch</span>
        <span><kbd>F</kbd> fit</span><span><kbd>0</kbd>–<kbd>9</kbd> center on Sun / planets</span><span><kbd>V</kbd> next view</span>
        <span><kbd>H</kbd> habitable zone</span><span><kbd>G</kbd> gravity wells</span><span><kbd>L</kbd> labels</span>
        <span><kbd>←</kbd> <kbd>→</kbd> turn aim</span><span><kbd>↑</kbd> <kbd>↓</kbd> speed</span><span><kbd>Enter</kbd> next / launch</span>
      </div>`}
      <p class="muted small">Physics: real masses, planets placed at today's positions from JPL orbital elements, N-body gravity with an adaptive leapfrog integrator. Sizes are exaggerated so you can see them (switch to true scale in Layers); distances and masses are real.</p>`,
    actions: [{ label: 'Got it', primary: true, onClick: closeModal }],
  });
}

function onboarding() {
  if (store.get('sss.onboarded')) return;
  const steps = [
    { t: 'Our solar system, right now', b: 'Every planet is where it really is today, moving under real gravity. The Sun drags them through the galaxy, so their paths trace a helix.' },
    { t: 'Launch something', b: 'Pick an object from the bar at the bottom. Then follow three steps: place it, aim it, set its speed.' },
    { t: 'Keep an eye on Earth', b: 'The green band is the habitable zone. The Earth badge tells you if it is still livable.' },
  ];
  let i = 0;
  const show = () => modal({
    title: steps[i].t,
    body: `<p>${steps[i].b}</p><div class="dots">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>`,
    actions: [
      { label: i < steps.length - 1 ? 'Next' : 'Start exploring', primary: true, onClick: () => { if (++i < steps.length) show(); else { closeModal(); store.set('sss.onboarded', true); } } },
      { label: 'Skip', onClick: () => { closeModal(); store.set('sss.onboarded', true); } },
    ],
  });
  show();
}

$('#btn-missions').onclick = openMissions;
$('#btn-menu').onclick = openMenu;
$('#btn-sound').onclick = () => { audio.ensure(); audio.setMuted(!audio.muted); updateSound(); };
function updateSound() { $('#btn-sound').textContent = audio.muted ? '🔇' : '🔊'; $('#btn-sound').setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute'); }
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
  if (document.visibilityState === 'visible' && now - last < 500) adaptQuality(now, now - last);
  last = now;
  let dtSim = 0;
  if (S.view !== 'galaxy') {
    if (S.playing && !aim.active) {
      const target = settings.slowmo ? closeCallFactor() : 1;
      S.slow += (target - S.slow) * (target < S.slow ? 0.5 : 0.04);
      const span = S.speed * dt * S.slow;
      sim.sampleDt = Math.min(0.05, Math.max(0.002, S.speed / 90));
      dtSim = sim.advance(span, MOBILE ? 350 : 700);
      S.dilated = dtSim < span * 0.8;
      if (sim.t > 1000) unlock('time_lord');
      if (S.mission && !S.mission.done && now - missionT > 100) {
        missionT = now;
        const r = S.mission.def.tick?.(game(), S.mission.data);
        if (r) missionResult(r);
      }
    } else { S.slow = 1; S.dilated = false; }
    views.showLabels = settings.labels;
    views.update(toRender, camera, S.selected, dt, { h: renderer.domElement.clientHeight });
    views.declutter(camera, S.selected, { w: innerWidth, h: innerHeight });
    trails.visible = settings.trails;
    trails.update(toRender, trailOffset);
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
    const camDist = camera.position.distanceTo(controls.target);
    grid.visible = settings.grid;
    if (settings.grid) grid.update(sim.bodies, toRender, ref, Math.max(4, Math.min(80, camDist * 1.4)));
    updateHZ();
    const holes = settings.lensing ? sim.bodies.filter((b) => b.alive && b.kind === 'blackhole') : [];
    lens.update(holes, camera, sim, toRender, { w: innerWidth, h: innerHeight });
  } else {
    if (S.galaxyPlaying) {
      galaxy.update(dt, S.galaxySpeed);
      if (galaxy.t >= 0 && !S.reachedToday) { S.reachedToday = true; unlock('tourist'); toast('🌍 Today. The Sun keeps going...'); }
    } else galaxy.update(0, 0);
    lens.enabled = false;
    grid.visible = false;
    driftArrow.visible = false;
    driftLabel.visible = false;
    dust.update(tmp, tmp, false);
    updateHZ();
  }
  updateCamera(dt, dtSim);
  audio.drone(S.view === 'galaxy' ? S.galaxySpeed / 12 : S.speed * S.slow, isPlaying() && !aim.active);
  if (now - teleT > 120) { teleT = now; renderTelemetry(); drawRadar(); if (S.mission) renderMissionHud(); fadeTicker(now); }
  if (now - infoT > 500 && S.selected) { infoT = now; renderInfo(); }
  bloom.enabled = settings.bloom;
  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frameLoop);
}

function fadeTicker(now) {
  document.querySelectorAll('#ticker .tick').forEach((t) => { t.classList.toggle('old', now - +t.dataset.at > 9000); });
}

// ---------------------------------------------------------------- boot
installFastTap();
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
{
  const f = refRender();
  controls.target.copy(f);
  camera.position.copy(f).add(new THREE.Vector3(-9, 3.2, 7).multiplyScalar(MOBILE && innerWidth < innerHeight ? 1.5 : 1));
  rig.offsetGoal = null;
}
updateDock();

(async () => {
  const hash = location.hash.match(/#u=([\w-]+)/);
  if (hash) {
    try { applySave(await decodeShare(hash[1])); history.replaceState(null, '', location.pathname); return; }
    catch { toast('⚠ That share link looks broken. Here is a fresh solar system.'); }
  }
  const auto = store.get('gm.autosave');
  if (auto?.sim?.bodies?.some((b) => b.spawned)) {
    toast(`Resume your last run from year ${(START_YEAR + auto.sim.t).toFixed(1)}? <button class="link" id="resume">Resume</button>`, 'sticky');
    const b = document.getElementById('resume');
    if (b) b.onclick = () => { try { applySave(auto); } catch {} b.closest('.toast')?.remove(); };
  }
  onboarding();
})();

// generate the procedural textures behind the loading screen so the first frame doesn't hitch
await new Promise((r) => setTimeout(r, 30));
for (const b of sim.bodies) planetTexture(b.tex, b.color, b.kind);
earthNightTexture();
$('#loading').classList.add('done');
setTimeout(() => $('#loading').remove(), 600);
requestAnimationFrame(frameLoop);
