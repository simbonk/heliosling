import { KMS_PER_AUYR } from './data.js';

const INNER = ['mercury', 'venus', 'earth', 'mars'];
const PLANET_IDS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const byId = (sim, id) => sim.bodies.find((b) => b.id === id);

// Each mission: setup(game, m) prepares the universe; onEvent / tick return 'win' or 'fail'.
export const MISSIONS = [
  {
    id: 'bullseye', title: 'Bullseye', level: 'Easy', suggest: 'asteroid', speed: 0.5,
    desc: 'Hit Earth with something launched from beyond the orbit of Mars.',
    tip: 'Launch from outside the red ring, then watch the ghost line for IMPACT PREDICTED.',
    onEvent(ev, g) {
      if (ev.kind !== 'impact') return;
      const other = ev.a === 'earth' ? byId(g.sim, ev.b) : ev.b === 'earth' ? byId(g.sim, ev.a) : null;
      if (other?.spawned && other.launch?.sunDist > 1.6) return 'win';
    },
    status: () => 'Launch from > 1.6 AU and hit Earth',
  },
  {
    id: 'boil', title: 'Boil the Oceans', level: 'Easy', suggest: 'star', speed: 1,
    desc: "Push Earth's temperature past 100 °C for half a year. Mwahaha.",
    tip: 'A second sun parked near Earth does the trick. So does nudging Earth inward.',
    onEvent(ev) { if (ev.kind === 'climate' && ev.what === 'boiled') return 'win'; },
    status: (g) => (g.sim.climate ? `Earth: ${g.sim.climate.T.toFixed(0)} °C` : 'Earth is gone'),
    tick(g) { if (!g.sim.get('earth')) return 'fail'; },
  },
  {
    id: 'kingslayer', title: 'Kingslayer', level: 'Easy', suggest: 'blackhole', speed: 0.5,
    desc: 'Feed the Sun to something bigger than it.',
    tip: 'Black holes and neutron stars are heavier than the Sun.',
    onEvent(ev) { if (ev.kind === 'impact' && ev.b === 'sun') return 'win'; },
    status: () => 'Swallow the Sun',
  },
  {
    id: 'deflect', title: 'Deflect the Killer Asteroid', level: 'Medium', suggest: 'asteroid', speed: 0.12,
    desc: 'An asteroid will hit Earth in about 7 months. Knock it off course, or pull it aside with gravity, without hitting Earth yourself.',
    tip: 'Hit the asteroid head-on, or park something heavy near its path. Press play when ready.',
    setup(g, m) {
      const earth = g.sim.get('earth');
      const years = 0.6;
      const vRel = 24 / KMS_PER_AUYR;
      const spec = { type: 'asteroid', name: 'Killer Asteroid', kind: 'rock', mass: 5e-13, radiusKm: 200, color: '#ff5a4a', blurb: 'Inbound. Do something.' };
      // earth's future state, then rewind the asteroid from there; keep the first approach that truly hits
      const future = g.sim.predict({ ...earth, mass: 0, id: '__probe', x: earth.x + 500 }, years, 4).clones.find((b) => b.id === 'earth');
      let start = null;
      for (let k = 0; k < 8 && !start; k++) {
        const ang = Math.random() * Math.PI * 2;
        const dir = { x: Math.cos(ang), y: 0.15, z: Math.sin(ang) };
        const n = Math.hypot(dir.x, dir.y, dir.z);
        dir.x /= n; dir.y /= n; dir.z /= n;
        const arrive = { x: future.x - dir.x * 0.004, y: future.y - dir.y * 0.004, z: future.z - dir.z * 0.004, vx: future.vx + dir.x * vRel, vy: future.vy + dir.y * vRel, vz: future.vz + dir.z * vRel };
        const cand = g.sim.rewind(spec, arrive, years);
        const check = g.sim.predict({ ...spec, id: '__check', ...cand }, years + 0.1, 10);
        if (check.hit?.id === 'earth' || k === 7) start = cand;
      }
      const k = g.sim.addBody(spec, start);
      k.hostile = true;
      m.killer = k.id;
      m.deadline = g.sim.t + years + 0.35;
    },
    onEvent(ev, g, m) {
      if (ev.kind === 'impact' && (ev.a === 'earth' || ev.b === 'earth')) return 'fail';
    },
    tick(g, m) {
      if (!g.sim.get('earth')) return 'fail';
      if (g.sim.t > m.deadline) return 'win';
    },
    status: (g, m) => {
      const left = m.deadline - 0.35 - g.sim.t;
      return left > 0 ? `Impact in ${(left * 12).toFixed(1)} months` : 'Hold on...';
    },
  },
  {
    id: 'bank', title: 'Bank Shot', level: 'Hard', suggest: 'asteroid', speed: 1,
    desc: "Slingshot something off Jupiter's gravity (pass within 1 AU) so that it then hits Saturn.",
    tip: 'Launch near Jupiter and let its pull swing the path outward.',
    tick(g) {
      const j = g.sim.get('jupiter');
      if (!j) return 'fail';
      for (const b of g.sim.bodies) if (b.alive && b.spawned && dist(b, j) < 1) b.jupiterPass = true;
    },
    onEvent(ev, g) {
      if (ev.kind !== 'impact') return;
      if (ev.a === 'jupiter' && byId(g.sim, ev.b)?.spawned) return;
      const other = ev.a === 'saturn' ? byId(g.sim, ev.b) : ev.b === 'saturn' ? byId(g.sim, ev.a) : null;
      if (other?.spawned && other.jupiterPass) return 'win';
    },
    status: (g) => (g.sim.bodies.some((b) => b.spawned && b.jupiterPass && b.alive) ? 'Jupiter assist done. Now hit Saturn!' : 'Pass within 1 AU of Jupiter'),
  },
  {
    id: 'thief', title: 'Star Thief', level: 'Hard', suggest: 'reddwarf', speed: 6,
    desc: 'Fly a star past the outer system and steal Neptune into orbit around it, while Mercury, Venus, Earth and Mars stay with the Sun.',
    tip: 'Aim a red dwarf to graze Neptune at a gentle speed (5 to 15 km/s).',
    tick(g, m) {
      const s = g.sim;
      for (const id of INNER) {
        const p = s.get(id);
        if (!p || p.orbit?.star !== 'sun' || !p.boundToSun) return 'fail';
      }
      const n = s.get('neptune');
      if (!n) return 'fail';
      if (n.orbit?.star && n.orbit.star !== 'sun' && n.boundToSun) {
        m.since ??= s.t;
        if (s.t - m.since > 3) return 'win';
      } else m.since = null;
    },
    status: (g, m) => (m.since != null ? `Neptune captured! Holding ${(g.sim.t - m.since).toFixed(1)} / 3 yr` : 'Steal Neptune'),
  },
  {
    id: 'moonmaker', title: 'Moon Maker', level: 'Expert', suggest: 'moon', speed: 1,
    desc: 'Give Jupiter a new moon. It must be launched from more than 1.5 AU away from Jupiter.',
    tip: 'Captures need a third body to steal energy. Try threading close to Jupiter at low relative speed.',
    onEvent(ev, g) {
      if (ev.kind === 'moon' && ev.host === 'jupiter') {
        const b = byId(g.sim, ev.a);
        if (b?.spawned && b.launch?.dist?.jupiter > 1.5) return 'win';
      }
    },
    tick(g) { if (!g.sim.get('jupiter')) return 'fail'; },
    status: () => 'Capture a moon for Jupiter',
  },
];

