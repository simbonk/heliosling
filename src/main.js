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
import { $, el, modal, closeModal, sheet, toast, fmtMass, fmtNum } from './ui.js';

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
  grid: false,
  hz: false,
  scale: 'visible',
}, store.get('gm.settings', {}));
const saveSettings = () => store.set('gm.settings', settings);

const S = {
  view: 'solar',
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
const effects = new Effects(scene);
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
  if (S.view === 'galaxy') setView('solar');
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
  if (!S.lastShot) return toast('Nothing to rewind yet. Launch something first.');
  const { before, missionData, shot, shots } = S.lastShot;
  loadSim(before, { keepMission: true });
  if (S.mission && missionData) S.mission.data = missionData;
  S.shots = shots;
  setPlaying(false);
  S.wasPlaying = true;
  aim.arm(shot);
  toast('Rewound to your last shot. Nudge it and fire again.');
}

// ---------------------------------------------------------------- universe lifecycle
function freshUniverse() {
  sim.initSolarSystem({ belt: settings.belt ? (MOBILE ? 500 : 900) : 0 });
  resetVisuals();
  S.lastShot = null;
  S.shots = 0;
  S.selected = null;
  log.clear();
  sim.checkStatus(sim.alive());
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
      const size = Math.max(sim.radius(big) * 1.5, dist * 0.012);
      effects.impact(p, ev.aKind === 'blackhole' ? '#ffa04a' : '#ffd8a0', size, big.id);
      const near = dist < camera.position.distanceTo(controls.target) * 3;
      if (near) S.shake = Math.min(1.5, S.shake + 0.6 + ev.ratio);
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
  $('#btn-trophy').dataset.count = S.achievements.size;
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
    body: `<p>${def.desc}</p><p class="tip">💡 ${def.tip}</p><p class="muted">Fewer shots earn more stars. ⏮ rewinds to your last shot.</p>`,
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
      body: `<div class="stars">${'★'.repeat(stars)}<span>${'★'.repeat(3 - stars)}</span></div><p><b>${def.title}</b> in ${m.shots} shot${m.shots === 1 ? '' : 's'}.</p>${stars < 3 ? '<p class="muted">Do it in one shot for three stars.</p>' : ''}`,
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
        ...(S.lastShot ? [{ label: '⏮ Rewind to last shot', primary: true, onClick: () => { closeModal(); m.done = false; resetToShot(); } }] : []),
        { label: 'Restart mission', primary: !S.lastShot, onClick: () => startMission(def) },
        { label: 'Quit to sandbox', onClick: () => { closeModal(); endMission(); } },
      ],
    });
  }
}

function renderMissionHud() {
  const m = S.mission;
  if (!m) return;
  $('#mission-hud').innerHTML = `<div class="mh-title">🎯 ${m.def.title}</div><div class="mh-status">${m.def.status?.(game(), m.data) || ''}</div><div class="mh-shots">Shots ${m.shots}</div><button class="mh-quit" aria-label="Quit mission">✕</button>`;
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
  if (b) { select(b.id); setCamMode('follow'); }
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
  box.innerHTML = `
    <div class="info-head"><span class="dot" style="background:${b.kind === 'blackhole' ? '#ff9a4a' : b.color}"></span><div><h3>${b.name}</h3><small>${b.tagline || b.kind}</small></div><button class="x" aria-label="Close">✕</button></div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="info-actions">
      <button data-a="follow" class="${rig.mode === 'follow' ? 'on' : ''}">🎯 Follow</button>
      <button data-a="ride" class="${rig.mode === 'ride' ? 'on' : ''}">🚀 Ride along</button>
      <button data-a="smite" class="danger">⚡ Smite</button>
    </div>`;
  box.querySelector('.x').onclick = () => select(null);
  box.querySelector('[data-a=follow]').onclick = () => setCamMode(rig.mode === 'follow' ? 'system' : 'follow');
  box.querySelector('[data-a=ride]').onclick = () => setCamMode(rig.mode === 'ride' ? 'system' : 'ride');
  box.querySelector('[data-a=smite]').onclick = () => smite(b);
}

