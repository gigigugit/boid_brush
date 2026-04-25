# Boid Brush — Repository Instructions

This is a browser-based painting application built with vanilla JS (ES modules), HTML, CSS, and a Rust/WASM boid simulation engine. There is no build step for the JS — files are served directly. The WASM module lives in `wasm-sim/` and its compiled output in `wasm-sim/pkg/`.

---

## File Map

| File | Purpose |
|---|---|
| `app.html` | Single-page shell: all HTML structure, inline CSS, modals, the canvas stack, and `<script type="module">` entry point |
| `app.js` | Core `App` class: canvas/layer management, undo/redo, pointer events, keyboard shortcuts, view transform (zoom/pan/rotate/flip), simulation mode, session persistence |
| `ui.js` | `buildSidebar()` — dynamically builds the right sidebar DOM (collapsible sections, sliders, checkboxes, presets, layers), the Ant Math overlay panel, AI modal/popout, and edge sliders |
| `brushes.js` | Brush engine classes: `BoidBrush`, `AntBrush`, `BristleBrush`, `SimpleBrush`, `EraserBrush`, `AIDiffusionBrush`, `SpawnShapes` |
| `compositor.js` | WebGL2 layer compositor + CSS 2D fallback; exports `Compositor` and `BLEND_MODE_MAP` |
| `selection.js` | `SelectionManager`: rect, ellipse, lasso selection tools + transform handles |
| `ai-server.js` | `AIServer` class: manages connection to local AI diffusion backend |
| `psd-io.js` | PSD import/export (`exportPSD`, `importPSD`) |
| `wasm-sim/` | Rust source for the boid/ant WASM simulation; compiled pkg in `wasm-sim/pkg/` |
| `server/` | Python backend for AI diffusion brush (Flask); `setup.bat`/`setup.sh` for env setup |

---

## UI Architecture

The UI is a fixed-position layout with four zones. **All CSS is inline** in `app.html` `<style>` — there is no external stylesheet.

### 1. Top Bar (`#topbarWrap` + `#topbar`)
The top bar is a two-part structure: a **fixed outer wrapper** (`#topbarWrap`, height: 44px, z-index: 20) that contains the **scrollable inner toolbar** (`#topbar`) and the **always-visible sidebar toggle** (`#sidebarToggle`). The hamburger button is a direct child of `#topbarWrap`, **outside** the scrollable `#topbar`, so it is always pinned to the far right regardless of toolbar scroll position.

**IMPORTANT**: The `#sidebarToggle` button must remain a direct child of `#topbarWrap` and outside `#topbar`. Any changes that add/move buttons in the topbar must not push the hamburger into the scrollable area or obscure it. New topbar buttons go inside `#topbar`, never after the closing `</div>` of `#topbar`.

The scrollable `#topbar` contains buttons and controls in this left-to-right order, separated by `.tb-sep` dividers:

| Element | ID / Selector | Description |
|---|---|---|
| Brush picker | `#brushBtnWrap` > `#brushBtn` | Dropdown trigger showing active brush name+emoji. Opens `#brushDropdown` (a separate fixed div outside topbar). |
| **--- separator ---** | `.tb-sep` | |
| Primary color | `#primaryColor` | `<input type="color">` |
| Swap colors | `#swapColors` | ⇄ button, swaps primary/secondary |
| Secondary color | `#secondaryColor` | `<input type="color">` |
| **--- separator ---** | `.tb-sep` | |
| Undo | `#undoBtn` | ↩ Undo |
| Redo | `#redoBtn` | ↪ Redo |
| **--- separator ---** | `.tb-sep` | |
| Rect Select | `#rectSelectBtn` | ⬚ Rect |
| Ellipse Select | `#ellipseSelectBtn` | ⬭ Ellipse |
| Lasso Select | `#lassoSelectBtn` | ⌇ Lasso |
| Fill | `#fillBtn` | 🪣 Fill |
| Deselect | `#deselectBtn` | ✕ Desel (hidden until selection active) |
| Transform | `#transformBtn` | ⟷↔ Transform (hidden until selection active) |
| Simulation | `#simulationBtn` | ◎ Simulation (hidden until boid/ant brush active) |
| Proportional lock | `#proportionalToggle` | 🔒 (hidden; shown during transform) |
| **--- separator ---** | `.tb-sep` | |
| Copy | `#copyBtn` | 📋 Copy |
| Cut | `#cutBtn` | ✂ Cut |
| Paste | `#pasteBtn` | 📌 Paste |
| **--- separator ---** | `.tb-sep` | |
| Layer switcher | `#layerSwitcher` | `<select>` dropdown for quick layer switching |
| **--- separator ---** | `.tb-sep` | |
| BG label | `.bg-label` | "BG" text |
| BG color | `#bgColor` | `<input type="color">` for background |
| **--- separator ---** | `.tb-sep` | |
| Canvas Size | `#canvasSizeBtn` | 📐 Size |
| Clear | `#clearBtn` | 🗑 Clear |
| Save | `#saveBtn` | 💾 Save |
| Export PSD | `#exportPsdBtn` | 📤 Export PSD |
| Import PSD | `#importPsdBtn` | 📥 Import PSD |
| Reset View | `#resetViewBtn` | 🔍 Reset View |
| Flip View | `#flipViewBtn` | 🪞 Flip |
| Tiling | `#tilingBtn` | 🔁 Tile |
| Alpha Lock | `#alphaLockBtn` | 🔒 Alpha |

**Outside `#topbar`, inside `#topbarWrap`:**

| Element | ID | Description |
|---|---|---|
| Sidebar toggle | `#sidebarToggle` | ☰ hamburger — always visible, pinned right |

### 2. Brush Dropdown (`#brushDropdown`)
A fixed-position popup (z-index: 100) rendered **outside** `#topbar` to avoid backdrop-filter clipping. Contains one `<button>` per brush type with `data-brush` attribute:

| data-brush | Label |
|---|---|
| `boid` | 🐦 Boid |
| `ant` | 🐜 Ant |
| `bristle` | 🖊 Bristle |
| `simple` | 🖌 Simple |
| `eraser` | ◻ Eraser |
| `ai` | 🤖 AI Diffusion |

### 3. Canvas Area (`#canvasArea`)
Positioned below topbar, above status bar. Contains a transform wrapper (`#canvasTransform`) with three stacked canvases:
- `#compositeDisplay` — final composited layers (WebGL2)
- `#liveCanvas` — real-time brush stroke preview
- `#interactionCanvas` — selection outlines, simulation guides, cursor preview

### 4. Simulation HUD (`#simHud`)
Fixed overlay (left: 14px, top: 58px, z-index: 18). Two `.sim-card` containers:
- **Tool row** (`#simToolRow`): Spawn, Attract, Repel, Path, Edge, Pheromone, Clear buttons (`.sim-pill`). Some tools are brush-specific (Edge/Pheromone = ant only, Path = boid only).
- **Playback row**: Run (`#simRunBtn`), Pause (`#simPauseBtn`), Stop (`#simStopBtn`), status text (`#simStatus`).

### 5. Left Edge Sliders (`#edgeSliders`)
Two vertical slider rails on the left edge (z-index: 15) for quick access to:
- **Scale** (`data-param="brushScale"`, range 10–300)
- **Opacity** (`data-param="stampOpacity"`, range 1–100)

Each has `.edge-slider-track`, `.edge-slider-fill`, `.edge-slider-thumb`, `.edge-slider-label`, `.edge-slider-value`.

### 6. Right Sidebar (`#sidebar`)
Fixed panel (width: 280px, z-index: 10) that slides in/out from right (`transform: translateX`). Toggled by `#sidebarToggle`. Built dynamically by `buildSidebar()` in `ui.js`.