export function starsFor(shots) { return shots <= 1 ? 3 : shots <= 3 ? 2 : 1; }

export const ACHIEVEMENTS = [
  { id: 'first_shot', icon: '🎱', title: 'Prime Mover', desc: 'Launch your first object.' },
  { id: 'impact', icon: '💥', title: 'Contact', desc: 'Witness a collision.' },
  { id: 'planet_killer', icon: '☠️', title: 'Planet Killer', desc: 'Destroy a planet.' },
  { id: 'horizon', icon: '🕳️', title: 'Event Horizon', desc: 'Watch a black hole eat something.' },
  { id: 'binary', icon: '♊', title: 'Binary', desc: 'Have two stars at once.' },
  { id: 'capture', icon: '🧲', title: "Gravity's Grip", desc: 'Get a launched object captured into orbit.' },
  { id: 'escape', icon: '🚀', title: 'Exit Velocity', desc: 'Throw something out of the solar system.' },
  { id: 'moon', icon: '🌙', title: 'Moon Maker', desc: 'Turn a launched object into a moon.' },
  { id: 'boiled', icon: '🔥', title: 'Hothouse', desc: "Boil Earth's oceans." },
  { id: 'frozen', icon: '🧊', title: 'Snowball', desc: 'Freeze Earth solid.' },
  { id: 'time_lord', icon: '⏳', title: 'Time Lord', desc: 'Simulate 1,000 years in one universe.' },
  { id: 'speed_demon', icon: '⚡', title: 'Speed Demon', desc: 'Launch faster than 500 km/s.' },
  { id: 'sharer', icon: '🔗', title: 'Show-off', desc: 'Copy a share link.' },
  { id: 'tourist', icon: '🌌', title: 'Galactic Tourist', desc: 'Ride the Milky Way view all the way to today.' },
  { id: 'all_missions', icon: '👑', title: 'Demiurge', desc: 'Complete every trick shot.' },
];

