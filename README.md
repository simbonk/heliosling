# God Mode · Solar System Sandbox

Play god with the solar system in the browser. Real N-body gravity, pool-cue launches from asteroids to black holes, and the Sun's corkscrew ride through the Milky Way. Mobile first, works great on desktop.

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
- **Solar**: Sun-centred (or inertial, in settings). Contrails show the familiar ellipses.
- **Helix**: the same live simulation, but the whole system drifts through the galaxy at ~60° to the planets' plane, so every orbit becomes a corkscrew. Drift speed is adjustable up to the real 230 km/s.
- **Milky Way**: the Sun's 230-million-year lap around Sagittarius A*, with Earth's great extinctions pinned where the Sun was when they happened.

**Playing god**
- Pick from the arsenal (asteroid, Halley's Comet, rogue Moon/Earth, Super-Jupiter, brown dwarf, red dwarf, Sun twin, neutron star, black hole).
- Tap empty space to place it, then drag back from it like a pool cue and let go. A ghost trajectory shows where it will go and flags **IMPACT PREDICTED**. Tap the object instead to drop it into a circular orbit. Shift-drag (or the Tilt slider) aims out of the plane; arrow keys or the ⟲ ⟳ − + buttons nudge the shot.
- **⏮ Rewind** restores the moment before your last shot with the aim intact.
- **⏹ Stop** asks whether to save the universe as JSON, copy a share link, or discard it.
- Tap a body for live stats, follow it, ride along with it, or smite it.

**Making it sticky**
- 7 trick-shot missions with 1–3 stars (fewer shots, more stars), including a killer asteroid you must deflect and a red dwarf heist to steal Neptune.
- 15 achievements, a running chronicle of what you caused, a live system stability index, and Earth's temperature on its label.
- Auto slow-mo when a launched object has a close call, camera shake on impacts, procedural WebAudio sound (drone that pitches with time warp, cue ratchet, impact boom).

**Visuals** (all procedural, no image assets)
- Canvas-generated planet textures, Earth day/night shader with city lights and an atmospheric rim, Saturn's rings, black hole accretion disk plus screen-space gravitational lensing, tidal stretching near black holes, bloom.
- Gravity-well "rubber sheet" grid (G), habitable-zone band (H), radar mini-map, label decluttering.

## Answers to the design questions

**Are the planets too small to see next to the Sun?** At true scale, yes: Earth is a speck 1/109th the Sun's width, and both vanish at solar-system distances. The default **visible scale** exaggerates radii on a compressed curve (Earth ≈ 1/5 of the Sun instead of 1/109) while keeping distances and masses real, so the physics stays honest. The **1:1** toggle switches to true radii; glowing markers and labels keep every body findable. Collisions use the size you see, so hits are much rarer at true scale.

**Should saves be JSON?** Yes, and they're small. A save is a snapshot of state (masses, positions, velocities), not a recording: a few KB for the bodies plus ~60 KB if the asteroid belt is included. Share links pack the same snapshot (minus the belt) into the URL hash with deflate compression, around 2–3 KB. The browser also autosaves every 15 seconds and offers to resume.

## Physics notes

- Units: AU, years, solar masses (G = 4π²). Planets start from JPL's J2000 mean orbital elements.
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
| `src/aim.js` | Pool-cue launcher and ghost trajectory |
| `src/galaxy.js` | Milky Way view |
| `src/missions.js` | Trick shots, achievements, event wording |
| `src/audio.js` | WebAudio synth |
| `src/save.js` | JSON files, share links, local storage |
| `src/main.js` | App state, camera rig, HUD wiring, main loop |
