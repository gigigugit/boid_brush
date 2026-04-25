## Fluid Setup — Implementation Instructions

Purpose: convert the planning notes for a new "blob" brush and a fluid-simulation playground into a concise, actionable implementation guide for engineers working in this repository.

Scope
- Implement a new paint brush that uses a user-defined "blob" mask and a WASM fluid simulator to move pigment inside that blob.
- Add a separate Fluid Simulation Playground page for experimentation and tuning.
- Do not change the existing `fluid` brush behavior; this is an additional brush.

Terminology
- Blob: the user-defined mask/area painted by the brush stroke that bounds where fluid-painted pigment can move.
- Pigment: the color/opacity information carried by the simulation inside a blob.
- Playground: isolated page used to test and tune fluid solver parameters and render modes.

Design decisions (recommended)
- First implementation: particle-based SPH (Smoothed Particle Hydrodynamics) in WASM — balanced accuracy and real-time performance.
- Expose viscosity, density, time step, particle radius, and solver substeps as adjustable parameters.
- Keep the blob static once the stroke ends for the initial release. Dynamic-evolving blobs are a later enhancement.
- Run the simulation per-blob on the CPU/WASM and rasterize to a composited layer in `Compositor`/canvas stack.

Files to add / modify
- UI: update `ui.js` to add brush controls and an entry for the new brush in the brush dropdown.
- App wiring: update `app.js` to register and manage the new brush class and its lifecycle (down/move/up/frame).
- Brushes: add a new brush class in `brushes.js` (e.g., `BlobFluidBrush`) implementing `onDown()`, `onMove()`, `onUp()`, and `frame()`.
- WASM: add a new WASM module under `wasm-sim/` (or extend it) exposing a minimal solver API: `createSimulator(params)`, `addParticles(xyColorAlpha...)`, `step(dt)`, `getParticleBuffer()`, `destroySimulator()`.
- Playground: add `playground/fluid_playground.html` and `playground/fluid_playground.js` (served alongside existing pages). Use `wasm-sim/pkg/` integration pattern like existing `boid_sim` bridge (`wasm-bridge.js`).
- Compositor / rendering: use `compositor.js` and `wasm-bridge.js` patterns to render particle output into `#liveCanvas` / `#compositeDisplay` as a temporary layer before committing to a layer image.
- PSD/IO (optional): update `psd-io.js` if you want to export the blob-painted layer as a raster during PSD export.

Implementation steps (detailed)
1) Add brush scaffolding
	- In `brushes.js` create `BlobFluidBrush` class exposing `onDown(e)`, `onMove(e)`, `onUp(e)`, `frame(dt)`.
	- Behavior: onDown starts a new blob mask (store stroke points), onMove updates the mask and stroke preview, onUp finalizes the blob mask and spawns the simulator with initial pigment distribution.

2) Blob mask representation
	- Represent the blob as a triangulated polygon or an alpha mask raster (prefer raster mask for simplicity).
	- While painting (pointer down), update a temporary mask canvas (`offscreen canvas`) that mirrors the stroke outline. When the stroke ends, freeze the mask and use it to clip the simulation bounds.

3) WASM fluid simulator
	- Add or build an SPH solver compiled to WASM in `wasm-sim/` following existing patterns (see `boid_sim` for reference). Provide a JS wrapper that exposes the solver API to `app.js`.
	- API surface (minimal):
		- `createSimulator(width, height, params)` → returns handle
		- `addParticles(handle, particlesArray)` → initial particles (x, y, r, g, b, a)
		- `step(handle, dt)` → advances sim
		- `readPixels(handle, outBuffer)` → writes simulation output (RGBA) into provided buffer
		- `destroySimulator(handle)`
	- Optimize: allow variable substeps and particle pruning/clamping when blob area is small.

4) Integrate simulation with brush lifecycle
	- On stroke `onUp`: sample pixels inside the final mask from the current canvas (color + alpha) and spawn particles matching those samples (downsampled grid or stochastic sampling) via `addParticles`.
	- Start a per-blob simulator instance and schedule `step()` calls in app's main frame loop (use `requestAnimationFrame` or existing animation frame hooks in `app.js`).
	- Render the simulator output into a temporary canvas that is composited onto the canvas layer (blend mode: normal, premultiplied alpha). Ensure WebGL compositor uses `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (see repo memory note).

5) Rendering & commit
	- During simulation: render simulator output to `#liveCanvas` or a dedicated offscreen canvas as a visual preview (non-destructive).
	- When simulation is stopped or reaches rest, commit the resulting raster into the active layer via the existing layer compositing API (similar to how other brushes commit strokes).

6) UI controls
	- Add a `Blob Fluid` section in the sidebar via `ui.js` with:
		- `Particle radius`, `Viscosity`, `Density`, `Time step`, `Solver substeps`, `Render mode` (particles/grid), `Playback` (pause/step), `Export snapshot`.
	- Add quick toggles on the topbar or brush dropdown for `Playground` and `Commit` behaviour.

7) Playground page
	- Create `playground/fluid_playground.html` and `playground/fluid_playground.js`.
	- The playground should load the same WASM and expose the solver params, a particle spawner UI, and multiple render modes. This page is for tuning only and must not alter the main app code paths except via shared modules in `wasm-sim/`.

Testing and acceptance criteria
- Unit / integration tests: verify the brush lifecycle methods are called and that mask creation + sampling produces a non-empty particle set for non-trivial strokes.
- Visual acceptance: draw several blobs with different colors and sizes; the playground and brush should show fluid motion inside the blob, and after commit the active layer must contain the rasterized result matching the preview.
- Performance: target real-time interactive rates on typical dev machines (30–60 fps for small blobs). Provide a fallback to lower particle counts or fewer substeps on low-end hardware.
- Safety: simulator must not mutate the global canvas outside the blob mask or other layers.

Milestones
1. Brush scaffold + blob mask raster (basic UI preview)
2. Minimal WASM SPH solver + JS wrapper (local playground testing)
3. Integration: sample pixels → spawn particles → per-frame rendering (non-destructive preview)
4. Commit flow: rasterize simulator output into active layer and persist via save/export
5. Playground polishing and parameter tuning UI

Notes & references
- Prefer SPH for initial implementation; LBM / Eulerian solvers are candidates for later versions.
- Reuse existing WASM build patterns in `wasm-sim/` and `wasm-bridge.js`.
- See `compositor.js` for compositing patterns and ensure premultiplied alpha is enabled: `gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)`.