**Collapsible sections** use `.section-header` + `.section-body` pairs. Clicking a header toggles `.closed` class (header) and `.collapsed` class (body). Some sections are brush-specific via `data-brushes="boid ant"` attributes — `_toggleBrushSections()` in `app.js` hides/shows them when the brush changes.

#### Sidebar Sections (top to bottom)

| Section | data-section | data-brushes | Default State | Contents |
|---|---|---|---|---|
| Colors | `colorHistory` | all | open | `#colorHistory` — flex-wrap color swatches |
| Brush Scale | `brushScale` | all | open | Scale slider (10–300) |
| Fill | `fill` | all | **closed** | Fill Tolerance slider |
| Spawn Shape | `spawn` | boid, ant | open | Shape dropdown, Radius, Angle, Jitter sliders; Press→Radius checkbox |
| Swarm | `swarm` | boid, ant | open | Count slider (3–200) |
| Forces | `forces` | boid, ant | open | Seek, Cohesion, Separation, Alignment, Jitter, Wander, Wander Spd, FOV, Flow, Flow Scale, Flee R, Individ. sliders |
| Variance | `variance` | boid, ant | **closed** | Size/Opacity/Speed/Force/Hue/Satur/Light Var sliders |
| Motion | `motion` | boid, ant | open | Max Speed, Damping sliders |
| Simulation | `simulation` | boid, ant | open | Speed slider, Point Force, Point Radius sliders |
| Boid Sim Guides | `boidSimulation` | boid | open | Path Speed slider |
| Ant Sim Guides | `antSimulation` | ant | open | Edge Force, Avoid Radius, Phero Radius, Phero Paint sliders |
| Bristle Shape | `bristleShape` | bristle | open | Count, Width, Spread, Pressure Splay sliders |
| Bristle Physics | `bristlePhysics` | bristle | open | Length, Stiffness, Damping, Friction, Smoothing sliders |
| Pencil / Hover | `pencilHover` | boid, bristle | open | Pencil Angle checkbox, Pencil Blend slider |
| Bristle Variance | `bristleVariance` | bristle | **closed** | Size/Opacity/Stiffness/Length/Friction/Hue Var sliders |
| Bristle Visual | `bristleVisual` | bristle | open | Show Bristles checkbox |
| Stamp | `stamp` | all | open | Size, Opacity, Separation, Smudge sliders; Smudge Only, Skip Start, Press→Size, Press→Opac, Flat Stroke checkboxes; Stabilizer slider |
| Canvas Texture | `canvasTexture` | all | **closed** | Enable checkbox, Load/Clear Texture buttons, Strength, Scale sliders |
| Symmetry | `symmetry` | all | **closed** | Enable checkbox, Count slider, Mirror checkbox, Center X/Y sliders |
| Taper | `taper` | all | open | Length, Curve sliders; Taper Size, Taper Opac checkboxes |
| Pixel Sensing | `sensing` | boid, ant | open | Enable checkbox, Mode/Channel/Source dropdowns, Strength/Radius/Threshold sliders |
| Visual | `visual` | boid, ant | open | Show Particles, Show Spawn checkboxes |
| Pheromone | `antPheromone` | ant | open | Follow Cursor, Deposit Rate, Evaporation, Trail Width sliders; Show Trail, Phero→Sensing checkboxes; Ant Math button |
| Trail Blur | `trailBlur` | all | open | Trail Blur, Texture Flow sliders |
| Pigment Mix | `kmMix` | all | open | Enable checkbox, Strength slider |
| Impasto | `impasto` | all | open | Enable checkbox, Strength, Light Angle, Light Elevation sliders |
| AI Connection | `aiConnection` | ai | open | Status dot, Setup button |
| Prompt | `aiPrompt` | ai | open | Prompt preview text, Edit button |
| Generation | `aiGeneration` | ai | open | Stamp Size, Steps, Strength, Guidance, Mask Feather sliders |
| Mode | `aiMode` | ai | open | Input Source, Stamp Mode dropdowns; Spacing slider; Random Seed checkbox, Seed input |
| Layers | `layers` | all | open | Add/Dup/Del/Up/Down/Merge/Flatten buttons; Blend mode dropdown; Opacity slider; `#layerList` |
| Presets | `presets` | all | open | Built-in presets, Save/Import/Export buttons, user presets list |
| Settings | `settings` | all | open | Auto-save checkbox, Save Session button, Factory Reset button |

