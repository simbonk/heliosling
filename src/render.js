import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { planetTexture, ringTexture, glowTexture, fbm, earthNightTexture } from './textures.js';
import { makeEarthMaterial, logDepthDiskChunks } from './shaders.js';

const TILT = { earth: 23.4, mars: 25.2, jupiter: 3.1, saturn: 26.7, uranus: 97.8, neptune: 28.3, pluto: 122.5, venus: 177.4 };
const TRAIL_CAP = 4000;

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.className = 'label-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#02030a');
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1e-6, 1e8);
  camera.position.set(0, 18, 34);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1e-4;
  controls.maxDistance = 20000;
  controls.zoomSpeed = 1.2;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.6, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  scene.add(new THREE.AmbientLight(0xffffff, 0.06));
  return { renderer, labelRenderer, scene, camera, controls, composer, bloom };
}

export function makeStarfield() {
  const n = 9000;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const tilt = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(60));
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const band = i < n * 0.55;
    if (band) {
      const th = Math.random() * Math.PI * 2;
      const spread = (Math.random() - 0.5) * (Math.random() * 0.35);
      v.set(Math.cos(th), spread, Math.sin(th)).normalize().applyMatrix4(tilt);
    } else {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      v.set(s * Math.cos(th), u, s * Math.sin(th));
    }
    v.multiplyScalar(1e6);
    pos.set([v.x, v.y, v.z], i * 3);
    const t = Math.random();
    const b = 0.35 + Math.random() ** 3 * 0.9;
    const c = t < 0.15 ? [1, 0.8, 0.6] : t < 0.3 ? [0.7, 0.8, 1] : [1, 0.97, 0.92];
    col.set(c.map((x) => x * b), i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ map: starDot(), size: 2.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, opacity: 0.95, alphaTest: 0.02 });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}

function starDot() {
  const s = 16, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

const glow = glowTexture();
const softGlow = glowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.08)');

function ringRadialUV(geo, inner, outer) {
  const p = geo.attributes.position, uv = geo.attributes.uv, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    uv.setXY(i, (v.length() - inner) / (outer - inner), 0.5);
  }
}

