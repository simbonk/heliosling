import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { G, KMS_PER_AUYR } from './data.js';
import { glowTexture } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);
const glow = glowTexture();
const DIAL_R = 84;
const SVGNS = 'http://www.w3.org/2000/svg';

// Launch wizard, built for touch first:
//   1. place  - tap exactly where the object should start (tap again anywhere to move it)
//   2. heading - drag the ring around the object to point it; drag the centre to nudge its position
//   3. speed  - slider plus presets (orbit / escape / drop in), then Launch
// The cue stick and a live ghost trajectory show the shot at every step.
export class Aim {
  constructor(app) {
    this.app = app;
    this.mode = null; // 'place' | 'heading' | 'speed'
    this.spec = null;
    this.P = new THREE.Vector3();
    this.dir = new THREE.Vector3(1, 0, 0);
    this.elev = 0;
    this.speed = 0; // km/s relative to host
    this.speedTouched = false;
    this.normal = UP.clone();
    this.lastPredict = 0;
    this.hitId = null;

    const scene = app.scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.ghost = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, sizeAttenuation: false, depthTest: false, transparent: true, blending: THREE.AdditiveBlending }));
    this.ghost.scale.setScalar(0.05);
    this.ghost.renderOrder = 10;
    this.cue = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1, 1, 12, 1), new THREE.MeshBasicMaterial({ color: 0xe8d2a8, transparent: true, opacity: 0.85, depthTest: false }));
    this.cue.renderOrder = 9;
    this.cueTip = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1), new THREE.MeshBasicMaterial({ color: 0x7fd3ff, depthTest: false }));
    this.cueTip.renderOrder = 9;

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

    this.group.add(this.ghost, this.cue, this.cueTip, this.path, this.impact, this.grid);
    this.makeDial();

    const dom = app.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => { this.tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
    dom.addEventListener('pointerup', (e) => this.canvasUp(e));
    window.addEventListener('keydown', (e) => this.key(e));
  }

  get active() { return !!this.mode; }

  // ---------------------------------------------------------- dial overlay
  makeDial() {
    const s = (DIAL_R + 40) * 2, c = s / 2;
    const root = document.createElement('div');
    root.className = 'aim-dial';
    root.hidden = true;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
    mk('circle', { cx: c, cy: c, r: DIAL_R, class: 'dial-track' });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, r0 = DIAL_R - (i % 6 === 0 ? 9 : 5);
      mk('line', { x1: c + Math.cos(a) * r0, y1: c + Math.sin(a) * r0, x2: c + Math.cos(a) * DIAL_R, y2: c + Math.sin(a) * DIAL_R, class: 'dial-tick' });
    }
    this.dialArrow = mk('line', { x1: c, y1: c, x2: c + DIAL_R, y2: c, class: 'dial-arrow' });
    this.dialBand = mk('circle', { cx: c, cy: c, r: DIAL_R, class: 'dial-band' });
    this.dialKnob = mk('g', { class: 'dial-knob' });
    const knobC = document.createElementNS(SVGNS, 'circle');
    knobC.setAttribute('r', 17);
    const knobA = document.createElementNS(SVGNS, 'path');
    knobA.setAttribute('d', 'M -6 -7 L 8 0 L -6 7 Z');
    this.dialKnob.append(knobC, knobA);
    this.dialCenter = mk('circle', { cx: c, cy: c, r: 22, class: 'dial-center' });
    root.appendChild(svg);
    const hint = document.createElement('div');
    hint.className = 'dial-hint';
    root.appendChild(hint);
    this.dialHint = hint;
    document.body.appendChild(root);
    this.dial = { root, c };

    const start = (kind) => (e) => {
      if (!this.mode || this.mode === 'place') return;
      e.preventDefault();
      e.stopPropagation();
      e.target.setPointerCapture(e.pointerId);
      this.dragging = { kind, id: e.pointerId };
      this.app.controls.enabled = false;
      root.classList.add(`drag-${kind}`);
      this.app.audio.click(0.8);
    };
    this.dialBand.addEventListener('pointerdown', start('heading'));
    this.dialKnob.addEventListener('pointerdown', start('heading'));
    this.dialCenter.addEventListener('pointerdown', start('move'));
    const move = (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.id) return;
      const hit = this.planeHit(e, this.P);
      if (!hit) return;
      if (this.dragging.kind === 'heading') {
        const d = hit.sub(this.P).projectOnPlane(this.normal);
        if (d.lengthSq() > 0) {
          const before = Math.round(this.headingDeg());
          this.dir.copy(d.normalize());
          if (Math.round(this.headingDeg() / 5) !== Math.round(before / 5)) this.app.audio.click(1.1);
          if (this.mode === 'heading' || this.mode === 'speed') this.refresh();
        }
      } else {
        this.P.copy(hit);
        if (!this.speedTouched) this.orbitDefaults(false);
        this.refresh();
      }
    };
    const end = (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.id) return;
      root.classList.remove(`drag-${this.dragging.kind}`);
      this.dragging = null;
      this.app.controls.enabled = true;
      this.refresh(true);
    };
    for (const el of [this.dialBand, this.dialKnob, this.dialCenter]) {
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
  }

  headingDeg() { return THREE.MathUtils.radToDeg(Math.atan2(-this.dir.z, this.dir.x)); }

  updateDial() {
    const { root, c } = this.dial;
    const show = this.mode === 'heading' || this.mode === 'speed';
    root.hidden = !show;
    if (!show) return;
    const sp = this.screen(this.P);
    const cam = this.app.camera;
    const inFront = this.P.clone().project(cam).z < 1;
    root.style.visibility = inFront ? '' : 'hidden';
    root.style.transform = `translate(${sp.x - c}px, ${sp.y - c}px)`;
    // on-screen angle of the world heading
    const d = cam.position.distanceTo(this.P);
    const tip = this.screen(this.P.clone().addScaledVector(this.velocityDir(), d * 0.05));
    const a = Math.atan2(tip.y - sp.y, tip.x - sp.x);
    const kx = c + Math.cos(a) * DIAL_R, ky = c + Math.sin(a) * DIAL_R;
    this.dialArrow.setAttribute('x2', kx);
    this.dialArrow.setAttribute('y2', ky);
    this.dialKnob.setAttribute('transform', `translate(${kx} ${ky}) rotate(${THREE.MathUtils.radToDeg(a)})`);
    root.classList.toggle('speed-step', this.mode === 'speed');
    this.dialHint.textContent = this.mode === 'heading' ? 'Drag the ring to aim · drag the centre to move' : '';
  }

  // ---------------------------------------------------------- flow
  begin(spec) {
    this.spec = spec;
    this.mode = 'place';
    this.group.visible = true;
    this.path.visible = false;
    this.impact.visible = false;
    this.impactLabel.visible = false;
    this.cue.visible = this.cueTip.visible = false;
    this.ghost.visible = false;
    this.prediction = null;
    this.ghost.material.color.set(spec.kind === 'blackhole' ? '#ff9a4a' : spec.color);
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
    this.speed = shot.speed;
    this.speedTouched = true;
    this.normal.copy(UP);
    this.ghost.visible = true;
    this.setStep('speed');
  }

  setStep(step) {
    this.mode = step;
    this.ghost.visible = step !== 'place';
    if (step === 'place') { this.path.visible = false; this.impact.visible = false; this.impactLabel.visible = false; this.cue.visible = this.cueTip.visible = false; }
    this.refresh(true);
  }

  next() {
    if (this.mode === 'heading') this.setStep('speed');
    else if (this.mode === 'speed') this.fire();
  }

  back() {
    if (this.mode === 'speed') this.setStep('heading');
    else if (this.mode === 'heading') this.setStep('place');
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
      if (!this.speedTouched) this.orbitDefaults(false);
      this.refresh(true);
    }
  }

  // Start every shot as a prograde circular orbit around whatever dominates that spot,
  // so the first ghost path is something sensible to tweak from.
  orbitDefaults(resetHeading) {
    const host = this.host();
    const hp = new THREE.Vector3();
    this.app.toRender(host, hp);
    const rv = this.P.clone().sub(hp).projectOnPlane(UP);
    const r = Math.max(rv.length(), 1e-6);
    if (resetHeading) { this.dir.copy(UP).cross(rv).normalize(); this.elev = 0; this.speedTouched = false; }
    this.speed = Math.sqrt((G * (host.mass + this.spec.mass)) / r) * KMS_PER_AUYR;
  }

  presetSpeed(kind) {
    const host = this.host();
    const hp = new THREE.Vector3();
    this.app.toRender(host, hp);
    const r = Math.max(this.P.distanceTo(hp), 1e-6);
    const circ = Math.sqrt((G * (host.mass + this.spec.mass)) / r) * KMS_PER_AUYR;
    if (kind === 'orbit') {
      const rv = this.P.clone().sub(hp).projectOnPlane(UP);
      this.dir.copy(UP).cross(rv).normalize();
      this.elev = 0;
      this.speed = circ;
    }
    if (kind === 'escape') this.speed = circ * Math.SQRT2 * 1.05;
    if (kind === 'drop') this.speed = 0;
    this.speedTouched = true;
    this.app.audio.click(1.3);
    this.refresh(true);
  }

  // slider position 0..1 <-> km/s, finer at the low end where orbits live
  static toSpeed(x) { return 400 * Math.pow(x, 2.2); }
  static fromSpeed(v) { return Math.pow(Math.min(v, 400) / 400, 1 / 2.2); }

  setSpeed(kms) {
    this.speed = Math.max(0, kms);
    this.speedTouched = true;
    this.refresh();
  }

  setElevation(deg) {
    this.elev = THREE.MathUtils.degToRad(deg);
    this.refresh();
  }

  nudge(kind, amount) {
    if (kind === 'turn') this.dir.applyAxisAngle(this.normal, THREE.MathUtils.degToRad(amount));
    if (kind === 'speed') { this.speed = Math.max(0, this.speed * (1 + amount)); this.speedTouched = true; }
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
    const shot = { spec: this.spec, pos: { x: st.x, y: st.y, z: st.z }, dir: this.dir.clone(), elev: this.elev, speed: this.speed };
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
    const cam = this.app.camera;
    this.ghost.position.copy(this.P);
    const d = cam.position.distanceTo(this.P);
    const worldPerPx = (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.app.renderer.domElement.clientHeight;
    // pool-cue stick behind the object, longer for faster shots
    const back = this.velocityDir().negate();
    const len = (30 + Math.min(this.speed, 300) * 0.9) * worldPerPx;
    const w = worldPerPx * 3;
    const start = this.P.clone().addScaledVector(back, worldPerPx * 26);
    this.cue.visible = this.cueTip.visible = this.mode === 'speed' && this.speed > 0;
    this.cue.position.copy(start).addScaledVector(back, len / 2 + w * 3);
    this.cue.scale.set(w, len, w);
    this.cue.quaternion.setFromUnitVectors(UP, back.clone().negate());
    this.cueTip.position.copy(start).addScaledVector(back, w * 1.5);
    this.cueTip.scale.set(w * 0.7, w * 3, w * 0.7);
    this.cueTip.quaternion.copy(this.cue.quaternion);
    const now = performance.now();
    if (force || now - this.lastPredict > 40) { this.lastPredict = now; this.predict(); }
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
    this.ghost.scale.setScalar(0.04 + Math.sin(t * 5) * 0.006);
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
      elev: THREE.MathUtils.radToDeg(this.elev),
      host: host?.name,
      hit: this.prediction?.hit?.name,
      hitIn: this.prediction?.hit ? this.prediction.pts[this.prediction.pts.length - 1][3] : null,
    };
  }
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