function smite(b) {
  const p = toRender(b, new THREE.Vector3());
  effects.impact(p, '#9fd0ff', Math.max(sim.radius(b) * 2, camera.position.distanceTo(p) * 0.015));
  audio.thud(0.8);
  b.alive = false;
  sim._accReady = false;
  log({ kind: 'smite', t: sim.t, icon: '⚡', text: `${b.name} was smitten from existence` });
  chronicle[chronicle.length - 1] = { t: sim.t, icon: '⚡', text: `${b.name} was smitten from existence`, at: performance.now() };
  renderTicker();
  select(null);
}

function earthStatus() {
  const c = sim.climate;
  if (!c) return { text: 'Gone', html: '<span class="bad">Gone</span>' };
  const T = c.T;
  const label = c.state === 'boiled' ? 'Oceans boiled' : c.state === 'frozen' ? 'Snowball' : T > 60 ? 'Scorching' : T > 35 ? 'Hot' : T < -40 ? 'Freezing' : T < 0 ? 'Cold' : 'Habitable';
  const cls = label === 'Habitable' ? 'good' : label === 'Hot' || label === 'Cold' ? 'warn' : 'bad';
  return { text: `${T.toFixed(0)}°C · ${label}`, html: `<span class="${cls}">${T.toFixed(0)} °C · ${label}</span>`, cls };
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
  $('#btn-stop').disabled = S.view === 'galaxy';
}

$('#btn-play').onclick = () => { audio.ensure(); if (aim.active) aim.cancel(); setPlaying(!isPlaying()); };
$('#btn-rewind').onclick = () => resetToShot();
$('#btn-stop').onclick = () => stopFlow();
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

function renderAimBar() {
  const h = aim.hud();
  const bar = $('#aimbar');
  document.body.classList.toggle('aiming', !!h);
  if (!h) {
    bar.hidden = true;
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    // cancelling an aim resumes time if it was running before
    if (S.wasPlaying && !S.playing && !S.mission?.done) setPlaying(true);
    S.wasPlaying = false;
    return;
  }
  bar.hidden = false;
  const s = h.spec;
  let msg;
  if (h.mode === 'place') msg = `<b>${s.icon} ${s.name}</b> Tap empty space to place it`;
  else if (h.mode === 'placed') msg = `<b>${s.icon} ${s.name}</b> Drag back from it to aim · tap it to drop into orbit`;
  else msg = `<b class="mono">${h.speed.toFixed(1)} km/s</b> rel. ${h.host} · tilt ${h.elev.toFixed(0)}°${h.hit ? ` · <span class="bad">hits ${h.hit}</span>` : ''}`;
  const armed = h.mode === 'armed' || h.mode === 'drag';
  bar.innerHTML = `
    <div class="aim-msg">${msg}</div>
    ${armed ? `<div class="aim-ctrls">
      <button data-n="turn:3" aria-label="Rotate left">⟲</button><button data-n="turn:-3" aria-label="Rotate right">⟳</button>
      <button data-n="speed:-0.05" aria-label="Less power">−</button><button data-n="speed:0.05" aria-label="More power">+</button>
      <label class="tilt">Tilt <input type="range" min="-80" max="80" step="1" value="${h.elev.toFixed(0)}" id="tilt"></label>
    </div>` : ''}
    <div class="aim-actions">
      ${h.mode === 'placed' ? '<button data-a="orbit">◎ Orbit</button>' : ''}
      ${armed ? '<button data-a="fire" class="primary">Fire</button>' : ''}
      <button data-a="cancel">Cancel</button>
    </div>`;
  bar.querySelectorAll('[data-n]').forEach((b) => {
    b.onclick = () => { const [k, v] = b.dataset.n.split(':'); aim.nudge(k, +v); };
  });
  const tilt = bar.querySelector('#tilt');
  if (tilt) tilt.oninput = (e) => aim.setElevation(+e.target.value);
  bar.querySelector('[data-a=cancel]').onclick = () => aim.cancel();
  const orbit = bar.querySelector('[data-a=orbit]');
  if (orbit) orbit.onclick = () => aim.orbitDrop();
  const fire = bar.querySelector('[data-a=fire]');
  if (fire) fire.onclick = () => aim.fire();
}
// keep the aim bar from re-rendering under the user's finger while sliding
let aimBarPending = false;
const _renderAimBar = renderAimBar;
function throttledAimBar() {
  if (document.activeElement?.id === 'tilt') return;
  if (aimBarPending) return;
  aimBarPending = true;
  requestAnimationFrame(() => { aimBarPending = false; _renderAimBar(); });
}
aim.app.onAimChange = throttledAimBar;

