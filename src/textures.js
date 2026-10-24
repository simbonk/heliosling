import * as THREE from 'three';

// Procedural planet textures. Everything is generated on a canvas at startup, so the app
// ships with no image assets and no licensing strings attached.

function hash(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

export function fbm(x, y, z, seed = 0, oct = 5) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

const mix = (a, b, t) => a + (b - a) * t;
const mixc = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// paint(lat, lon, x, y, z) -> [r, g, b]
function makeTexture(w, h, paint) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let j = 0; j < h; j++) {
    const lat = Math.PI / 2 - (j / h) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const lon = (i / w) * Math.PI * 2;
      const x = cl * Math.cos(lon), z = cl * Math.sin(lon), y = sl;
      const c = paint(lat, lon, x, y, z);
      const k = (j * w + i) * 4;
      d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function banded(colors, { seed = 1, turb = 0.08, freq = 9, spot = null } = {}) {
  const cs = colors.map(hex);
  return (lat, lon, x, y, z) => {
    const n = fbm(x * 3, y * 3, z * 3, seed, 4);
    let t = (Math.sin(lat * freq + n * turb * 40) + 1) / 2;
    t = clamp01(t + (fbm(x * 12, y * 30, z * 12, seed + 5, 3) - 0.5) * 0.35);
    const idx = t * (cs.length - 1);
    const i0 = Math.floor(idx), i1 = Math.min(cs.length - 1, i0 + 1);
    let c = mixc(cs[i0], cs[i1], idx - i0);
    if (spot) {
      const dl = (lat - spot.lat) / spot.h, dn = ((((lon - spot.lon) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) / spot.w;
      const r = dl * dl + dn * dn;
      if (r < 1) c = mixc(c, hex(spot.color), (1 - r) * 0.85);
    }
    return c;
  };
}

function rocky(base, dark, { seed = 3, craters = 0, caps = null, scale = 4 } = {}) {
  const b = hex(base), dk = hex(dark);
  const cr = [];
  for (let i = 0; i < craters; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    cr.push([s * Math.cos(th), u, s * Math.sin(th), 0.02 + Math.random() ** 3 * 0.15]);
  }
  return (lat, lon, x, y, z) => {
    const n = fbm(x * scale, y * scale, z * scale, seed, 6);
    let c = mixc(dk, b, clamp01((n - 0.3) * 2.2));
    for (const [cx, cy, cz, r] of cr) {
      const d = Math.hypot(x - cx, y - cy, z - cz) / r;
      if (d < 1.15) c = mixc(c, d > 0.85 ? [c[0] * 1.25, c[1] * 1.25, c[2] * 1.25] : [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], d > 0.85 ? (1.15 - d) * 2 : 0.6);
    }
    if (caps && Math.abs(lat) > caps - fbm(x * 8, y * 8, z * 8, seed + 9, 3) * 0.25) c = [235, 238, 242];
    return c.map((v) => Math.min(255, v));
  };
}

const PAINTERS = {
  sun: () => {
    return (lat, lon, x, y, z) => {
      const n = fbm(x * 9, y * 9, z * 9, 11, 5);
      const g = fbm(x * 40, y * 40, z * 40, 13, 2);
      const t = clamp01(n * 0.9 + g * 0.35);
      return mixc([255, 120, 20], [255, 236, 150], t);
    };
  },
  mercury: () => rocky('#b8b0a6', '#5d5853', { seed: 21, craters: 160, scale: 5 }),
  venus: () => {
    const f = banded(['#c99a55', '#e9cf94', '#f3e2b5', '#d8b072'], { seed: 31, turb: 0.25, freq: 5 });
    return (lat, lon, x, y, z) => { const c = f(lat, lon, x, y, z); const n = fbm(x * 6 + 3, y * 2, z * 6, 37, 4); return mixc(c, [250, 236, 200], n * 0.35); };
  },
  earth: () => {
    return (lat, lon, x, y, z) => {
      const h = fbm(x * 2.2, y * 2.2, z * 2.2, 41, 7);
      const alat = Math.abs(lat);
      let c;
      if (h < 0.5) {
        c = mixc([8, 30, 90], [28, 90, 165], clamp01((h - 0.3) * 5));
      } else {
        const m = fbm(x * 6, y * 6, z * 6, 45, 4);
        c = mixc([60, 120, 50], [170, 150, 95], clamp01((m - 0.4) * 3 + (alat < 0.5 ? 0.15 : 0)));
        if (h > 0.62) c = mixc(c, [120, 105, 90], (h - 0.62) * 5);
      }
      if (alat > 1.22 - fbm(x * 5, y * 5, z * 5, 47, 3) * 0.2) c = [236, 242, 248];
      const cl = fbm(x * 4 + 9, y * 7, z * 4, 49, 6);
      c = mixc(c, [255, 255, 255], clamp01((cl - 0.52) * 3.2) * 0.85);
      return c;
    };
  },
  mars: () => rocky('#d47a4a', '#7a3520', { seed: 51, craters: 40, caps: 1.3, scale: 3 }),
  jupiter: () => banded(['#8f6a4a', '#d9b48a', '#f2e4cc', '#c48a5a', '#e8d2b0', '#a4704c'], { seed: 61, turb: 0.06, freq: 11, spot: { lat: -0.38, lon: 1.2, h: 0.09, w: 0.28, color: '#c0482c' } }),
  saturn: () => banded(['#c8a870', '#e6d3a3', '#f1e6c5', '#d8bd85'], { seed: 71, turb: 0.04, freq: 13 }),
  uranus: () => banded(['#9cd6dd', '#b5e6ea', '#a6dde3'], { seed: 81, turb: 0.02, freq: 6 }),
  neptune: () => banded(['#2c4bc0', '#3f66da', '#5b84ea', '#3654c8'], { seed: 91, turb: 0.06, freq: 8, spot: { lat: -0.35, lon: 3.6, h: 0.07, w: 0.2, color: '#1a2a78' } }),
  pluto: () => {
    const base = rocky('#d6c3a8', '#7e6550', { seed: 101, craters: 20, scale: 4 });
    return (lat, lon, x, y, z) => {
      let c = base(lat, lon, x, y, z);
      const d = Math.hypot(x - 0.7, y - 0.05, z - 0.7);
      if (d < 0.45 + fbm(x * 6, y * 6, z * 6, 103, 3) * 0.2) c = mixc(c, [246, 236, 220], 0.8);
      return c;
    };
  },
};

const cache = new Map();

export function planetTexture(key, color = '#888888', kind = 'planet') {
  const ck = key || `${kind}:${color}`;
  if (cache.has(ck)) return cache.get(ck);
  let painter;
  const big = key === 'earth' || key === 'jupiter' || key === 'sun';
  if (key && PAINTERS[key]) painter = PAINTERS[key]();
  else if (kind === 'star') {
    const c = hex(color);
    painter = (lat, lon, x, y, z) => { const n = fbm(x * 9, y * 9, z * 9, 7, 5); return mixc([c[0] * 0.75, c[1] * 0.55, c[2] * 0.45], [255, Math.min(255, c[1] + 80), Math.min(255, c[2] + 80)], n); };
  } else if (kind === 'comet' || kind === 'rock') {
    const c = hex(color);
    painter = rocky(color, `#${c.map((v) => Math.round(v * 0.45).toString(16).padStart(2, '0')).join('')}`, { seed: 5, craters: 30, scale: 5 });
  } else {
    const c = hex(color);
    const d = (k) => `#${c.map((v) => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0')).join('')}`;
    painter = banded([d(0.7), d(1.0), d(1.2), d(0.85)], { seed: 9, turb: 0.1, freq: 7 });
  }
  const tex = makeTexture(big ? 1024 : 512, big ? 512 : 256, painter);
  cache.set(ck, tex);
  return tex;
}

// City lights for Earth's night side, using the same continents as the day map.
export function earthNightTexture() {
  if (cache.has('earth-night')) return cache.get('earth-night');
  const tex = makeTexture(1024, 512, (lat, lon, x, y, z) => {
    const h = fbm(x * 2.2, y * 2.2, z * 2.2, 41, 7);
    if (h < 0.5 || Math.abs(lat) > 1.15) return [0, 0, 0];
    const coast = h < 0.54 ? 1.6 : 1;
    const city = fbm(x * 38, y * 38, z * 38, 201, 3) * coast * (1 - Math.abs(lat) / 1.4);
    const sparkle = hash(Math.floor(x * 400), Math.floor(y * 400), Math.floor(z * 400), 7) > 0.93 ? 0.6 : 0;
    const v = clamp01((city - 0.42) * 3) + (city > 0.35 ? sparkle : 0);
    return [255 * v, 205 * v, 130 * v];
  });
  cache.set('earth-night', tex);
  return tex;
}

export function ringTexture() {
  const w = 512;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = 4;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < w; i++) {
    const t = i / w;
    let a = 0.25 + fbm(t * 40, 0.5, 0.5, 3, 4) * 0.75;
    if (t > 0.58 && t < 0.64) a *= 0.12; // Cassini division
    if (t < 0.05 || t > 0.97) a *= 0.2;
    const c = mixc([170, 150, 120], [235, 220, 190], fbm(t * 25, 1, 1, 8, 3));
    ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
    ctx.fillRect(i, 0, 1, 4);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft round glow used for halos, markers and particles.
export function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.25)') {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.2, mid);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}
