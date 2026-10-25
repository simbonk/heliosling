import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { G, KMS_PER_AUYR } from './data.js';
import { glowTexture } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);
const glow = glowTexture();
const DIAL_R = 84; // pulling back this far gives circular-orbit speed
const KNOB_MIN = 30, KNOB_MAX = 2 * DIAL_R;
// pull length <-> speed as a multiple of the local circular-orbit speed
const multFromR = (r) => (r <= KNOB_MIN ? 0 : ((Math.min(r, KNOB_MAX) - KNOB_MIN) / (DIAL_R - KNOB_MIN)) ** 1.5);
const rFromMult = (m) => KNOB_MIN + (DIAL_R - KNOB_MIN) * Math.cbrt(m * m);
const SVGNS = 'http://www.w3.org/2000/svg';

// Launching, Angry Birds style and built for touch first:
//   1. place   - tap exactly where the object should start (tap again anywhere to move it)
//   2. heading - a slingshot appears around it: pull back and let go. Pull length sets the speed
//                as a multiple of the circular-orbit speed at that spot; a ghost trajectory shows
//                where it will go while you pull.
export class Aim {
  constructor(app) {
    this.app = app;
    this.mode = null; // 'place' | 'heading'
    this.spec = null;
    this.P = new THREE.Vector3();
    this.dir = new THREE.Vector3(1, 0, 0);
    this.elev = 0;
    this.speed = 0; // km/s relative to host
    this.circ = 0; // circular-orbit speed at this spot, km/s
    this.mult = 1; // speed as a multiple of circ: the knob's distance from the centre
    this.normal = UP.clone();
    this.lastPredict = 0;
    this.hitId = null;

    const scene = app.scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.ghost = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, sizeAttenuation: false, depthTest: false, transparent: true, blending: THREE.AdditiveBlending }));
    this.ghost.scale.setScalar(0.07);
    this.ghost.renderOrder = 10;
    // a bright spinning ring round the object in the pouch, so it reads as "the thing you're flinging"
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), sizeAttenuation: false, depthTest: false, transparent: true }));
    this.halo.renderOrder = 11;
    this.ghost.add(this.halo);

    const n = 400;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.path = new THREE.Points(pg, new THREE.PointsMaterial({ map: glow, size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.path.frustumCulled = false;
    this.pathN = n;

    this.impact = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex(), color: 0xff3b3b, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.impact.scale.setScalar(0.06);
    this.impact.renderOrder = 11;
    const el = document.createElement('div');
    el.className = 'impact-warning';
    this.impactLabel = new CSS2DObject(el);
    this.impactLabel.center.set(-0.15, 0.5);
    this.impact.add(this.impactLabel);

    this.grid = new THREE.PolarGridHelper(40, 12, 20, 96, 0x2a4a7a, 0x16233b);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.22;
    this.grid.material.depthWrite = false;

    this.group.add(this.ghost, this.path, this.impact, this.grid);
    this.makeDial();

    const dom = app.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => { this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
    dom.addEventListener('pointerup', (e) => this.canvasUp(e));
    window.addEventListener('keydown', (e) => this.key(e));
  }

  get active() { return !!this.mode; }

  // ---------------------------------------------------------- slingshot overlay
  // A slingshot drawn around the placed object. Grab anywhere near it, pull back like a
  // catapult and let go: it flies the opposite way, faster the further you pulled. Faint rings
  // show the pull for a circular orbit and for escape speed; the pull snaps to each.
  makeDial() {
    const s = (KNOB_MAX + 60) * 2, c = s / 2;
    const root = document.createElement('div');
    root.className = 'aim-dial sling';
    root.hidden = true;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
    const mk = (tag, attrs, parent = svg) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
    const rEsc = rFromMult(Math.SQRT2);
    this.guides = mk('g', { class: 'sling-guides' });
    mk('circle', { cx: c, cy: c, r: DIAL_R, class: 'dial-track' }, this.guides);
    mk('circle', { cx: c, cy: c, r: rEsc, class: 'dial-escape' }, this.guides);
    this.guideOrbit = mk('text', { x: c, y: c + DIAL_R + 14, class: 'dial-text' }, this.guides);
    this.guideOrbit.textContent = 'orbit';
    this.guideEsc = mk('text', { x: c, y: c + rEsc + 14, class: 'dial-text esc' }, this.guides);
    this.guideEsc.textContent = 'escape';
    // the fork: a Y whose arms hold the bands, sitting just below the object
    mk('path', { d: `M ${c} ${c + 62} L ${c} ${c + 30} M ${c} ${c + 30} Q ${c - 4} ${c + 14} ${c - 24} ${c - 2} M ${c} ${c + 30} Q ${c + 4} ${c + 14} ${c + 24} ${c - 2}`, class: 'sling-fork' });
    this.bandL = mk('line', { x1: c - 24, y1: c - 2, x2: c, y2: c, class: 'sling-band' });
    this.bandR = mk('line', { x1: c + 24, y1: c - 2, x2: c, y2: c, class: 'sling-band' });
    this.pouch = mk('circle', { cx: c, cy: c, r: 26, class: 'sling-pouch' });
    this.dialArrow = mk('line', { x1: c, y1: c, x2: c, y2: c, class: 'dial-arrow' });
    this.dialSpeed = mk('text', { x: c, y: c, class: 'dial-speed' });
    // big invisible grab zone around the object
    this.grab = mk('circle', { cx: c, cy: c, r: 70, class: 'sling-grab' });
    root.appendChild(svg);
    document.body.appendChild(root);
    this.dial = { root, c };

    this.grab.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'heading') return;
      e.preventDefault();
      e.stopPropagation();
      this.grab.setPointerCapture(e.pointerId);
      this.dragging = { kind: 'pull', id: e.pointerId };
      this.pull = new THREE.Vector2();
      this.app.controls.enabled = false;
      root.classList.add('pulling');
      this.app.audio.click(0.8);
    });
    this.grab.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.id) return;
      const sp = this.screen(this.P);
      this.pull.set(e.clientX - sp.x, e.clientY - sp.y);
      let r = this.pull.length();
      let m = multFromR(r);
      for (const snap of [1, Math.SQRT2]) if (Math.abs(r - rFromMult(snap)) < 7) m = snap;
      if (m !== this.mult && (m === 1 || m === Math.SQRT2)) this.app.audio.click(1.4);
      if (r > KNOB_MAX) { this.pull.setLength(KNOB_MAX); r = KNOB_MAX; }
      this.mult = m;
      // fly away from the finger: the world point under it, mirrored through the object
      const hit = this.planeHit(e, this.P);
      if (hit) {
        const d = this.P.clone().sub(hit).projectOnPlane(this.normal);
        if (d.lengthSq() > 0) this.dir.copy(d.normalize());
      }
      this.speed = this.mult * this.circ;
      this.refresh();
    });
    const release = (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.id) return;
      this.dragging = null;
      root.classList.remove('pulling');
      this.app.controls.enabled = true;
      const pulled = this.pull?.length() || 0;
      this.pull = null;
      if (e.type === 'pointerup' && pulled > KNOB_MIN) {
        root.classList.add('snap');
        setTimeout(() => root.classList.remove('snap'), 250);
        this.fire();
      } else this.refresh(true);
    };
    this.grab.addEventListener('pointerup', release);
    this.grab.addEventListener('pointercancel', release);
  }

  updateDial() {
    const { root, c } = this.dial;
    const show = this.mode === 'heading';
    root.hidden = !show;
    if (!show) return;
    const sp = this.screen(this.P);
    const inFront = this.P.clone().project(this.app.camera).z < 1;
    root.style.visibility = inFront ? '' : 'hidden';
    root.style.transform = `translate(${sp.x - c}px, ${sp.y - c}px)`;
    const px = c + (this.pull?.x || 0), py = c + (this.pull?.y || 0);
    for (const b of [this.bandL, this.bandR]) { b.setAttribute('x2', px); b.setAttribute('y2', py); }
    this.pouch.setAttribute('cx', px);
    this.pouch.setAttribute('cy', py);
    const pulling = !!this.pull && this.pull.length() > KNOB_MIN;
    // launch arrow points opposite the pull
    const ax = c - (this.pull?.x || 0) * 0.9, ay = c - (this.pull?.y || 0) * 0.9;
    this.dialArrow.setAttribute('x2', pulling ? ax : c);
    this.dialArrow.setAttribute('y2', pulling ? ay : c);
    this.dialSpeed.textContent = pulling ? `${this.speed.toFixed(this.speed < 10 ? 1 : 0)} km/s` : '';
    this.dialSpeed.setAttribute('x', ax);
    this.dialSpeed.setAttribute('y', ay - 10);
  }

  // ---------------------------------------------------------- flow
  begin(spec) {
    this.spec = spec;
    this.mode = 'place';
    this.group.visible = true;
    this.path.visible = false;
    this.impact.visible = false;
    this.impactLabel.visible = false;
    this.ghost.visible = false;
    this.prediction = null;
    this.ghost.material.color.set(spec.kind === 'blackhole' ? '#ff9a4a' : spec.color);
    this.halo.material.color.set(spec.kind === 'blackhole' ? '#ffc08a' : '#fff4c8');
    this.updateGrid();
    this.updateDial();
    this.app.onAimChange?.();
  }

  cancel() {
    this.mode = null;
    this.dragging = null;
    this.group.visible = false;
    this.impactLabel.visible = false;
    this.dial.root.hidden = true;
    this.app.controls.enabled = true;
    this.app.onAimChange?.();
  }

  // Re-enter the wizard with a previous shot, for "undo shot".
  arm(shot) {
    this.begin(shot.spec);
    this.app.toRenderXYZ(shot.pos.x, shot.pos.y, shot.pos.z, this.P);
    this.dir.copy(shot.dir);
    this.elev = shot.elev;
    this.orbitDefaults(false);
    this.speed = shot.speed;
    this.mult = this.circ > 0 ? shot.speed / this.circ : 1;
    this.normal.copy(UP);
    this.ghost.visible = true;
    this.setStep('heading');
  }

  setStep(step) {
    this.mode = step;
    this.keyAim = false;
    this.pull = null;
    this.ghost.visible = step !== 'place';
    if (step === 'place' || step === 'heading') { this.path.visible = false; this.impact.visible = false; this.impactLabel.visible = false; }
    this.refresh(true);
  }

  next() {
    if (this.mode === 'heading') this.fire();
  }

  back() {
    if (this.mode === 'heading') this.setStep('place');
    else this.cancel();
  }

  canvasUp(e) {
    const t = this.tapStart;
    this.tapStart = null;
    if (!this.mode || !t || t.id !== e.pointerId || this.dragging) return;
    const moved = Math.hypot(e.clientX - t.x, e.clientY - t.y);
    if (moved > 8 || performance.now() - t.t > 450) return; // that was a camera drag
    const view = new THREE.Vector3();
    this.app.camera.getWorldDirection(view);
    this.normal.copy(Math.abs(view.y) > 0.2 ? UP : view.clone().negate());
    const hit = this.planeHit(e, this.app.controls.target);
    if (!hit) return;
    this.P.copy(hit);
    this.app.audio.click(0.7);
    if (this.mode === 'place') {
      this.orbitDefaults(true);
      this.setStep('heading');
    } else {
      this.orbitDefaults(false);
      this.refresh(true);
    }
    this.app.onPlaced?.();
  }

  // Start every shot as a prograde circular orbit around whatever dominates that spot,
  // so the first ghost path is something sensible to tweak from.
  orbitDefaults(resetHeading) {
    const host = this.host();
    const hp = new THREE.Vector3();
    this.app.toRender(host, hp);
    const rv = this.P.clone().sub(hp).projectOnPlane(UP);
    const r = Math.max(rv.length(), 1e-6);
    if (resetHeading) { this.dir.copy(UP).cross(rv).normalize(); this.elev = 0; this.mult = 1; }
    this.circ = Math.sqrt((G * (host.mass + this.spec.mass)) / r) * KMS_PER_AUYR;
    this.speed = this.mult * this.circ;
  }

  setElevation(deg) {
    this.elev = THREE.MathUtils.degToRad(deg);
    this.refresh();
  }

  nudge(kind, amount) {
    this.keyAim = true;
    if (kind === 'turn') this.dir.applyAxisAngle(this.normal, THREE.MathUtils.degToRad(amount));
    if (kind === 'speed') { this.mult = Math.max(0.02, this.mult * (1 + amount)); this.speed = this.mult * this.circ; }
    if (kind === 'elev') this.elev = THREE.MathUtils.clamp(this.elev + THREE.MathUtils.degToRad(amount), -1.4, 1.4);
    this.app.audio.click(1 + this.speed / 300);
    this.refresh(true);
  }

  key(e) {
    if (!this.mode || e.target.closest?.('input')) return;
    if (e.key === 'Escape') { this.cancel(); e.preventDefault(); return; }
    if (this.mode === 'place') return;
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.nudge('turn', e.key === 'ArrowLeft' ? step : -step);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') this.nudge('speed', (e.key === 'ArrowUp' ? 0.02 : -0.02) * step);
    else if (e.key === 'PageUp' || e.key === 'PageDown') this.nudge('elev', e.key === 'PageUp' ? step : -step);
    else if (e.key === 'Enter') this.next();
    else if (e.key === 'Backspace') this.back();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------------------------------------------------------- geometry helpers
  ray(e) {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.app.camera);
    return rc.ray;
  }

  planeHit(e, through) {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, through);
    const out = new THREE.Vector3();
    return this.ray(e).intersectPlane(plane, out) ? out : null;
  }

  screen(v) {
    const p = v.clone().project(this.app.camera);
    const r = this.app.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height);
  }

  velocityDir() {
    return this.dir.clone().multiplyScalar(Math.cos(this.elev)).addScaledVector(this.normal, Math.sin(this.elev)).normalize();
  }

  // The body whose gravity owns the placement point: a planet if inside its Hill sphere, else the dominant star.
  host() {
    const sim = this.app.sim;
    const p = this.app.fromRender(this.P);
    let best = null, bestHill = Infinity;
    const star0 = sim.dominantStar(p);
    for (const b of sim.bodies) {
      if (!b.alive || b.kind !== 'planet') continue;
      const star = sim.dominantStar(b);
      if (!star) continue;
      const D = Math.hypot(b.x - star.x, b.y - star.y, b.z - star.z);
      const hill = D * Math.cbrt(b.mass / (3 * star.mass));
      const d = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
      if (d < hill && hill < bestHill) { best = b; bestHill = hill; }
    }
    return best || star0 || sim.bodies.find((b) => b.alive);
  }

  velocity() {
    return this.velocityDir().multiplyScalar(this.speed / KMS_PER_AUYR);
  }

  state() {
    const host = this.host();
    const p = this.app.fromRender(this.P);
    const v = this.velocity();
    return { x: p.x, y: p.y, z: p.z, vx: host.vx + v.x, vy: host.vy + v.y, vz: host.vz + v.z, host };
  }

  fire() {
    const st = this.state();
    if (!this.prediction) this.predict();
    const pred = this.prediction, end = pred?.pts.length ? pred.pts[pred.pts.length - 1][3] : null;
    const shot = { spec: this.spec, pos: { x: st.x, y: st.y, z: st.z }, dir: this.dir.clone(), elev: this.elev, speed: this.speed,
      // what the ghost path predicted, so the follow-up camera can pace itself
      hitIn: pred?.hit ? end : null, hitId: pred?.hit?.id || null, years: end, host: st.host?.id };
    this.cancel();
    this.app.onLaunch(this.spec, st, shot);
  }

  updateGrid() {
    const t = this.app.controls.target;
    const ref = this.app.refRender();
    this.grid.position.set(ref.x, t.y, ref.z);
    this.grid.quaternion.setFromUnitVectors(UP, this.normal);
  }

  refresh(force) {
    if (!this.mode) return;
    this.updateGrid();
    if (this.mode === 'place') { this.updateDial(); this.app.onAimChange?.(); return; }
    this.ghost.position.copy(this.P);
    const now = performance.now();
    // the ghost path appears while you pull (or tune the shot from the keyboard)
    const aiming = (this.pull && this.pull.length() > KNOB_MIN) || this.keyAim;
    if (!aiming) { this.path.visible = this.impact.visible = this.impactLabel.visible = false; this.prediction = null; }
    else if (force || now - this.lastPredict > 40) { this.lastPredict = now; this.predict(); }
    this.updateDial();
    this.app.onAimChange?.();
  }

  predict() {
    const sim = this.app.sim;
    const st = this.state();
    const star = sim.dominantStar(st) || st.host;
    const r = Math.hypot(st.x - star.x, st.y - star.y, st.z - star.z);
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / (G * star.mass));
    const years = THREE.MathUtils.clamp(period * 1.3, 0.5, 40);
    const probe = { ...this.spec, id: '__probe', x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz, kind: this.spec.kind };
    const res = sim.predict(probe, years, this.pathN - 1, this.app.refId(), 6000);
    const pos = this.path.geometry.attributes.position.array, col = this.path.geometry.attributes.color.array;
    const c = new THREE.Color(this.spec.kind === 'blackhole' ? '#ffb070' : this.spec.color).lerp(new THREE.Color('#ffffff'), 0.3);
    const out = new THREE.Vector3();
    res.pts.forEach((p, i) => {
      this.app.predictedToRender(p, out);
      pos.set([out.x, out.y, out.z], i * 3);
      const a = 1 - (i / res.pts.length) * 0.75;
      col.set([c.r * a, c.g * a, c.b * a], i * 3);
    });
    this.path.geometry.setDrawRange(0, res.pts.length);
    this.path.geometry.attributes.position.needsUpdate = true;
    this.path.geometry.attributes.color.needsUpdate = true;
    this.path.visible = true;
    this.prediction = res;
    const newHit = res.hit?.id || null;
    if (res.hit) {
      this.impact.position.copy(out);
      this.impact.visible = true;
      this.impactLabel.visible = true;
      const t = res.pts[res.pts.length - 1][3];
      this.impactLabel.element.innerHTML = `<b>⚠ IMPACT PREDICTED</b><span>${res.hit.name} · in ${t < 1 ? `${(t * 12).toFixed(1)} months` : `${t.toFixed(1)} yr`}</span>`;
      if (newHit !== this.hitId) this.app.audio.warn();
    } else {
      this.impact.visible = false;
      this.impactLabel.visible = false;
    }
    this.hitId = newHit;
  }

  update(t) {
    if (!this.mode) return;
    this.impact.scale.setScalar(0.06 + Math.sin(t * 8) * 0.012);
    this.ghost.scale.setScalar(0.07 + Math.sin(t * 5) * 0.012);
    // the halo is a child of the ghost, so its scale is relative: breathe a little out of step
    this.halo.scale.setScalar(1.15 + Math.sin(t * 5 + 1.2) * 0.12);
    this.halo.material.rotation = t * 1.4;
    const d = this.app.camera.position.distanceTo(this.app.controls.target);
    this.grid.scale.setScalar(THREE.MathUtils.clamp(Math.pow(2, Math.round(Math.log2(d / 20))), 0.05, 64));
    this.updateDial(); // the camera may move under the dial
  }

  hud() {
    if (!this.mode) return null;
    const host = this.host();
    return {
      spec: this.spec,
      mode: this.mode,
      speed: this.speed,
      mult: this.mult,
      aiming: !!this.prediction,
      elev: THREE.MathUtils.radToDeg(this.elev),
      host: host?.name,
      hit: this.prediction?.hit?.name,
      hitIn: this.prediction?.hit ? this.prediction.pts[this.prediction.pts.length - 1][3] : null,
    };
  }
}

// dashed ring with a soft glow, for marking the object being launched (also used on the shot in flight)
export function haloTex() {
  const s = 128, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = 'white';
  ctx.shadowColor = 'white';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 6;
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 14, a + 0.12, a + Math.PI / 3 - 0.12); ctx.stroke();
  }
  return new THREE.CanvasTexture(cv);
}

function ringTex() {
  const s = 128, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 4;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath(); ctx.moveTo(s / 2 + Math.cos(a) * 20, s / 2 + Math.sin(a) * 20); ctx.lineTo(s / 2 + Math.cos(a) * 44, s / 2 + Math.sin(a) * 44); ctx.stroke();
  }
  return new THREE.CanvasTexture(cv);
}