// ---------------------------------------------------------------- right rail
const RAIL = [
  { id: 'system', icon: '☉', label: 'Centre on system', act: () => setCamMode('system'), on: () => rig.mode === 'system' },
  { id: 'top', icon: '⊤', label: 'Top-down view', act: () => setCamMode('top'), on: () => rig.mode === 'top' },
  { id: 'fit', icon: '⤢', label: 'Fit (press again for the whole system)', act: () => fit() },
  { sep: true },
  { id: 'labels', icon: 'Aa', label: 'Labels', act: () => toggle('labels'), on: () => settings.labels },
  { id: 'trails', icon: '〰', label: 'Contrails', act: () => toggle('trails'), on: () => settings.trails },
  { id: 'grid', icon: '▦', label: 'Gravity wells (G)', act: () => toggle('grid'), on: () => settings.grid },
  { id: 'hz', icon: '◎', label: 'Habitable zone (H)', act: () => toggle('hz'), on: () => settings.hz },
  { id: 'scale', icon: '1:1', label: 'True scale', act: () => toggle('scale'), on: () => settings.scale === 'real' },
];

function buildRail() {
  const box = $('#rail');
  box.innerHTML = '';
  for (const r of RAIL) {
    if (r.sep) { box.appendChild(el('div', 'sep')); continue; }
    const b = el('button', 'rail-btn', `<span>${r.icon}</span><em>${r.label}</em>`);
    b.dataset.id = r.id;
    b.setAttribute('aria-label', r.label);
    b.onclick = () => { audio.click(1); r.act(); updateRail(); };
    box.appendChild(b);
  }
  updateRail();
}
function updateRail() {
  for (const r of RAIL) {
    if (r.sep) continue;
    $(`#rail [data-id=${r.id}]`)?.classList.toggle('on', !!r.on?.());
  }
}

function toggle(k) {
  if (k === 'scale') {
    settings.scale = settings.scale === 'real' ? 'visible' : 'real';
    sim.scaleMode = settings.scale;
    toast(settings.scale === 'real' ? 'True scale: planets are specks. Markers show where they are. Collisions get much harder!' : 'Visible scale: sizes exaggerated so you can see them. Distances and masses stay real.');
  } else settings[k] = !settings[k];
  if (k === 'grid' && settings.grid) toast('Gravity wells: the deeper the funnel, the stronger the pull.');
  if (k === 'hz' && settings.hz) toast('Green band: where liquid water can exist.');
  views.showLabels = settings.labels;
  trails.visible = settings.trails;
  saveSettings();
  updateRail();
}

