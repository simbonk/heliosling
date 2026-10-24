// Units used throughout the simulation: AU, years, solar masses.
export const G = 4 * Math.PI * Math.PI;
export const KM_PER_AU = 1.495978707e8;
export const KMS_PER_AUYR = 4.740470463; // 1 AU/yr in km/s
export const START_YEAR = 2000;

// J2000 mean orbital elements (JPL "Keplerian Elements for Approximate Positions").
// a [AU], e, I [deg], L mean longitude [deg], varpi longitude of perihelion [deg], Omega node [deg]
export const PLANETS = [
  { id: 'mercury', name: 'Mercury', tagline: 'Tight & fast', mass: 1.6601e-7, radiusKm: 2440, color: '#b5aca2', tex: 'mercury',
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593] },
  { id: 'venus', name: 'Venus', tagline: 'Hellish greenhouse', mass: 2.4478e-6, radiusKm: 6052, color: '#e8c58a', tex: 'venus',
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255] },
  { id: 'earth', name: 'Earth', tagline: 'You are here', mass: 3.0404e-6, radiusKm: 6371, color: '#4f8fe0', tex: 'earth',
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0] },
  { id: 'mars', name: 'Mars', tagline: 'The red one', mass: 3.2271e-7, radiusKm: 3390, color: '#d0623d', tex: 'mars',
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891] },
  { id: 'jupiter', name: 'Jupiter', tagline: 'The bully', mass: 9.5479e-4, radiusKm: 69911, color: '#d8a878', tex: 'jupiter',
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909] },
  { id: 'saturn', name: 'Saturn', tagline: 'Wide rings', mass: 2.8589e-4, radiusKm: 58232, color: '#e3cf9a', tex: 'saturn', rings: true,
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448] },
  { id: 'uranus', name: 'Uranus', tagline: 'Rolling on its side', mass: 4.3662e-5, radiusKm: 25362, color: '#9fd8e0', tex: 'uranus',
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503] },
  { id: 'neptune', name: 'Neptune', tagline: 'Far & windy', mass: 5.1514e-5, radiusKm: 24622, color: '#3f62d8', tex: 'neptune',
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574] },
  { id: 'pluto', name: 'Pluto', tagline: 'Still counts to us', mass: 6.58e-9, radiusKm: 1188, color: '#c9b39b', tex: 'pluto',
    el: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684] },
];

export const SUN = { id: 'sun', name: 'Sun', tagline: 'G2V star', mass: 1, radiusKm: 696340, color: '#ffcc66', kind: 'star', luminosity: 1, tex: 'sun' };

// Things you can throw at the solar system. mass in solar masses.
export const SPAWNABLES = [
  { type: 'asteroid', name: 'Asteroid', icon: '🪨', mass: 1e-12, radiusKm: 120, color: '#9a8f84', kind: 'rock', blurb: 'A city-killer chunk of rock.' },
  { type: 'comet', name: "Halley's Comet", icon: '☄️', mass: 1.1e-16, radiusKm: 60, color: '#bfe8ff', kind: 'comet', blurb: 'Icy wanderer with a glowing tail.' },
  { type: 'moon', name: 'Rogue Moon', icon: '🌑', mass: 3.69e-8, radiusKm: 1737, color: '#cfcac2', kind: 'rock', blurb: 'A Moon-sized stray. Can you make it orbit Earth?' },
  { type: 'planet', name: 'Rogue Earth', icon: '🌍', mass: 3.0e-6, radiusKm: 6371, color: '#6fa86a', kind: 'planet', blurb: 'An Earth-mass world with no home.' },
  { type: 'giant', name: 'Super-Jupiter', icon: '🪐', mass: 9.5e-3, radiusKm: 80000, color: '#c99a6b', kind: 'planet', blurb: 'Ten Jupiters of gas. Reshuffles orbits.' },
  { type: 'browndwarf', name: 'Brown Dwarf', icon: '🟤', mass: 0.05, radiusKm: 70000, color: '#a0522d', kind: 'star', luminosity: 0.00001, blurb: 'A failed star, 50 Jupiters heavy.' },
  { type: 'reddwarf', name: 'Red Dwarf', icon: '🔴', mass: 0.15, radiusKm: 140000, color: '#ff6b4a', kind: 'star', luminosity: 0.003, blurb: 'Small, cool, and very common star.' },
  { type: 'star', name: 'Sun Twin', icon: '🌟', mass: 1.0, radiusKm: 696340, color: '#fff1c9', kind: 'star', luminosity: 1, blurb: 'Make it a binary system.' },
  { type: 'neutron', name: 'Neutron Star', icon: '💠', mass: 1.4, radiusKm: 12, color: '#b9d7ff', kind: 'neutron', luminosity: 0, blurb: 'A city-sized atomic nucleus.' },
  { type: 'blackhole', name: 'Black Hole', icon: '⚫', mass: 10, radiusKm: 30, color: '#000000', kind: 'blackhole', luminosity: 0, blurb: 'Ten suns of pure appetite.' },
];

// Display radius in AU. "visible" exaggerates sizes so they can be seen at system scale
// without overlapping the inner orbits. "real" uses true radii.
export function displayRadius(body, scaleMode) {
  if (body.kind === 'blackhole') {
    const base = 0.06 * Math.cbrt(body.mass / 10);
    return scaleMode === 'real' ? Math.max(base * 0.08, 2 * 2.95 * body.mass / KM_PER_AU) : base;
  }
  if (body.kind === 'neutron') return scaleMode === 'real' ? 12 / KM_PER_AU : 0.012;
  if (scaleMode === 'real') return body.radiusKm / KM_PER_AU;
  const r = 0.03 * Math.pow(body.radiusKm / 6371, 0.42);
  return Math.min(Math.max(r, 0.006), body.kind === 'star' ? 0.2 : 0.12);
}
