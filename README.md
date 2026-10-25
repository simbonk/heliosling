# Heliosling

**Fling worlds at the solar system and watch what happens.**

Grab an asteroid, a rogue Earth, a spare Sun or a black hole, pull back the slingshot, and let go. Gravity
does the rest: near misses that bend into slingshots, captures, ejections, planets swallowed whole, and the
occasional extinction-level fireball. It runs in your browser, works best on a phone, and needs no account.

**Play it:** [heliosling.vercel.app](https://heliosling.vercel.app)

## How to play

1. **Pick something to throw** from the bar at the bottom: asteroid, Halley's Comet, a rogue Moon or Earth,
   a Super-Jupiter, a brown or red dwarf, a Sun twin, a neutron star or a black hole.
2. **Tap where it starts.**
3. **Pull back and let go.** The camera drops in behind the slingshot. Pull further to throw harder, and pull
   to one side to aim the other way. Drag the sky to look around and tip the shot up or down. The solid ring
   is the speed for a neat circular orbit and the dashed ring is escape speed. A ghost path shows where it is going.
4. **Watch.** The camera chases your shot, then plays it back from the side and from above, plus from the
   target's point of view if you hit something. Save the good ones and rewatch them from the 🔖 button.
5. **Share.** Every saved shot has a share button. The link carries the whole shot, so whoever opens it
   watches exactly what you saw, then can keep it.

**Rewind** winds back 10 seconds per press. Anything you launched in that time launches again when the clock
gets back there, so you can watch it twice. **Reset** puts the solar system back to today. New here? The app
offers a quick **tour** on your first visit, and it lives in the menu after that.

## Three ways to look at it

- **Helix:** the Sun is really flying through the galaxy, so every planet traces a corkscrew behind it.
- **Solar:** the classic view from the Sun, with neat ellipses.
- **Milky Way:** the Sun's 230-million-year lap around the galaxy, with Earth's great extinctions pinned
  where we were when they happened.

## Things to try

- Throw a **black hole** through the inner planets and watch it eat them.
- Drop a **Sun twin** nearby and turn the solar system into a binary star.
- Knock **Earth** out of the habitable zone, then try to nudge it back before the oceans boil or freeze.
- Park a **Rogue Moon** right next to Jupiter and give it a moon of its own.
- Not sure where to start? Watch the **trick shots** in the menu, or take the **tour**. Made a good one?
  [Suggest it](https://github.com/simbonk/heliosling/issues/new?title=Trick%20shot%3A%20) with its share link.

## How real is it?

Real enough to be surprising, fake enough to be fun.

**Real:**
- Every body pulls on every other with Newton's gravity.
- The planets start where they actually are in the sky today (from NASA JPL's orbital data).
- Orbits, slingshots, captures and escapes all come out of the maths. None of it is scripted.
- Impact energies are computed and compared to the asteroid that killed the dinosaurs.

**Pseudo-science, on purpose:**
- **Sizes:** planets and the Sun are drawn hundreds of times too big so you can actually see them, and they
  collide at that size. That makes planets juicy targets. At their real size almost everything would miss.
  To see how empty space really is, open the Layers panel (the ◫ button on the right) and turn on
  *True scale*. Planets shrink to their real size, which from this distance is too small to see, so only a
  glowing marker shows where each one is, and hits get much harder.
- **Moons:** because the inner planets are drawn so big, the zone where a moon could orbit them sits inside
  their drawn ball, so Earth can't keep a moon. Jupiter and Saturn are big enough: a moon placed close beside
  them at the right speed will orbit. Real captures, where a passing body falls in and stays, almost never
  happen with gravity alone, here or in real life.
- **Collisions:** two bodies that touch just merge. There are no fragments, rings or tidal shredding.
- **Climate:** Earth's temperature is a one-line toy model based on how much starlight it gets.
- **The Milky Way view:** a pretty schematic, not a real galactic orbit.

## Bugs and ideas

Heliosling is fully open source. Found a bug or have an idea? Use **Menu → Bugs & ideas** in the app, or
[open an issue](https://github.com/simbonk/heliosling/issues). Pull requests are welcome too.

## Run it yourself

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

It's a static Vite site with no backend or environment variables, so it deploys to Vercel (or any static host)
as is.

### Under the hood

- **Stack:** Vite and three.js. Apart from the app icon, there are no image or sound files: every texture,
  shader and sound is generated in the browser.
- **Units:** AU, years and solar masses (G = 4π²).
- **Integrator:** leapfrog with an adaptive timestep. It is time-reversible, which is what makes rewind
  and replays exact.
- **Saves:** small JSON snapshots of masses, positions and velocities, about 5 KB per saved shot. The browser
  also autosaves and offers to resume. Share links are the same snapshot, deflated into the URL (about 2 KB),
  so nothing is stored on a server.
- **Analytics:** anonymous page-view counts through Vercel Web Analytics. No cookies and no accounts.

| File | What it does |
| --- | --- |
| `src/physics.js` | Gravity, collisions, captures, escapes, climate, predictions |
| `src/data.js` | Planets, the things you can throw, display sizes |
| `src/aim.js` | The slingshot, compass and ghost path |
| `src/render.js` | Planets, contrails, asteroid belt, impact effects |
| `src/shaders.js` | Gravitational lensing, Earth's day/night side, gravity-well grid |
| `src/textures.js` | Procedural planet textures |
| `src/galaxy.js` | Milky Way view |
| `src/missions.js` | Event wording and impact-energy comparisons |
| `src/trickshots.json` | The trick shots in the menu |
| `src/ui.js`, `src/icons.js` | Sheets, modals, toasts and line icons |
| `src/audio.js` | Procedural sound |
| `src/save.js` | Save files, share links and local storage |
| `src/main.js` | App state, camera, HUD, tour, rewind and main loop |

## License

[MIT](LICENSE). Use it, fork it, make it weirder.
