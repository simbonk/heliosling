import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { G, KMS_PER_AUYR } from './data.js';
import { glowTexture } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);
const glow = glowTexture();

// Pool-cue launcher: click to place, drag back to aim and set power, release to shoot.
// Shift while dragging tilts the shot out of the orbital plane. A ghost trajectory
// is integrated on every move so you can see where the shot will go.
export class Aim {
  constructor(app) {
    this.app = app;
    this.mode = null; // 'place' | 'drag' | 'armed'
    this.spec = null;
    this.P = new THREE.Vector3();
    this.dir = new THREE.Vector3(1, 0, 0);
    this.elev = 0;
    this.speed = 0; // km/s relative to host
    this.pullPx = 0;
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

    const dom = app.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.shiftStart = null; });
  }

  get active() { return !!this.mode; }

  begin(spec) {
    this.spec = spec;
    this.mode = 'place';
    this.group.visible = true;
    this.path.visible = false;
    this.impact.visible = false;
    this.impactLabel.visible = false;
    this.cue.visible = this.cueTip.visible = false;
    this.ghost.visible = false;
    this.ghost.material.color.set(spec.kind === 'blackhole' ? '#ff9a4a' : spec.color);
    this.app.onAimChange?.();
  }

  cancel() {
    this.mode = null;
    this.group.visible = false;
    this.impactLabel.visible = false;
    this.app.controls.enabled = true;
    this.app.onAimChange?.();
  }

  // Re-enter the armed state with a previous shot, for "reset to shot".
  arm(shot) {
    this.begin(shot.spec);
    this.app.toRenderXYZ(shot.pos.x, shot.pos.y, shot.pos.z, this.P);
    this.dir.copy(shot.dir);
    this.elev = shot.elev;
    this.speed = shot.speed;
    this.pullPx = shot.pullPx;
    this.mode = 'armed';
    this.normal.copy(UP);
    this.ghost.visible = true;
    this.refreshVisuals(true);
    this.app.onAimChange?.();
  }

  ray(e) {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.app.camera);
    return rc.ray;
  }

  planeHit(e, through) {
    const cam = this.app.camera;
    const view = new THREE.Vector3();
    cam.getWorldDirection(view);
    // fall back to a camera-facing plane when the ecliptic is seen edge-on
    this.normal.copy(Math.abs(view.y) > 0.2 ? UP : view.clone().negate());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, through);
    const out = new THREE.Vector3();
    return this.ray(e).intersectPlane(plane, out) ? out : null;
  }

  screen(v) {
    const p = v.clone().project(this.app.camera);
    const r = this.app.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2((p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height);
  }

  // Flow (same on touch and mouse): tap empty space to place the object, then drag back
  // from the object like a pool cue and release to shoot. Drags elsewhere still move the camera.
  down(e) {
    if (!this.mode || e.button !== 0) return;
    const sp = this.local(e);
    if ((this.mode === 'placed' || this.mode === 'armed') && this.screen(this.P).distanceTo(sp) < (e.pointerType === 'touch' ? 56 : 36)) {
      this.mode = 'drag';
      this.dragFromArmed = this.speed > 0;
      this.dragStart = sp;
      this.pointerId = e.pointerId;
      this.app.controls.enabled = false;
      e.stopImmediatePropagation();
      e.preventDefault();
      this.app.audio.click(0.8);
      this.app.onAimChange?.();
      return;
    }
    this.tapStart = { x: sp.x, y: sp.y, t: performance.now(), id: e.pointerId };
  }

  local(e) {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  move(e) {
    if (!this.mode) return;
    if (this.mode === 'place' && e.pointerType === 'mouse') {
      const hit = this.planeHit(e, this.app.controls.target);
      if (hit) { this.P.copy(hit); this.ghost.position.copy(hit); this.ghost.visible = true; }
      this.updateGrid();
      return;
    }
    if (this.mode !== 'drag' || e.pointerId !== this.pointerId) return;
    const sp = this.local(e);
    if (e.shiftKey) {
      // Shift + drag: tilt out of the orbital plane
      if (!this.shiftStart) this.shiftStart = { y: sp.y, elev: this.elev };
      this.elev = THREE.MathUtils.clamp(this.shiftStart.elev + (this.shiftStart.y - sp.y) * 0.006, -1.4, 1.4);
    } else {
      this.shiftStart = null;
      const q = this.planeHit(e, this.P);
      if (!q) return;
      const pull = q.clone().sub(this.P);
      this.pullPx = this.screen(this.P).distanceTo(sp);
      if (pull.lengthSq() > 0) this.dir.copy(pull).negate().projectOnPlane(this.normal).normalize();
      const before = Math.floor(this.speed / 5);
      this.speed = this.pxToSpeed(this.pullPx);
      if (Math.floor(this.speed / 5) !== before) this.app.audio.click(0.6 + Math.min(this.speed, 300) / 200);
    }
    this.refreshVisuals();
  }

  up(e) {
    if (this.tapStart && e.pointerId === this.tapStart.id) {
      const sp = this.local(e);
      const moved = Math.hypot(sp.x - this.tapStart.x, sp.y - this.tapStart.y);
      const quick = performance.now() - this.tapStart.t < 400;
      this.tapStart = null;
      if (moved < 8 && quick && (this.mode === 'place' || this.mode === 'placed' || this.mode === 'armed') && e.target === this.app.renderer.domElement) {
        const hit = this.planeHit(e, this.app.controls.target);
        if (hit) {
          this.P.copy(hit);
          this.mode = 'placed';
          this.speed = 0; this.pullPx = 0; this.elev = 0;
          this.ghost.visible = true;
          this.cue.visible = this.cueTip.visible = false;
          this.path.visible = false; this.impact.visible = false; this.impactLabel.visible = false;
          this.prediction = null;
          this.updateGrid();
          this.app.audio.click(0.7);
          this.app.onAimChange?.();
        }
      }
      return;
    }
    if (this.mode !== 'drag' || e.pointerId !== this.pointerId) return;
    this.app.controls.enabled = true;
    if (this.pullPx < 10) {
      if (this.dragFromArmed) { this.mode = 'armed'; this.refreshVisuals(true); return; }
      this.orbitDrop();
      return;
    }
    this.mode = 'armed';
    this.fire();
  }

  // Drop into a circular orbit around whatever dominates the placement point.
  orbitDrop() {
    const host = this.host();
    const hp = new THREE.Vector3();
    this.app.toRender(host, hp);
    const rv = this.P.clone().sub(hp);
    const r = rv.length();
    this.normal.copy(UP);
    this.dir.copy(UP).cross(rv).normalize();
    this.elev = 0;
    this.speed = Math.sqrt((G * (host.mass + this.spec.mass)) / r) * KMS_PER_AUYR;
    this.pullPx = this.speedToPx(this.speed);
    this.fire();
  }

  setElevation(deg) {
    this.elev = THREE.MathUtils.degToRad(deg);
    if (this.mode === 'armed') this.refreshVisuals(true);
  }

  nudge(kind, amount) {
    if (kind === 'turn') this.dir.applyAxisAngle(this.normal, THREE.MathUtils.degToRad(amount));
    if (kind === 'speed') { this.speed = Math.max(0, this.speed * (1 + amount)); this.pullPx = this.speedToPx(this.speed); }
    if (kind === 'elev') this.elev = THREE.MathUtils.clamp(this.elev + THREE.MathUtils.degToRad(amount), -1.4, 1.4);
    this.app.audio.click(1 + this.speed / 300);
    this.refreshVisuals(true);
  }

  pxToSpeed(px) { return 90 * Math.pow(Math.max(0, px - 4) / 250, 1.5); }
  speedToPx(s) { return 250 * Math.pow(s / 90, 1 / 1.5) + 4; }

  key(e) {
    if (!this.mode) return;
    if (e.key === 'Escape') { this.cancel(); e.preventDefault(); return; }
    if (this.mode !== 'armed') return;
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.nudge('turn', e.key === 'ArrowLeft' ? step : -step);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') this.nudge('speed', (e.key === 'ArrowUp' ? 0.02 : -0.02) * step);
    else if (e.key === 'PageUp' || e.key === 'PageDown') this.nudge('elev', e.key === 'PageUp' ? step : -step);
    else if (e.key === 'Enter' || e.key === ' ') this.fire();
    else return;
    e.preventDefault();
    e.stopPropagation();
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
    const v = this.dir.clone().multiplyScalar(Math.cos(this.elev)).addScaledVector(this.normal, Math.sin(this.elev)).normalize();
    return v.multiplyScalar(this.speed / KMS_PER_AUYR);
  }

  state() {
    const host = this.host();
    const p = this.app.fromRender(this.P);
    const v = this.velocity();
    return { x: p.x, y: p.y, z: p.z, vx: host.vx + v.x, vy: host.vy + v.y, vz: host.vz + v.z, host };
  }

  fire() {
    if (this.speed <= 0 && this.mode !== 'drag') return this.orbitDrop();
    const st = this.state();
    const shot = { spec: this.spec, pos: { x: st.x, y: st.y, z: st.z }, dir: this.dir.clone(), elev: this.elev, speed: this.speed, pullPx: this.pullPx };
    this.cancel();
    this.app.onLaunch(this.spec, st, shot);
  }

  updateGrid() {
    const t = this.app.controls.target;
    const ref = this.app.refRender();
    this.grid.position.set(ref.x, t.y, ref.z);
    this.grid.quaternion.setFromUnitVectors(UP, this.normal);
  }

  refreshVisuals(force) {
    const cam = this.app.camera;
    this.ghost.position.copy(this.P);
    this.updateGrid();
    const d = cam.position.distanceTo(this.P);
    const worldPerPx = (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.app.renderer.domElement.clientHeight;
    const v = this.velocity();
    const back = v.lengthSq() > 0 ? v.clone().normalize().negate() : this.dir.clone().negate();
    const len = Math.max(this.pullPx, 10) * worldPerPx;
    const w = worldPerPx * 3;
    const gap = worldPerPx * 14;
    const start = this.P.clone().addScaledVector(back, gap);
    this.cue.visible = this.cueTip.visible = true;
    this.cue.position.copy(start).addScaledVector(back, len / 2 + w * 3);
    this.cue.scale.set(w, len, w);
    this.cue.quaternion.setFromUnitVectors(UP, back.clone().negate());
    this.cueTip.position.copy(start).addScaledVector(back, w * 1.5);
    this.cueTip.scale.set(w * 0.7, w * 3, w * 0.7);
    this.cueTip.quaternion.copy(this.cue.quaternion);
    const now = performance.now();
    if (force || now - this.lastPredict > 40) { this.lastPredict = now; this.predict(); }
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
    const pulse = 0.06 + Math.sin(t * 8) * 0.012;
    this.impact.scale.setScalar(pulse);
    this.ghost.scale.setScalar(0.04 + Math.sin(t * 5) * 0.006);
    if (this.mode === 'place') this.ghost.position.copy(this.P);
    this.ghost.material.opacity = this.mode === 'place' ? 0.5 : 1;
    // keep grid sized to the view
    const d = this.app.camera.position.distanceTo(this.app.controls.target);
    const s = THREE.MathUtils.clamp(Math.pow(2, Math.round(Math.log2(d / 20))), 0.05, 64);
    this.grid.scale.setScalar(s);
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
