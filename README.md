# Solar System Physics Simulator

The solar system in your browser, running on real N-body gravity and starting from where the planets are today. Launch anything from an asteroid to a black hole at it, and watch the Sun's corkscrew ride through the Milky Way. Mobile first, works on desktop too.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

### Deploy on Vercel

Import the repo in Vercel. It detects Vite automatically (`vercel.json` pins `npm run build` → `dist/`). No environment variables, no backend.

## What's in it

**Views**
- **Helix** (default): the whole system drifts through the galaxy at ~60° to the planets' plane, so every orbit becomes a corkscrew. Drift speed is adjustable up to the real 230 km/s.
- **Solar**: Sun-centred (or inertial, in settings). Contrails show the familiar ellipses.
- **Milky Way**: the Sun's 230-million-year lap around Sagittarius A*, with Earth's great extinctions pinned where the Sun was when they happened.

**Launching things** (a two-step wizard built for touch)
1. Pick an object from the bar (asteroid, Halley's Comet, rogue Moon/Earth, Super-Jupiter, brown dwarf, red dwarf, Sun twin, neutron star, black hole).
2. **Place**: tap exactly where it should start.
3. **Aim & launch**: drag the knob around the ring to point it, and outward or inward to set the speed. With the knob on the ring the object goes into a circular orbit around whatever dominates that spot. The dashed ring is escape speed, and the centre stops it dead; the knob snaps to each. Drag the centre to nudge the object. A ghost trajectory shows where it will go and flags impacts. Optional tilt out of the planets' plane. The view backs out so the ring is never hidden behind the controls.

**Rewind** winds time back about six seconds of play per press (contrails shrink as it goes), then plays forward again. **Undo** returns to the moment before your last launch with the aim intact. **Reset** (top bar) offers to save the run as JSON first. Tapping a view tab (even the current one) returns to that view's home camera and default time speed. **Centred on ▾** keeps the camera on the Sun, Earth, or anything else, with tilted, top-down, and ride-along angles.

**Engagement**
- 7 challenges with 1–3 stars (fewer shots, more stars), including a killer asteroid you must deflect and a red dwarf heist to steal Neptune.
- An Earth badge shows its temperature and whether it is still in the habitable zone (the zone itself can be drawn as a band from Layers).
- 15 achievements and a live system stability index.
- An event log (top right) collects everything that happens instead of popping messages over the action. Every collision in it has a **Replay** button that re-runs the last few seconds before it as a cut scene: full resolution, stronger glow, denser debris, letterbox bars with the HUD hidden, a side-on camera that slowly circles in, and slow motion into the moment of impact. Then it returns to the present.
- Auto slow-mo when a launched object has a close call, camera shake on impacts, procedural WebAudio sound (drone that pitches with time warp, cue ratchet, impact boom).

**Visuals** (all procedural, no image assets)
- Canvas-generated planet textures, Earth day/night shader with city lights and an atmospheric rim, Saturn's rings, black hole accretion disk plus screen-space gravitational lensing, tidal stretching near black holes, bloom.
- Layers: gravity-well "rubber sheet" grid (on by default), contrails, labels, habitable zone, true scale. Plus label decluttering.
- Impacts scale with the collision's real kinetic energy: a fireball at the contact point, an ejecta curtain thrown downrange that falls back and glows, a shock front, a temporary debris ring for giant impacts, and infalling streamers for black holes. The event log compares the energy to the dinosaur-killing Chicxulub impact.

## Answers to the design questions

**Are the planets too small to see next to the Sun?** At true scale, yes: Earth is a speck 1/109th the Sun's width, and both vanish at solar-system distances. The default **visible scale** exaggerates radii on a compressed curve (Earth ≈ 1/5 of the Sun instead of 1/109) while keeping distances and masses real, so the physics stays honest. The **True scale** layer switches to true radii; glowing markers and labels keep every body findable. Collisions use the size you see, so hits are much rarer at true scale.

**Should saves be JSON?** Yes, and they're small. Reset asks whether to save first. A save is a snapshot of state (masses, positions, velocities), not a recording: a few KB for the bodies plus ~60 KB if the asteroid belt is included. Share links pack the same snapshot (minus the belt) into the URL hash with deflate compression, around 2–3 KB. The browser also autosaves every 15 seconds and offers to resume.

## Physics notes

- Units: AU, years, solar masses (G = 4π²). Planets start from JPL's J2000 mean orbital elements and are integrated forward to today's date at load.
- Integrator: kick-drift-kick leapfrog with a global adaptive timestep (2.5% of the shortest pairwise dynamical time). Energy drifts about 3×10⁻⁶ over 100 simulated years.
- Collisions merge bodies with momentum conserved; a black hole always wins.
- The asteroid belt is made of test particles pulled by the heavy bodies.
- The killer-asteroid mission is built by integrating the system backwards from the impact (leapfrog is time-reversible), so the threat is always a real collision course.

## Code map

| File | What it does |
| --- | --- |
| `src/physics.js` | N-body sim, collisions, captures, escapes, climate, stability, predictions, save/load |
| `src/data.js` | Planet elements, spawnable catalogue, display scaling |
| `src/render.js` | Renderer, bodies, contrails, belt, space dust, effects |
| `src/shaders.js` | Lensing pass, Earth day/night material, gravity-well grid |
| `src/textures.js` | Procedural planet, ring, night-light and glow textures |
| `src/aim.js` | Launch wizard, aiming dial and ghost trajectory |
| `src/galaxy.js` | Milky Way view |
| `src/missions.js` | Challenges, achievements, event wording |
| `src/audio.js` | WebAudio synth |
| `src/save.js` | JSON files, share links, local storage |
| `src/main.js` | App state, camera rig, HUD wiring, main loop |