// Map simulation events to achievement ids.
export function achievementsForEvent(ev, sim) {
  const out = [];
  if (ev.kind === 'impact') {
    out.push('impact');
    if (PLANET_IDS.includes(ev.b) || (PLANET_IDS.includes(ev.a) && ev.ratio > 0.5)) out.push('planet_killer');
    if (ev.aKind === 'blackhole') out.push('horizon');
  }
  if (ev.kind === 'capture') out.push('capture');
  if (ev.kind === 'escape') out.push('escape');
  if (ev.kind === 'moon' && ev.spawned) out.push('moon');
  if (ev.kind === 'climate' && ev.what === 'boiled') out.push('boiled');
  if (ev.kind === 'climate' && ev.what === 'frozen') out.push('frozen');
  if (ev.kind === 'spawn' && sim.bodies.filter((b) => b.alive && b.kind === 'star').length >= 2) out.push('binary');
  return out;
}

// Human sentence for the chronicle feed.
export function describe(ev) {
  switch (ev.kind) {
    case 'spawn': return { icon: '✨', text: `${ev.name} entered the system` };
    case 'impact': {
      const verb = ev.aKind === 'blackhole' ? 'swallowed' : ev.aKind === 'star' ? 'engulfed' : ev.ratio > 0.3 ? 'merged with' : 'was struck by';
      if (verb === 'was struck by') return { icon: '💥', text: `${ev.aName} was struck by ${ev.bName} at ${(ev.relV * KMS_PER_AUYR).toFixed(0)} km/s` };
      return { icon: ev.aKind === 'blackhole' ? '🕳️' : '💥', text: `${ev.aName} ${verb} ${ev.bName}` };
    }
    case 'escape': return { icon: '🚀', text: `${ev.name} escaped into interstellar space` };
    case 'capture': return { icon: '🧲', text: `${ev.name} was captured by ${ev.star}` };
    case 'moon': return { icon: '🌙', text: `${ev.name} became a moon of ${ev.hostName}` };
    case 'climate':
      return ev.what === 'boiled' ? { icon: '🔥', text: "Earth's oceans boiled away" }
        : ev.what === 'frozen' ? { icon: '🧊', text: 'Earth froze into a snowball' }
        : { icon: '🌍', text: "Earth's climate recovered" };
    default: return { icon: '•', text: ev.kind };
  }
}
