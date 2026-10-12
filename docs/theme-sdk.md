# World Theme SDK

A **world theme** changes how the canvas world *looks and sounds*. It never changes layout, save state, or behavior: rooms, tunnels, the lift, agents, Lidia and the horde all follow exactly the same rules in every theme.

Files:

| File | Role |
| --- | --- |
| `public/js/world-themes.js` | Registry `WORLD_THEMES`, `applyWorldTheme(id)`, settings listener, colorblind filters |
| `public/js/sound.js` | WebAudio synth (ambient loops + effects). Off by default. No audio files. |
| `public/a11y.css` | Reduced motion, colorblind filter hookup, focus rings, high contrast |
| `public/js/game.js` | Calls into the registry at each draw point (marked `[world-theme hook]`) |

Built-in ids: `fortress` (default, original art), `spaceship`, `westernTown`, `pirateCove`, `cyberpunk`.

## How it plugs in

`game.js` asks `activeTheme()` once per draw. It returns `null` for `fortress`, so the original code path runs untouched and stays pixel-identical. For any other theme, each draw function hands off to the theme's hook and returns early.

```
draw() ── earth ─ surface ─ defense(wall, enemies, defenders) ─ ambient('back')
       ── tunnels ─ ladders ─ shaft ─ pockets ─ rooms ─ dig slot
       ── Lidia + agents ─ ambient('front') ─ crossfade overlay
```

All coordinates are **world coordinates** (the camera transform is already applied). Ground level is `y = 0`; the underground grows downward. Never draw outside the shapes you are given, except `earth`/`surface` which cover x in [-6000, 6000].

## The theme object

```js
{
  id: 'myTheme', label: 'My Theme',
  palette: {           // tokens used by the shared shells (room frame, label plate, floors...)
    void, accent, muted, text, plate, plateText,
    floor, floorGroove, floorTop, tunnel, ladder, ladderBack,
    statusOn, statusOff, alertRGB: '255,60,60',       // 'r,g,b' for alert washes
    ui, bg                                            // mirrored to --world-accent / --world-bg
  },
  fonts: { title, body, google: 'Family+One&family=Family+Two' },   // CSS font stacks; `google` is the css2 query
  lidiaName: 'CAPTAIN', lidiaColor: '#ff6a5a', enemyName: 'Undead',
  roomLabels: { workshop, library, server, lab, hall, garage, vault },   // display names only
  fixedLabels: { comms, command },
  digText: ['+ NEW CABIN', 'sub line'],
  pocketNames: { generator, pumps, water },
  agentSkin / enemySkin / defenderSkin: { color, alpha, mode: 'color' },  // recolor the existing sprite sheets

  // ---- art hooks (all take the canvas ctx first) ----
  earth(ctx, x0, x1, y1, now)            // everything below ground
  surface(ctx, now)                      // sky, skyline, ground strip (y -1100..10)
  wall(ctx, W, H)                        // one barricade, origin = base centre, x in [-W/2, W/2], up is -y, mirrored for the left side
  shaft(ctx, bottom, G, now)             // the lift; G = { SLAB, TUNNEL_H, SHAFT_W, roomBottom(level) }
  tunnelDecor(ctx, x, w, y0, y1, now)    // inside a tunnel (shell supplies floor + dark backing)
  pocketDecor(ctx, p, now)               // utility pocket interior; p.kind is generator|pumps|water
  roomBody(ctx, r, type, now)            // room interior, clipped to r; type is the room type
  lidiaAnims()                           // { walk, idle, command } -> 6 canvases each, ~18x30 art px
  portrait()                             // 44x56 canvas for the dialogue portrait (art.portrait)
  ambient(ctx, view, now, layer)         // 'back' (over the world, under rooms) or 'front'; view = {x0,y0,x1,y1}
  soundSpec                              // see sound.js
}
```

The shared shells (`roomShell`, `tunnelShell`, `pocketShell`, `ladderShell`, `digShell`) are added by `finish(T)`, so a theme only supplies the parts above. To take over completely, define `room`, `tunnel`, `pocket`, `ladder` or `dig` yourself *after* `finish()` (or skip `finish()` and write all hooks).

### Rules for hooks

