// Saves are snapshots of state (positions, velocities, masses), not recordings, so they stay small:
// a few KB for the bodies, plus ~60 KB if the asteroid belt is included.

export function buildSave(sim, settings) {
  return { app: 'solar-system-sim', version: 1, savedAt: new Date().toISOString(), settings, sim: sim.serialize() };
}

export function downloadJSON(data, name) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return blob.size;
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(validate(JSON.parse(r.result))); } catch (e) { reject(e); } };
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function validate(data) {
  if (!data || !['solar-system-sim', 'solar-god-mode'].includes(data.app) || !data.sim || !Array.isArray(data.sim.bodies)) throw new Error('This is not a Heliosling save file.');
  for (const b of data.sim.bodies) {
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'mass']) if (typeof b[k] !== 'number' || !isFinite(b[k])) throw new Error('Save file has a broken body.');
    b.name = String(b.name || 'Body').slice(0, 40);
    b.tagline = String(b.tagline || '').slice(0, 80);
    b.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#999999';
  }
  return data;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// Share links carry the whole universe (minus the belt) in the URL hash, deflated.
export async function encodeShare(save) {
  const lite = { ...save, sim: { ...save.sim, belt: null, events: save.sim.events.slice(-30) } };
  const bytes = new TextEncoder().encode(JSON.stringify(lite));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(bytes);
  return 'z' + b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decodeShare(code) {
  const kind = code[0], data = fromB64url(code.slice(1));
  const bytes = kind === 'z' ? await pipe(data, new DecompressionStream('deflate-raw')) : data;
  return validate(JSON.parse(new TextDecoder().decode(bytes)));
}

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
