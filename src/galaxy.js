import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { glowTexture } from './textures.js';

// The Milky Way view: the Sun's ~230 Myr orbit around Sagittarius A*, bobbing through
// the disk, with Earth's big moments pinned where the Sun was when they happened.
// Units: 1 = 100 parsecs. Time: millions of years (Myr), 0 = today.

const R0 = 82; // 8.2 kpc
const GAL_YEAR = 230; // Myr
const Z_AMP = 2.4; // ~80 pc, exaggerated 3x so it is visible
const Z_PERIOD = 70;
const PATTERN = 0.8; // spiral pattern turns slower than the Sun

export const MILESTONES = [
  { t: -538, name: 'Cambrian explosion', note: 'Complex life takes off' },
  { t: -444, name: 'End-Ordovician extinction', note: '85% of species lost' },
  { t: -372, name: 'Late Devonian extinction', note: 'Oceans suffocate' },
  { t: -252, name: 'End-Permian "Great Dying"', note: '96% of marine species lost' },
  { t: -233, name: 'First dinosaurs', note: 'The age of reptiles begins' },
  { t: -201, name: 'End-Triassic extinction', note: 'Dinosaurs take over' },
  { t: -66, name: 'Chicxulub impact', note: 'Goodbye, non-avian dinosaurs' },
  { t: -0.3, name: 'Homo sapiens', note: 'Someone starts asking questions' },
];

export function sunGalacticPos(t, out = new THREE.Vector3()) {
  const a = (2 * Math.PI * t) / GAL_YEAR;
  const R = R0 + 2.5 * Math.sin((2 * Math.PI * t) / 170);
  return out.set(R * Math.cos(a), Z_AMP * Math.sin((2 * Math.PI * t) / Z_PERIOD + 0.6), -R * Math.sin(a));
}

export class GalaxyView {
  constructor(scene, { stars = 60000 } = {}) {
    this.stars = stars;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.t = -540;
    this.glow = glowTexture();
    this.disk = this.makeDisk();
    this.group.add(this.disk);
    this.makeCore();
    this.makeSunPath();
    this.makeMilestones();
  }

  makeDisk() {
    const n = this.stars;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const pitch = Math.tan(THREE.MathUtils.degToRad(13));
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      let x, y, z;
      if (i < n * 0.18) {
        // bulge / bar
        const r = Math.abs(gauss()) * 22;
        const th = Math.random() * Math.PI * 2;
        x = r * Math.cos(th) * 1.6; z = r * Math.sin(th) * 0.7; y = gauss() * 7 * Math.exp(-r / 25);
        const rot = 0.5; const xr = x * Math.cos(rot) - z * Math.sin(rot); z = x * Math.sin(rot) + z * Math.cos(rot); x = xr;
        c.setHSL(0.1, 0.6, 0.55 + Math.random() * 0.25);
      } else {
        const arm = i % 4;
        const r = 12 + -Math.log(1 - Math.random() * 0.995) * 32;
        const inArm = Math.random() < 0.72;
        let th = Math.log(r / 10) / pitch + (arm * Math.PI) / 2;
        th += inArm ? gauss() * (0.25 + 4 / r) : Math.random() * Math.PI * 2;
        x = r * Math.cos(th); z = -r * Math.sin(th); y = gauss() * 1.6;
        const young = inArm && Math.random() < 0.5;
        if (young && Math.random() < 0.06) c.setHSL(0.93, 0.7, 0.65);
        else if (young) c.setHSL(0.6, 0.55, 0.6 + Math.random() * 0.3);
        else c.setHSL(0.09, 0.35, 0.45 + Math.random() * 0.3);
      }
      pos.set([x, y, z], i * 3);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ map: this.glow, size: 1.3, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  }

  makeCore() {
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xffc98a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
    core.scale.setScalar(40);
    const hole = new THREE.Mesh(new THREE.SphereGeometry(1.2, 32, 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const disk = new THREE.Mesh(new THREE.RingGeometry(1.6, 4.5, 96), new THREE.MeshBasicMaterial({ color: 0xffa860, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    disk.rotation.x = -Math.PI / 2 + 0.3;
    this.group.add(core, hole, disk);
    this.group.add(label('Sagittarius A*', '4 million Suns', new THREE.Vector3(0, 3, 0)));
  }

  makeSunPath() {
    const n = 2000;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.path = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.path.frustumCulled = false;
    this.pathN = n;
    // faint reference circle for the full orbit
    const ring = new THREE.Mesh(new THREE.RingGeometry(R0 - 0.08, R0 + 0.08, 256), new THREE.MeshBasicMaterial({ color: 0x6b7aa8, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xffe08a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.sun.scale.setScalar(4);
    this.sunLabel = label('Solar System', 'You are here · 230 km/s', new THREE.Vector3());
    this.sunLabel.element.classList.add('you');
    this.sun.add(this.sunLabel);
    this.group.add(this.path, ring, this.sun);
  }

  makeMilestones() {
    this.markers = MILESTONES.map((m) => {
      const p = sunGalacticPos(m.t);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff9a6a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.scale.setScalar(2.2);
      s.position.copy(p);
      const ago = -m.t;
      const l = label(m.name, `${ago < 1 ? `${Math.round(ago * 1000)} kyr` : `${ago} Myr`} ago · ${(ago / GAL_YEAR).toFixed(2)} gal. yr`, new THREE.Vector3());
      l.element.classList.add('milestone');
      l.element.title = m.note;
      s.add(l);
      this.group.add(s);
      return { m, s, l };
    });
  }

  setVisible(v) {
    this.group.visible = v;
    // CSS2D labels do not inherit visibility from the group, hide them explicitly
    this.group.traverse((o) => { if (o.isCSS2DObject) o.visible = v; });
  }

  update(dtReal, speedMyrPerSec) {
    if (!this.group.visible) return;
    this.t = Math.min(250, this.t + dtReal * speedMyrPerSec);
    this.disk.rotation.y = ((2 * Math.PI * this.t) / GAL_YEAR) * PATTERN;
    sunGalacticPos(this.t, this.sun.position);
    const pos = this.path.geometry.attributes.position.array, col = this.path.geometry.attributes.color.array;
    const span = Math.min(this.t + 540, 600);
    const v = new THREE.Vector3();
    for (let i = 0; i < this.pathN; i++) {
      const f = i / (this.pathN - 1);
      sunGalacticPos(this.t - span + f * span, v);
      pos.set([v.x, v.y, v.z], i * 3);
      const a = 0.15 + f ** 1.5 * 0.85;
      col.set([1 * a, 0.85 * a, 0.55 * a], i * 3);
    }
    this.path.geometry.attributes.position.needsUpdate = true;
    this.path.geometry.attributes.color.needsUpdate = true;
    for (const { m, s, l } of this.markers) {
      const passed = this.t >= m.t;
      s.material.opacity = passed ? 1 : 0.15;
      l.element.classList.toggle('future', !passed);
    }
  }

  get focus() { return this.sun.position; }

  timeLabel() {
    const t = this.t;
    if (Math.abs(t) < 0.5) return 'Today';
    return t < 0 ? `${Math.round(-t)} million years ago` : `${Math.round(t)} million years from now`;
  }
}

function label(title, sub, pos) {
  const el = document.createElement('div');
  el.className = 'label galaxy-label';
  el.innerHTML = `<b>${title}</b><small>${sub}</small>`;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  o.center.set(-0.08, 1.2);
  return o;
}