function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6, 7, 4);
    v.multiplyScalar(0.7 + n * 0.6);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const diskMaterial = () => logDepthDiskChunks(new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 } },
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vUv; varying vec3 vPos; void main(){ vUv=uv; vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
    uniform float time; varying vec3 vPos;
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
    void main(){
      float r=length(vPos.xy); float a=atan(vPos.y,vPos.x);
      float t=(r-1.5)/3.0;
      float swirl=n(vec2(a*6.0+time*2.0/r, r*3.0))*0.6+n(vec2(a*14.0-time*3.0/r, r*9.0))*0.4;
      float fall=smoothstep(0.0,0.08,t)*(1.0-smoothstep(0.35,1.0,t));
      vec3 hot=vec3(1.0,0.9,0.7), warm=vec3(1.0,0.45,0.12);
      vec3 c=mix(hot,warm,clamp(t*1.6,0.0,1.0));
      float doppler=0.65+0.55*sin(a);
      gl_FragColor=vec4(c*swirl*fall*doppler*2.2, fall*swirl);
    }`,
}));

export class BodyViews {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.views = new Map();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.showLabels = true;
    this.onLabelClick = null;
  }

  create(b) {
    // root (position) -> sg (tidal stretch) -> inv (undo stretch rotation) -> tiltG (axial tilt, size) -> spin -> mesh
    const root = new THREE.Group(), sg = new THREE.Group(), inv = new THREE.Group(), tiltG = new THREE.Group(), spin = new THREE.Group();
    root.add(sg); sg.add(inv); inv.add(tiltG); tiltG.add(spin);
    const view = { root, sg, inv, tiltG, spin, body: b, kind: b.kind };
    tiltG.rotation.z = THREE.MathUtils.degToRad(TILT[b.id] ?? (b.spawned ? Math.random() * 40 : 0));

    if (b.kind === 'star') {
      const tex = planetTexture(b.tex, b.color, 'star');
      view.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(b.color).lerp(new THREE.Color('#ffffff'), 0.4).multiplyScalar(1.6) }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
      halo.scale.setScalar(5);
      const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlow, color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
      corona.scale.setScalar(16);
      root.add(halo, corona);
      if (b.luminosity > 0.0005) {
        view.light = new THREE.PointLight(0xfff4e0, 2.2 * Math.pow(b.luminosity, 0.2), 0, 0);
        root.add(view.light);
      }
    } else if (b.kind === 'blackhole') {
      view.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      const disk = new THREE.Mesh(new THREE.RingGeometry(1.5, 4.5, 128, 4), diskMaterial());
      disk.rotation.x = -Math.PI / 2 + 0.25;
      disk.userData.k = 1;
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: photonRing(), color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      ring.scale.setScalar(3.1);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlow, color: 0xff8a3a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.25 }));
      halo.scale.setScalar(14);
      tiltG.add(disk);
      root.add(ring, halo);
      view.disk = disk;
    } else if (b.kind === 'neutron') {
      view.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color('#d8ecff').multiplyScalar(2) }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x9fc8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.setScalar(6);
      const beamGeo = new THREE.ConeGeometry(1.2, 40, 24, 1, true);
      beamGeo.translate(0, -20, 0);
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat);
      b1.rotation.x = Math.PI; b2.rotation.x = 0;
      const beams = new THREE.Group();
      beams.add(b1, b2);
      beams.rotation.z = 0.5;
      spin.add(beams);
      root.add(halo);
    } else {
      const isRock = b.kind === 'rock' || b.kind === 'comet';
      const geo = isRock ? rockGeometry(Math.random() * 10) : new THREE.SphereGeometry(1, 64, 32);
      const tex = planetTexture(b.tex, b.color, b.kind);
      const mat = b.id === 'earth' ? makeEarthMaterial(tex, earthNightTexture()) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
      view.mesh = new THREE.Mesh(geo, mat);
      view.earth = b.id === 'earth';
      if (b.rings) {
        const rg = new THREE.RingGeometry(1.25, 2.35, 128, 1);
        ringRadialUV(rg, 1.25, 2.35);
        const ring = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ map: ringTexture(), transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        tiltG.add(ring);
        view.ring = ring;
      }
      if (b.kind === 'planet' && b.id !== 'earth') {
        const atm = new THREE.Sprite(new THREE.SpriteMaterial({ map: softGlow, color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.25 }));
        atm.scale.setScalar(2.6);
        root.add(atm);
      }
      if (b.kind === 'comet') view.tail = makeCometTail(b.color);
    }
    spin.add(view.mesh);
    if (view.tail) this.group.add(view.tail);

    // Constant screen-size marker so tiny bodies stay findable at any zoom.
    view.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: b.kind === 'blackhole' ? '#ff9a4a' : b.color, sizeAttenuation: false, depthWrite: false, depthTest: false, transparent: true, blending: THREE.AdditiveBlending }));
    view.marker.scale.setScalar(b.kind === 'star' ? 0.045 : 0.03);
    view.marker.renderOrder = 5;
    this.group.add(view.marker);

    const el = document.createElement('div');
    el.className = `label kind-${b.kind}${b.spawned ? ' spawned' : ''}`;
    el.innerHTML = `<span class="dot" style="background:${b.kind === 'blackhole' ? '#ff9a4a' : b.color}"></span><b></b><small></small>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onLabelClick?.(b.id); });
    view.labelEl = el;
    view.label = new CSS2DObject(el);
    view.label.center.set(0, 1.2);
    root.add(view.label);
    this.updateLabelText(view);

    this.group.add(root);
    this.views.set(b.id, view);
    return view;
  }

  updateLabelText(view) {
    view.labelEl.querySelector('b').textContent = view.body.name;
    view.labelEl.querySelector('small').textContent = view.body.tagline || '';
  }

  remove(id) {
    const v = this.views.get(id);
    if (!v) return;
    v.root.removeFromParent();
    v.marker.removeFromParent();
    v.tail?.removeFromParent();
    v.label.element.remove();
    v.root.traverse((o) => { if (o.geometry && !o.isSprite) o.geometry.dispose(); });
    this.views.delete(id);
  }

  clear() { for (const id of [...this.views.keys()]) this.remove(id); }

  // positions: function(body) -> Vector3 in render space
  update(toRender, camera, selectedId, dtReal, viewport) {
    const alive = new Set();
    for (const b of this.sim.bodies) {
      if (!b.alive) continue;
      alive.add(b.id);
      let v = this.views.get(b.id);
      if (v && (v.kind !== b.kind || b._dirty)) {
        if (v.kind !== b.kind) { this.remove(b.id); v = null; }
        else this.updateLabelText(v);
        b._dirty = false;
      }
      if (!v) v = this.create(b);
    }
    for (const id of [...this.views.keys()]) if (!alive.has(id)) this.remove(id);

    const tmp = new THREE.Vector3();
    const fovK = viewport.h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (const v of this.views.values()) {
      const b = v.body;
      toRender(b, tmp);
      v.root.position.copy(tmp);
      v.marker.position.copy(tmp);
      const r = this.sim.radius(b);
      v.tiltG.scale.setScalar(r);
      v.root.children.forEach((c) => { if (c.isSprite) c.scale.setScalar(r * (c.userData.k ||= c.scale.x)); });
      this.tidalStretch(v, tmp, toRender);
      v.spin.rotation.y += dtReal * (b.kind === 'neutron' ? 6 : 0.25);
      if (v.disk) v.disk.material.uniforms.time.value += dtReal;
      const dist = camera.position.distanceTo(tmp);
      const px = (r / dist) * fovK;
      v.marker.visible = px < 5;
      v.marker.material.opacity = b.id === selectedId ? 1 : 0.8;
      v.marker.scale.setScalar((b.id === selectedId ? 1.5 : 1) * (b.kind === 'star' ? 0.045 : 0.03));
      v.label.visible = this.showLabels || b.id === selectedId;
      v.labelEl.classList.toggle('selected', b.id === selectedId);
      v.label.center.set(-0.05, 1 + Math.min(px, 200) / 26);
      v.labelEl.style.opacity = dist > 1e-9 ? '' : '0';
      v._px = px;
      if (v.tail) this.updateTail(v, tmp, toRender);
      if (v.earth) {
        const star = this.sim.dominantStar(b);
        const u = v.mesh.material.uniforms;
        if (star) { toRender(star, u.sunPos.value); u.sunPower.value = Math.min(1.2, Math.max(0.05, (star.luminosity || 0) / Math.max(1e-6, (star.x - b.x) ** 2 + (star.y - b.y) ** 2 + (star.z - b.z) ** 2)) ** 0.25); }
        else u.sunPower.value = 0;
      }
    }
  }

  // Hide labels that would overlap a more important one, so the inner system stays readable.
  declutter(camera, selectedId, viewport) {
    const rank = (v) => (v.body.id === selectedId ? 1e9 : 0) + (v.body.spawned ? 1e6 : 0) + (v.body.kind === 'star' || v.body.kind === 'blackhole' ? 1e5 : 0) + v.body.mass * 1e3 + (v.body.id === 'earth' ? 2e6 : 0);
    const list = [...this.views.values()].filter((v) => v.label.visible).sort((a, b) => rank(b) - rank(a));
    const placed = [];
    const p = new THREE.Vector3();
    for (const v of list) {
      p.copy(v.root.position).project(camera);
      const x = (p.x + 1) / 2 * viewport.w, y = (1 - p.y) / 2 * viewport.h - Math.min(v._px || 0, 200);
      const w = 14 + v.body.name.length * 7.2, h = 26;
      const r = { x0: x, y0: y - h, x1: x + w, y1: y };
      const hit = placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
      if (hit && v.body.id !== selectedId) v.label.visible = false;
      else placed.push(r);
    }
  }

  // Bodies that wander close to a black hole get spaghettified toward it.
  tidalStretch(v, pos, toRender) {
    const b = v.body;
    let s = 1;
    if (b.kind !== 'blackhole') {
      for (const h of this.sim.bodies) {
        if (!h.alive || h.kind !== 'blackhole') continue;
        const d = Math.hypot(h.x - b.x, h.y - b.y, h.z - b.z);
        const reach = this.sim.radius(h) * 8 + this.sim.radius(b);
        if (d < reach) {
          s = 1 + Math.min(2.5, (reach / d - 1) * 0.8);
          const hp = new THREE.Vector3();
          toRender(h, hp);
          const dir = hp.sub(pos).normalize();
          v.sg.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
          v.inv.quaternion.copy(v.sg.quaternion).invert();
          break;
        }
      }
    }
    v.sg.scale.set(s, 1 / Math.sqrt(s), 1 / Math.sqrt(s));
  }

  updateTail(v, pos, toRender) {
    const star = this.sim.dominantStar(v.body);
    if (!star) { v.tail.visible = false; return; }
    const sp = new THREE.Vector3();
    toRender(star, sp);
    const dir = pos.clone().sub(sp);
    const d = dir.length();
    dir.normalize();
    const len = Math.min(1.5, 0.6 / Math.max(d, 0.2) ** 1.5);
    v.tail.visible = d < 8;
    const p = v.tail.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const f = i / p.count;
      const jitter = (Math.sin(i * 12.9898) * 0.5) * f * len * 0.08;
      p.setXYZ(i, pos.x + dir.x * f * len + jitter, pos.y + dir.y * f * len + jitter, pos.z + dir.z * f * len - jitter);
    }
    p.needsUpdate = true;
    v.tail.geometry.computeBoundingSphere();
  }
}

