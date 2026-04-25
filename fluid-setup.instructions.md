---
applyTo: '**'
---

# Fluid Setup — Repository Instructions

Purpose: convert planning notes for a new `BlobFluid` brush and a fluid-simulation playground into a concise, actionable implementation guide for engineers working in this repository.

Scope
- Implement a new paint brush that uses a user-defined "blob" mask and a WASM fluid simulator to move pigment inside that blob.
- Add a separate Fluid Simulation Playground page for experimentation and tuning.
- Do not change the existing `fluid` brush behavior; add this as an additional brush.

Terminology
- Blob: user-defined mask/area painted by the stroke that bounds where fluid-painted pigment can move.
- Pigment: color/opacity information carried by the simulation inside a blob.
- Playground: isolated page used to test and tune fluid solver parameters and render modes.

Recommended design decisions
- Start with a particle-based SPH (Smoothed Particle Hydrodynamics) solver compiled to WASM for a balance of accuracy and real-time performance.
- Expose parameters: viscosity, density, time step, particle radius, solver substeps.
- Keep the blob static once the stroke ends for the initial release.
- Run simulation per-blob in WASM/JS and rasterize results to a composited canvas layer.

Files to add / modify
- UI: update `ui.js` to add brush controls and an entry for the new brush in the brush dropdown.
- App wiring: update `app.js` to register and manage the new brush class and its lifecycle (`onDown`, `onMove`, `onUp`, `frame`).
- Brushes: add `BlobFluidBrush` in `brushes.js` implementing `onDown()`, `onMove()`, `onUp()`, `frame()`.
- WASM: add or extend a module under `wasm-sim/` exposing a minimal solver API: `createSimulator`, `addParticles`, `step`, `readPixels`, `destroySimulator`.
- Playground: add `playground/fluid_playground.html` and `playground/fluid_playground.js` that load the same WASM and expose tuning UI.
- Compositor/render: follow `compositor.js` and `wasm-bridge.js` patterns to render particle output into `#liveCanvas` / `#compositeDisplay` as a preview before committing.
- PSD/IO (optional): update `psd-io.js` to export the blob-painted raster if desired.

Implementation steps (practical)
1) Brush scaffold
  - Add `BlobFluidBrush` class in `brushes.js` with `onDown`, `onMove`, `onUp`, `frame` hooks.
  - During `onDown` start a temporary mask; `onMove` update mask preview; `onUp` finalize mask and spawn simulator.

2) Blob mask representation
  - Use a raster alpha mask backed by an offscreen canvas for initial simplicity.
  - While painting, update the mask canvas; freeze it on `onUp` and use it to clip simulation bounds.
  - the bounds of blob will be defined by the running bounding box of the stroke points, expanded by a margin for particle radius, though will not be a rectangle, but a curve approximation the widest range of the "points" of the simulation as the stroke is drawn. This will be used to define the simulation domain and initial particle distribution.

3) WASM SPH solver
  - Provide a small API wrapper usable from `app.js`:
    - `createSimulator(width, height, params) -> handle`
    - `addParticles(handle, particlesArray)`
    - `step(handle, dt)`
    - `readPixels(handle, outBuffer)` (RGBA)
    - `destroySimulator(handle)`
  - Optimize by supporting variable substeps and particle clamping for small blobs.

4) Integration with brush lifecycle
  - On `onUp`: sample pixels inside the final mask from the current canvas (color + alpha), downsample or stochastic-sample into particles, and `addParticles` to the sim instance.
  - Schedule `step()` calls from the app frame loop and render `readPixels()` output to an offscreen preview canvas.
  - Ensure premultiplied alpha is respected when compositing: `gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)` in WebGL setup.

5) Rendering & commit
  - During simulation: render preview to `#liveCanvas` or a dedicated offscreen canvas (non-destructive).
  - When simulation ends or user commits: rasterize the simulator output and composite it into the active layer using the existing layer API.

6) UI controls
  - Add a `Blob Fluid` section in the sidebar (via `ui.js`) with: `Particle radius`, `Viscosity`, `Density`, `Time step`, `Solver substeps`, `Render mode` (particles/grid), `Playback` (pause/step), `Export snapshot`.
  - Add a brush dropdown entry and optional topbar toggles for playground/commit behavior.

7) Playground page
  - Add `playground/fluid_playground.html` and `playground/fluid_playground.js` that load the WASM solver and expose parameter controls, particle spawners, and multiple render modes. Keep this page isolated from main app state.

Testing and acceptance criteria
- Lifecycle: `onDown`/`onMove`/`onUp` call order must be exercised by unit/integration tests.
- Sampling: non-empty particle sets must be produced for meaningful strokes.
- Visual: preview shows fluid motion inside blobs; committing writes expected raster to the layer.
- Performance: target interactive rates (30–60 fps) for modest particle counts; provide fallbacks (lower particle counts, fewer substeps) on low-end hardware.

Milestones
1. Brush scaffold + blob mask raster (preview only)
2. Minimal WASM SPH solver + JS wrapper (playground)
3. Integration: sample pixels → spawn particles → per-frame preview
4. Commit flow: rasterize sim output into active layer and persist
5. Playground polishing + parameter tuning UI

Notes
- Prefer SPH initially; evaluate LBM/Eulerian later if needed.
- Reuse `wasm-sim/` build patterns and `wasm-bridge.js` integration.
- Ensure WebGL premultiplied alpha unpacking constant is correct (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`).

--
Generated from `fluid setup planning.md` — moved into repository instructions for developer use.