### 7. Ant Math Panel (`#antMathPanel`)
A separate overlay panel (same dimensions/position as sidebar, z-index: 11) opened via the "🔬 Ant Math Variables" button in the Pheromone section. Contains mirror sliders for ant forces with mathematical formula annotations. Has a "← Back" button to close.

### 8. Modals
- **AI Setup Modal** (`#aiSetupModal`): Backend selector, server URL input, test connection button, status dot. Opened by sidebar AI Setup button.
- **Canvas Size Modal** (`#canvasSizeModal`): Preset dropdown (HD, 4K, social, print, texture sizes), custom W×H inputs, BG color picker, swap button, Apply button. Opened by `#canvasSizeBtn`.
- **AI Prompt Popout** (`#aiPromptPopout`): Prompt textarea, negative prompt textarea, recent prompts list. Positioned near the Edit button.

### 9. Status Bar (`#status`)
Fixed bar at bottom (height: 24px, z-index: 20). Monospace font. Updated by `app.setStatus()`.

### 10. Toast (`#toast`)
Fixed notification popup (bottom: 50px, centered, z-index: 100). Shown/hidden via `.show` class. Used by `app.showToast()`.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `1` | Switch to Boid brush |
| `2` | Switch to Bristle brush |
| `3` | Switch to Simple brush |
| `4` | Switch to Eraser |
| `5` | Switch to AI Diffusion brush |
| `[` / `]` | Decrease / increase stamp size |
| `M` | Rectangle select tool |
| `L` | Lasso select tool |
| `G` | Fill tool |
| `T` | Toggle transform on selection |
| `F` | Flip canvas view |
| `P` | Toggle tiling mode |
| `X` | Swap primary/secondary colors |
| `/` | Toggle alpha lock |
| `0` | Reset view (zoom/pan/rotation) |
| `Escape` | Deselect |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+S` | Save image |
| `Ctrl+C` | Copy |
| `Ctrl+X` | Cut |
| `Ctrl+V` | Paste |
| `Ctrl+N` | Canvas size modal |

---

## Styling Conventions

- **All CSS is inline** in `app.html` inside a single `<style>` block. There are no external CSS files.
- Colors use `rgba()` extensively with low-alpha whites over dark backgrounds. The base palette is dark (#111 body, #121216 topbar, #0a0a0e sidebar).
- Active/selected states use a blue gradient: `linear-gradient(135deg, #3a6ae8, #5b8af0)`.
- Eraser active uses red gradient: `linear-gradient(135deg, #b83232, #e05050)`.
- Alpha lock active uses amber gradient: `linear-gradient(135deg, #c77a20, #e8a030)`.
- Buttons: 6px border-radius, 1px border `rgba(255,255,255,0.1)`, subtle hover brightening.
- Sidebar sections use `.section-header` / `.section-body` pattern with chevron toggle.
- Sidebar controls are `11px` font, sliders are 92px wide with 16px round white thumbs.
- Brush-specific sections use `data-brushes="brush1 brush2"` attribute for show/hide filtering.

---

## Slider & Control Conventions

- Sliders are created by `sliderRow(id, label, min, max, value, fmt, desc)` in `ui.js`.
- Each slider has a `<label>` wrapping the label text, a `<span id="v_{id}">` for the formatted value, and an `<input type="range" id="{id}">`.
- Optional `<span class="slider-desc">` below for description text.
- Format functions are stored in `_sliderFormats` (private in `ui.js`) and applied on `input` events.
- All slider/checkbox/select changes call `app.invalidateParams()` to mark the parameter cache dirty.
- `app.getP()` reads all UI values into a cached params object — this is the single source of truth for brush parameters.

---

## Key Patterns for Making Changes

### Adding a new topbar button
1. Add `<button id="myNewBtn">` **inside the `#topbar` div** in `app.html`, in the desired position relative to existing buttons and `.tb-sep` separators. Do NOT place it after the `#topbar` closing `</div>` — that area is reserved for the always-visible `#sidebarToggle`.
2. Wire the click handler in `app.js` inside `_bindEvents()`.
3. The `#sidebarToggle` hamburger must remain the last element inside `#topbarWrap` but outside `#topbar`. Never move it into the scrollable area.

### Adding a new sidebar slider
1. Add a `${sliderRow('myParam', 'Label', min, max, default, formatFn, 'description')}` line inside the appropriate section in `buildSidebar()` in `ui.js`.
2. If the section is brush-specific, ensure the section's `data-brushes` attribute includes the relevant brush(es).
3. Read the value in `getP()` in `app.js` (search for the function) as `+g('myParam')` and add it to the returned params object.

### Adding a new sidebar section
1. In `buildSidebar()` in `ui.js`, add a `.section-header` div and a `.section-body` div (following the existing pattern).
2. Use `data-section="mySection"` on the header, and optionally `data-brushes="boid ant"` on both header and body for brush-specific visibility.
3. Add `closed` class to header and `collapsed` class to body if it should default to collapsed.
4. The toggle wiring is automatic — the `querySelectorAll('.section-header')` loop at the end of `buildSidebar()` handles it.

### Adding a new brush type
1. Create a new brush class in `brushes.js` implementing `onDown()`, `onMove()`, `onUp()`, `frame()`.
2. Import and instantiate it in `app.js` constructor (`this.brushes.mybrush = new MyBrush(this)`).
3. Add a `<button data-brush="mybrush">` in the `#brushDropdown` in `app.html`.
4. Add brush-specific sidebar sections in `ui.js` with `data-brushes="mybrush"`.

### Modifying the canvas size modal
The modal HTML is in `app.html` inside `#canvasSizeModal`. Preset options are in the `<select id="canvasSizePreset">` with `<optgroup>` categories. The apply logic is in `app.js` (search `_showCanvasSizeModal` or `canvasSizeApply`).

### Changing keyboard shortcuts
All shortcuts are in `_onKeyDown(e)` in `app.js` (around line 1872+). The method is a straightforward key-check cascade.

---

## Common Pitfalls

- **Don't assume external CSS**: All styles are in the `<style>` block in `app.html`. Editing a non-existent `.css` file won't work.
- **Sidebar is dynamic**: The `#sidebar` div starts empty in HTML. Its contents are built by `buildSidebar()` in `ui.js`. To change sidebar contents, edit `ui.js`, not `app.html`.
- **Brush dropdown is outside topbar**: `#brushDropdown` is a sibling of `#topbar`, not a child. This is intentional to avoid `backdrop-filter` clipping.
- **Parameter flow**: UI controls → `app.getP()` (reads DOM values) → cached params object → brush engines. Don't set params directly on brush objects; add the value to `getP()`.
- **data-brushes filtering**: Sidebar sections with `data-brushes` are shown/hidden by `_toggleBrushSections()` in `app.js`. The attribute value is space-separated brush names. Add your brush name there to make a section visible for it.
- **WebGL premultiplied alpha**: The compositor uses `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (not `_GL`). See memory note for details on this past bug.
- **Simulation mode** is only available for `boid` and `ant` brushes. The `#simulationBtn` is hidden for other brushes.
- **Edge sliders** mirror sidebar sliders (`brushScale`, `stampOpacity`). Changes to either sync the other via `syncEdgeSliders()` in `ui.js`.
- **Ant Math panel** mirrors main sidebar sliders via `_AM_MIRRORS` array in `ui.js`. Two sliders (`am_neighborRadius`, `am_separationRadius`) are panel-only.
- **No build step**: JS files are ES modules served directly. The WASM must be pre-compiled (`wasm-pack build` in `wasm-sim/`).