function photonRing() {
  const s = 256, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.08, 'rgba(255,240,210,1)');
  g.addColorStop(0.25, 'rgba(255,170,90,0.35)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

function makeCometTail(color) {
  const n = 120;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const c = new Float32Array(n * 3), base = new THREE.Color(color);
  for (let i = 0; i < n; i++) { const f = 1 - i / n; c.set([base.r * f, base.g * f, base.b * f], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ map: glow, size: 0.04, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  pts.frustumCulled = false;
  return pts;
}

// Contrails: a shared sample clock, so heliocentric trails can subtract the reference
// body's position at the moment each point was recorded.
export class Trails {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.reset();
    this.length = 0.6;
    this.visible = true;
  }

  reset() {
    for (const t of this.trails?.values() || []) { t.line.removeFromParent(); t.line.geometry.dispose(); }
    this.trails = new Map();
    this.count = 0;
    this.times = new Float64Array(TRAIL_CAP);
    this.ref = new Float64Array(TRAIL_CAP * 3);
  }

  sample(refBody) {
    const k = this.count % TRAIL_CAP;
    this.times[k] = this.sim.t;
    this.ref[k * 3] = refBody ? refBody.x : 0; this.ref[k * 3 + 1] = refBody ? refBody.y : 0; this.ref[k * 3 + 2] = refBody ? refBody.z : 0;
    for (const b of this.sim.bodies) {
      if (!b.alive) continue;
      let t = this.trails.get(b.id);
      if (!t) t = this.add(b);
      t.buf[k * 3] = b.x; t.buf[k * 3 + 1] = b.y; t.buf[k * 3 + 2] = b.z;
    }
    this.count++;
  }

  add(b) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRAIL_CAP + 1) * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array((TRAIL_CAP + 1) * 3), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.frustumCulled = false;
    this.group.add(line);
    const base = b.kind === 'blackhole' ? new THREE.Color('#ff9a4a') : new THREE.Color(b.color);
    const t = { line, buf: new Float64Array(TRAIL_CAP * 3), start: this.count, color: base, id: b.id };
    this.trails.set(b.id, t);
    return t;
  }

  // offset(tSample, refX, refY, refZ, out) gives the frame shift for a stored sample.
  update(toRender, offset) {
    this.group.visible = this.visible;
    if (!this.visible) return;
    const off = new THREE.Vector3(), cur = new THREE.Vector3();
    for (const [id, t] of this.trails) {
      const b = this.sim.bodies.find((x) => x.id === id);
      if (!b || !b.alive) {
        if (!t.dead) t.dead = this.count;
        if (this.count - t.dead > TRAIL_CAP) { t.line.removeFromParent(); t.line.geometry.dispose(); this.trails.delete(id); continue; }
      }
      const end = t.dead || this.count;
      const avail = Math.min(end - t.start, TRAIL_CAP - (this.count - end));
      const n = Math.max(0, Math.min(avail, Math.floor(TRAIL_CAP * this.length)));
      const pos = t.line.geometry.attributes.position.array, col = t.line.geometry.attributes.color.array;
      const c = t.color, boost = b?.spawned ? 1.2 : 0.8;
      let w = 0;
      for (let i = 0; i < n; i++) {
        const s = end - n + i;
        const k = s % TRAIL_CAP;
        offset(this.times[k], this.ref[k * 3], this.ref[k * 3 + 1], this.ref[k * 3 + 2], off);
        pos[w * 3] = t.buf[k * 3] + off.x; pos[w * 3 + 1] = t.buf[k * 3 + 1] + off.y; pos[w * 3 + 2] = t.buf[k * 3 + 2] + off.z;
        const a = Math.pow((i + 1) / n, 1.6) * boost;
        col[w * 3] = c.r * a; col[w * 3 + 1] = c.g * a; col[w * 3 + 2] = c.b * a;
        w++;
      }
      if (b && b.alive && n > 0) {
        toRender(b, cur);
        pos[w * 3] = cur.x; pos[w * 3 + 1] = cur.y; pos[w * 3 + 2] = cur.z;
        col[w * 3] = c.r * boost; col[w * 3 + 1] = c.g * boost; col[w * 3 + 2] = c.b * boost;
        w++;
      }
      t.line.geometry.setDrawRange(0, w);
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.geometry.attributes.color.needsUpdate = true;
    }
  }
}