// ---------------------------------------------------------------- habitable zone rings
function updateHZ() {
  const want = new Set();
  if (settings.hz && S.view !== 'galaxy') {
    for (const s of sim.bodies) {
      if (!s.alive || !(s.luminosity > 0.0005)) continue;
      want.add(s.id);
      let m = hzGroup.getObjectByName(s.id);
      if (!m) {
        const L = Math.sqrt(s.luminosity);
        m = new THREE.Mesh(new THREE.RingGeometry(0.95 * L, 1.67 * L, 128), new THREE.MeshBasicMaterial({ color: 0x3fdc7a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.name = s.id;
        hzGroup.add(m);
      }
      toRender(s, m.position);
    }
  }
  for (const c of [...hzGroup.children]) if (!want.has(c.name)) { c.removeFromParent(); c.geometry.dispose(); }
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
  const dil = S.slow < 0.95 ? '<i class="badge">SLOW-MO</i>' : S.dilated ? '<i class="badge warn">TIME DILATED</i>' : '';
  box.innerHTML = `
    <div><span>YEAR</span><b>${year.toFixed(2)}</b>${dil}</div>
    <div><span>STABILITY</span><b class="${st.cls}">${st.s.toFixed(1)}% ${st.label}</b></div>
    <div><span>EARTH</span><b class="${es.cls || 'bad'}">${es.text}</b></div>`;
  // live ticker on Earth's label
  const earth = sim.get('earth');
  if (earth) {
    const tag = sim.climate ? es.text : 'You are here';
    if (earth.tagline !== tag) { earth.tagline = tag; earth._dirty = true; }
  }
}

// ---------------------------------------------------------------- stop / save / load / share
function stopFlow() {
  const wasPlaying = S.playing;
  setPlaying(false);
  aim.cancel();
  const save = buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift });
  const kb = (JSON.stringify(save).length / 1024).toFixed(0);
  const spawned = sim.bodies.filter((b) => b.spawned).length;
  modal({
    title: 'Save this universe?',
    body: `<p>${sim.t.toFixed(1)} years simulated · ${S.shots} shot${S.shots === 1 ? '' : 's'} · ${spawned} object${spawned === 1 ? '' : 's'} added · ${chronicle.length} events</p>
           <p class="muted">Saves store positions and velocities, not video, so this file is only about ${kb} KB. Load it later from the menu or by dropping it on the page.</p>`,
    actions: [
      { label: '⬇ Save .json & start fresh', primary: true, onClick: () => { downloadJSON(save, `universe-${Math.round(START_YEAR + sim.t)}-${Date.now().toString(36)}.json`); closeModal(); endMission(true); freshUniverse(); fit(); toast('Saved. A fresh solar system awaits.'); } },
      { label: '🔗 Copy share link', onClick: () => share(save) },
      { label: 'Discard & start fresh', onClick: () => { closeModal(); endMission(true); freshUniverse(); fit(); } },
      { label: 'Keep playing', onClick: () => { closeModal(); setPlaying(wasPlaying); } },
    ],
  });
}

async function share(save = buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift })) {
  const code = await encodeShare(save);
  const url = `${location.origin}${location.pathname}#u=${code}`;
  try { await navigator.clipboard.writeText(url); toast('Share link copied. Anyone who opens it gets this exact universe.'); }
  catch { prompt('Copy this link:', url); }
  if (navigator.share && MOBILE) navigator.share({ title: 'My universe in God Mode', url }).catch(() => {});
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
  if (S.view === 'galaxy' || sim.t < 0.05 || S.mission) return;
  store.set('gm.autosave', buildSave(sim, { view: S.view, speed: S.speed, frame: settings.frame, drift: settings.drift }));
}, 15000);

