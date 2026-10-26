// Monochrome line icons (Lucide-style: 24px grid, 1.5px stroke, currentColor), so the UI
// doesn't lean on system emoji.
const paths = {
  bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  rewind: '<path d="M11 19l-9-7 9-7z"/><path d="M22 19l-9-7 9-7z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  replay: '<path d="M6 4l12 8-12 8z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  ghost: '<ellipse cx="12" cy="12" rx="9.5" ry="6" stroke-dasharray="2.6 2.4"/><circle cx="12" cy="12" r="1.6"/><circle cx="20" cy="9" r="0.9" stroke-width="3"/>',
  share: '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
};
export const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

// A small CSS-rendered body for the launcher cards: a lit sphere from radial gradients, with a
// ring, tail or glow where the object has one.
export function orb(spec) {
  const k = spec.type;
  const cls = k === 'giant' ? 'ringed' : k === 'comet' ? 'tailed' : k === 'blackhole' ? 'hole' : spec.kind === 'star' || k === 'neutron' ? 'star' : k === 'asteroid' ? 'rock' : '';
  return `<span class="orb ${cls}" style="--c:${k === 'blackhole' ? '#ff9a4a' : spec.color}"></span>`;
}