- **Be stateless.** Derive animation from `now` (ms) and a hash of position, not from mutable globals. `now` is frozen at 350 when reduced motion is on, so a stateless hook automatically goes static.
- **Cache heavy art.** Draw repeating textures once into a tile (`tiled(...)`), build sprite sets once (`lidiaAnims` is memoized by `finish`).
- **Same shapes, same hit boxes.** Room rectangles, tunnel lengths and Lidia's size come from the layout; do not resize anything.
- **Alerts must stay readable.** Rooms with a problem get the `alertRGB` wash and the blinking light from the shell; the exclamation badge is drawn by game.js on top.
- **No external images.** Everything is canvas drawing. (A hand-drawn pass can later replace any single hook with an `Image` blit; the registry is per-id, so one theme can ship art without touching the others.)

## Adding a theme

1. Copy one entry in `world-themes.js` (for example `PIRATE`), change `id`, `label`, palette, labels and hooks.
2. Wrap it: `finish(MYTHEME)`.
3. Register it in `WORLD_THEMES`.
4. Add the id to `WORLD_THEMES` in `server/store.js` so settings validation accepts it, and to the settings picker in the UI.
5. Test: `window.setWorldTheme('myTheme')` in the console.

Checklist before shipping: all 8 room types render, label plates stay legible, Lidia sprite reads at 3x scale, nothing draws over the lift, reduced motion is static, and the sound spec is quiet (master <= 0.55).

## Runtime API

```js
import { WORLD_THEMES, applyWorldTheme, applySettings, onWorldTheme, currentTheme } from './world-themes.js';
window.setWorldTheme('spaceship');          // also exposed globally
window.applyWorldSettings({ worldTheme, reduceMotion, colorblind, soundOn });
window.addEventListener('fortress-world-theme', e => e.detail.id);   // fired after every switch
```

`applyWorldTheme` takes a snapshot of the canvas and crossfades it out over 600 ms (skipped when reduced motion). It also sets `data-world-theme` on `<html>` and `<body>`, and the CSS variables `--world-accent`, `--world-bg`, `--world-text`, `--world-font-title`, `--world-font-body` for HUD styling. It never touches the chat `--t-*` variables, so chat color and style choices stay independent.

The dialogue portrait (`art.portrait`) is an accessor: it returns the theme's portrait while a theme is active and the original otherwise, so any code that reads `art.portrait` at draw time follows the theme.

### Settings event

```js
window.dispatchEvent(new CustomEvent('fortress-settings', { detail: { settings } }));
```

`world-themes.js` listens and applies any of: `worldTheme`, `reduceMotion` (also honours the OS setting), `colorblind` (`none|protanopia|deuteranopia|tritanopia`), `soundOn`.

## Sound

`sound.js` turns a declarative `soundSpec` into drones (oscillators), noise beds (filtered looping noise with LFO swell) and random one-shot events:

```js
soundSpec: {
  master: 0.5,
  drones: [{ type: 'sine', freq: 55, gain: 0.07, detune: 5, lfo: { rate: 0.07, depth: 0.35 } }],
  noise:  [{ color: 'brown', gain: 0.1, filter: { type: 'lowpass', freq: 520 }, lfo: { rate: 0.1, depth: 0.7 } }],
  events: [{ fx: 'creak', every: [5, 13], gain: 0.09 }],      // seconds, random in range
  ui:     { click: 'drip', message: 'bell', alert: 'alarm', done: 'bell' },
}
```

One-shot effects available: `drip thump creak blip chime zap alarm gust gull bell glitch ping clop honk`. Add more in `FX` in `sound.js`.

Sound is **off by default** and only starts when `soundOn` is true *and* the browser has seen a user gesture (autoplay policy). It pauses when the tab is hidden. UI code can call `window.fortressSound.play('click' | 'message' | 'alert' | 'done')`.

## Accessibility

- `html.reduce-motion` / `body.reduce-motion` (settings) and `prefers-reduced-motion` (OS) cut CSS animation, skip the theme crossfade, snap camera flights, and freeze canvas flicker (alerts stay in their visible state).
- `body[data-colorblind=...]` applies an SVG `feColorMatrix` correction (Machado dichromat model + channel shift) to each top-level layer. The `<filter>` definitions are injected by `world-themes.js`.
- `:focus-visible` rings use `--world-accent`, `prefers-contrast: more` and `forced-colors` have tweaks, and coarse pointers get 40px minimum targets.