export class Belt {
  constructor(scene) {
    this.points = null;
    this.scene = scene;
  }
  update(belt, toRenderXYZ) {
    if (!belt || !belt.n) { if (this.points) this.points.visible = false; return; }
    if (!this.points || this.n !== belt.n) {
      this.points?.removeFromParent();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(belt.n * 3), 3));
      this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb5a690, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.5, depthWrite: false }));
      this.points.frustumCulled = false;
      this.scene.add(this.points);
      this.n = belt.n;
    }
    this.points.visible = true;
    const a = this.points.geometry.attributes.position.array, out = new THREE.Vector3();
    for (let i = 0; i < belt.n; i++) {
      if (!belt.alive[i]) { a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = 1e9; continue; }
      toRenderXYZ(belt.pos[i * 3], belt.pos[i * 3 + 1], belt.pos[i * 3 + 2], out);
      a[i * 3] = out.x; a[i * 3 + 1] = out.y; a[i * 3 + 2] = out.z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Dust that sits still in galactic space, so drift through the galaxy is felt as parallax.
export class SpaceDust {
  constructor(scene) {
    const n = 2500;
    this.n = n;
    this.box = 160;
    this.base = new Float32Array(n * 3).map(() => (Math.random() - 0.5) * this.box);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ map: glow, color: 0x8899bb, size: 0.18, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  update(shift, center, visible) {
    this.points.visible = visible;
    if (!visible) return;
    const a = this.points.geometry.attributes.position.array, B = this.box;
    const wrap = (v) => ((((v + B / 2) % B) + B) % B) - B / 2;
    for (let i = 0; i < this.n; i++) {
      a[i * 3] = center.x + wrap(this.base[i * 3] - shift.x - center.x);
      a[i * 3 + 1] = center.y + wrap(this.base[i * 3 + 1] - shift.y - center.y);
      a[i * 3 + 2] = center.z + wrap(this.base[i * 3 + 2] - shift.z - center.z);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Short-lived flashes and debris attached to a body's view.
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
  }
  impact(at, color = '#ffd27a', size = 0.2, followId = null) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.position.copy(at);
    this.scene.add(flash);
    const n = 160;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), sp = Math.random() ** 0.5;
      vel.push(new THREE.Vector3(s * Math.cos(th), u, s * Math.sin(th)).multiplyScalar(sp));
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const debris = new THREE.Points(g, new THREE.PointsMaterial({ map: glow, color, size: size * 0.25, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    debris.position.copy(at);
    debris.frustumCulled = false;
    this.scene.add(debris);
    this.items.push({ flash, debris, vel, age: 0, life: 2.2, size, followId });
  }
  update(dt, follow) {
    const p0 = new THREE.Vector3();
    this.items = this.items.filter((it) => {
      it.age += dt;
      const f = it.age / it.life;
      if (it.followId && follow(it.followId, p0)) { it.flash.position.copy(p0); it.debris.position.copy(p0); }
      it.flash.scale.setScalar(it.size * (1 + f * 14));
      it.flash.material.opacity = Math.max(0, 1 - f * 1.4);
      const p = it.debris.geometry.attributes.position.array;
      const spread = it.size * 6 * (1 - Math.exp(-it.age * 2));
      it.vel.forEach((v, i) => { p[i * 3] = v.x * spread; p[i * 3 + 1] = v.y * spread; p[i * 3 + 2] = v.z * spread; });
      it.debris.geometry.attributes.position.needsUpdate = true;
      it.debris.material.opacity = Math.max(0, 1 - f);
      if (f >= 1) { it.flash.removeFromParent(); it.debris.removeFromParent(); it.debris.geometry.dispose(); return false; }
      return true;
    });
  }
}