// ---------------------------------------------------------------- menus
function openMissions() {
  sheet('Trick shots', MISSIONS.map((m) => {
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
      <button data-m="new">✦ New solar system</button>
      <button data-m="log">📜 Chronicle</button>
      <button data-m="help">❔ How to play</button>
    </div>
    <h4>Settings</h4>
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
    box.querySelector('[data-m=new]').onclick = () => { closeModal(); stopFlow(); };
    box.querySelector('[data-m=log]').onclick = openChronicle;
    box.querySelector('[data-m=help]').onclick = openHelp;
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
  sheet('Chronicle', chronicle.length ? `<div class="chronicle">${[...chronicle].reverse().map((c) => `<div><span class="ts">${stamp(c.t)}</span> ${c.icon} ${c.text}</div>`).join('')}</div>` : '<p class="muted">Nothing has happened yet. Throw something!</p>');
}

function openHelp() {
  modal({
    title: 'How to play god',
    body: `
      <ol class="howto">
        <li><b>Pick</b> something from the arsenal at the bottom.</li>
        <li><b>Tap</b> empty space to place it.</li>
        <li><b>Drag back</b> from it like a pool cue and let go to shoot. The dotted line shows where it will go. Tap it instead to drop it into a circular orbit.</li>
        <li><b>⏮ Rewind</b> puts you back before your last shot with the aim intact, so you can nudge and retry.</li>
      </ol>
      <h4>Moving around</h4>
      <p>${MOBILE ? 'One finger orbits, pinch zooms, two fingers pan. Tap a planet for details, double-tap to follow it.' : 'Drag to orbit, scroll to zoom, right-drag to pan. Click a planet for details, double-click to follow it.'}</p>
      <h4>Views</h4>
      <p><b>Solar</b> keeps the Sun still. <b>Helix</b> shows the solar system flying through the galaxy, so orbits become corkscrews. <b>Milky Way</b> zooms out to the Sun's 230-million-year lap around the galaxy.</p>
      ${MOBILE ? '' : `<h4>Keyboard</h4>
      <div class="keys">
        <span><kbd>Space</kbd> play / pause</span><span><kbd>[</kbd> <kbd>]</kbd> speed</span><span><kbd>R</kbd> rewind shot</span>
        <span><kbd>F</kbd> fit</span><span><kbd>T</kbd> top-down</span><span><kbd>C</kbd> centre</span>
        <span><kbd>G</kbd> gravity wells</span><span><kbd>H</kbd> habitable zone</span><span><kbd>L</kbd> labels</span>
        <span><kbd>0</kbd>–<kbd>9</kbd> Sun & planets</span><span><kbd>V</kbd> next view</span><span><kbd>M</kbd> mute</span>
        <span><kbd>Shift</kbd>+drag tilt shot</span><span><kbd>←</kbd> <kbd>→</kbd> nudge aim</span><span><kbd>↑</kbd> <kbd>↓</kbd> power</span>
      </div>`}
      <p class="muted small">Physics: real masses and J2000 orbits, N-body gravity with an adaptive leapfrog integrator. In visible scale, sizes are exaggerated (and collisions use the visible size); distances and masses are real.</p>`,
    actions: [{ label: 'Got it', primary: true, onClick: closeModal }],
  });
}

function onboarding() {
  if (store.get('gm.onboarded')) return;
  const steps = [
    { t: 'Welcome, god.', b: 'This is our solar system running on real gravity. Look around: drag to orbit, pinch or scroll to zoom.' },
    { t: 'Pick a weapon', b: 'The arsenal at the bottom goes from asteroids to black holes.' },
    { t: 'Line up the shot', b: 'Tap space to place it, then drag back from it like a pool cue. Watch the dotted line, then let go.' },
    { t: 'Want a challenge?', b: 'Open 🎯 Trick shots for missions with star ratings. ⏮ rewinds any shot.' },
  ];
  let i = 0;
  const show = () => modal({
    title: steps[i].t,
    body: `<p>${steps[i].b}</p><div class="dots">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>`,
    actions: [
      { label: i < steps.length - 1 ? 'Next' : "Let's go", primary: true, onClick: () => { if (++i < steps.length) show(); else { closeModal(); store.set('gm.onboarded', true); } } },
      { label: 'Skip', onClick: () => { closeModal(); store.set('gm.onboarded', true); } },
    ],
  });
  show();
}

$('#btn-missions').onclick = openMissions;
$('#btn-trophy').onclick = openTrophies;
$('#btn-menu').onclick = openMenu;
$('#btn-help').onclick = openHelp;
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
    if (id && sim.get(id)) { select(id); setCamMode('follow'); }
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
function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
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
buildArsenal();
buildRail();
updateSound();
$('#btn-trophy').dataset.count = S.achievements.size;
views.showLabels = settings.labels;
trails.visible = settings.trails;
bloom.enabled = settings.bloom;
document.body.dataset.view = 'solar';
document.body.classList.toggle('mobile', MOBILE);
freshUniverse();
camera.position.set(0, 10, 16).multiplyScalar(MOBILE && innerWidth < innerHeight ? 1.8 : 1);
controls.target.set(0, 0, 0);
updateDock();

(async () => {
  const hash = location.hash.match(/#u=([\w-]+)/);
  if (hash) {
    try { applySave(await decodeShare(hash[1])); history.replaceState(null, '', location.pathname); return; }
    catch { toast('⚠ That share link looks broken. Here is a fresh solar system.'); }
  }
  const auto = store.get('gm.autosave');
  if (auto?.sim?.t > 0.5) {
    toast(`Resume your universe from year ${(START_YEAR + auto.sim.t).toFixed(1)}? <button class="link" id="resume">Resume</button>`, 'sticky');
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
