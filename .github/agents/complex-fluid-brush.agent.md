## Plan: Separate 3D Fluid Brush

Add a new, separate WebGPU-powered fluid brush instead of replacing the current LBM fluid brush. The existing fluid brush remains intact as the lightweight free-flow LBM option, while the new brush carries the heavier architecture for true height, volume, and pressure simulation. The primary acceptance criterion is user-facing responsiveness: the new brush should feel as fast as the current boid brush when it is running with WebGPU simulation and rendering. The new brush should not be cursor-only at the architecture level: its fluid core should accept native external influences and emitter inputs so a future fluid blob can be disturbed by boids, ants, and other agent systems, and those same agents can later act as spawn sources in draw mode without another structural rewrite.

**Steps**
1. Phase 1: Freeze the current behavior contract and the future-extensibility contract before adding the new brush.
   - Trace the exact current FluidBrush flow in c:\Users\mattt\Documents\vibecoding\boid_brush\brushes.js: onDown -> _seedAt -> _step -> _depositFrameFromSim -> layer redraw.
   - Treat the current Rust LBM implementation in c:\Users\mattt\Documents\vibecoding\boid_brush\wasm-sim\src\fluid.rs as the source of truth for the existing fluid brush only, and preserve it as the lightweight baseline rather than replacing it.
   - Define the new brush as a separate tool, tentatively named 3D Fluid Brush, with its own simulation backend, parameter set, and UI sections while keeping compatibility with shared app-level brush lifecycle patterns.
   - Add an explicit architecture requirement that the new fluid backend must support more than one input source category from day one: direct brush injection, external force/disturbance inputs, pigment-color inputs, emitter/spawn inputs, graded scalar-field inputs such as drag or directional-control maps, and true simulation state for terrain height, fluid volume/thickness, and pressure so flow location, speed, direction, and displayed opacity can all respond to that state physically rather than cosmetically.
   - Define the non-negotiable presentation rules from the boid WebGPU work: no reliance on swapchain persistence, preview must mirror to a 2D preview canvas after queue completion, and only the layer canvas is persistent paint.
2. Phase 1.5: Define performance budgets before solver lock-in. Depends on 1.
   - Treat solver choice as an implementation detail, not the goal. The implementation should be selected only after it can plausibly hit boid-like responsiveness on the current machine.
   - Establish concrete interaction budgets for the new brush, such as low pointer-to-visible-preview latency, stable frame pacing during active strokes, and graceful degradation before visible lag.
   - Require adaptive quality controls from the start: reduced internal resolution, reduced simulation detail, or hybridized updates should be acceptable if they preserve the target feel.
   - Reject or simplify candidate solver pathways that cannot meet the interaction target, even if they are more physically complete.

2. Phase 2: Design the WebGPU fluid simulation API around native interaction inputs, not just brush-local calls. Depends on 1.
   - Add a new WebGPU fluid simulation module beside c:\Users\mattt\Documents\vibecoding\boid_brush\webgpu-boid-sim.js that mirrors the existing FluidSim lifecycle closely enough for FluidBrush integration: create, updateParams, setDisplaySize, setMask, step, getParticleCount, getParticles, destroy.
   - Expand that interface so it natively accepts future cross-system inputs: submitEmitters, submitInfluences, submitScalarFields, clearInteractionState, and optional readback/sample helpers for future agent-fluid coupling.
   - Model interaction payloads as generic GPU-friendly records rather than cursor-special cases. The initial schema should cover source type, position, velocity, radius, strength, pigment color, alpha, and mode flags so boids, ants, cursor seeds, or future systems can all map into the same input buffer format.
   - Extend the core simulation state beyond the current transport fields so the initial GPU solver owns explicit per-cell terrain height, fluid thickness/volume, pressure, momentum/velocity, pigment, and optional phase or occupancy state.
   - Keep current brush injection implemented as one producer of those generic input records, not as a special codepath baked into the solver.
3. Phase 3: Build a WGSL fluid solver with explicit seams for blob, agent interaction, and true height/pressure behavior. Depends on 2.
   - Use the current LBM implementation in c:\Users\mattt\Documents\vibecoding\boid_brush\wasm-sim\src\fluid.rs as the behavioral reference for existing free-flow pigment transport, but do not constrain the new GPU solver to a plain one-for-one LBM port if that blocks real height, volume, and pressure behavior.
   - Design the GPU solver around explicit per-cell state updates for terrain height, fluid thickness/volume, pressure, momentum/velocity, pigment transport, and optional phase or occupancy, using ping-pong storage where needed.
   - Reserve dedicated compute stages for emitter injection, momentum/pressure update, transport/advection, pigment transport, settling/rest detection, and debug-view extraction so future boid or ant disturbances can enter the pipeline without changing solver topology.
   - Allow graded maps to act as physical modifiers of the height-coupled simulation, for example by changing drag, permeability, slope bias, or local capacity, while binary masks still define hard domain limits when needed.
   - Treat the mask and phase representation as the future blob seam: even if the first release remains free-flow, the internal state layout should allow a bounded blob domain to be driven by the same machinery later, with binary masks, terrain fields, and graded maps coexisting rather than competing.
4. Phase 4: Reuse the existing simulation-guide pattern as the cross-system adapter layer. Depends on 2 and 3.
   - Use the current guide seams in c:\Users\mattt\Documents\vibecoding\boid_brush\brushes.js and c:\Users\mattt\Documents\vibecoding\boid_brush\webgpu-boid-sim.js as the architectural reference for agent-fluid interop, especially _collectSimulationGuides, _syncSimulationGuidesToGpu, _applySimulationGuides, and setSimulationGuides.
   - Define a fluid-side adapter layer that can consume agent outputs in two forms: sparse emitter/influence records from readAgents, and higher-level guide/state collections from app.simulation data.
   - Keep the fluid solver independent of boid and ant implementations by converting those systems into generic influence/emitter records before upload.
   - Make sure future boid or ant spawn-point behavior in draw mode can route through the same emitter buffer used by cursor injection, rather than requiring a second spawning subsystem.
5. Phase 5: Build a dedicated WebGPU fluid renderer and preview path. Depends on 3.
   - Add a fluid-specific WebGPU renderer instead of reusing the boid stamp renderer, because the fluid path renders lattice state rather than stamp instances.
   - Render from simulation state into an offscreen accumulation or frame texture, present that texture to the WebGPU canvas, then mirror the presented frame into a 2D preview canvas only after submitted GPU work completes.
   - Match the existing render modes from the Rust implementation where possible, but make the new renderer consume true simulation state such as thickness/volume, pressure, pigment concentration, and optional phase so displayed opacity, transparency, and visual mass derive from the simulated fluid rather than only from legacy pigment alpha.
   - Expose copyTo2D and clear/invalidate preview helpers, following the boid preview rules from the repo memory and AGENTS guidance.
6. Phase 6: Implement the new brush alongside FluidBrush without changing the existing fluid tool. Depends on 2, 3, and 5.
   - Add a new brush class in c:\Users\mattt\Documents\vibecoding\boid_brush\brushes.js, tentatively named ThreeDFluidBrush, instead of replacing FluidBrush.
   - Give the new brush its own GPU preview/commit flow, parameter readers, and solver wiring while reusing the shared brush lifecycle shape used across the app.
   - Preserve the current FluidBrush and its sim.readPixels -> putImageData -> drawImage pathway as the legacy lightweight fluid option.
   - Implement brush-local emission by producing generic emitter records for the new fluid backend. The initial producer is the cursor stroke, but the same path should be reusable for future agent-driven emitters.
   - Reuse the captured pre-stroke layer rebuild pattern when appropriate so the evolving 3D-fluid render replaces the current stroke preview each frame rather than accumulating heavier paint artifacts unintentionally.
   - Ensure alpha-lock still applies only during commit to the layer canvas, not inside transient GPU preview state.
7. Phase 7: Integrate brush registration, UI separation, backend lifecycle, and future interaction hooks. Depends on 6.
   - Register the new brush separately in c:\Users\mattt\Documents\vibecoding\boid_brush\app.js and keep the current fluid brush selectable as-is.
   - Add a separate brush dropdown entry in the shell UI and separate sidebar sections in c:\Users\mattt\Documents\vibecoding\boid_brush\ui.js for the new brush rather than overloading the current fluid controls.
   - Add backend status for the new brush similar to other GPU-capable brushes so failures degrade clearly without affecting the existing fluid brush.
   - Handle canvas resize, layer removal, brush deactivation, undo/redo restore, and app resets by clearing GPU preview state and rebuilding simulator/render targets to the new dimensions.
   - Add minimal, non-user-facing hooks for future agent coupling, such as a way to push external influence buffers each frame from app-level simulation orchestration, even if the first release only uses the brush-local producer.
   - Decide whether to surface a visible render backend label for the fluid brush. Recommended: include backend status in FluidBrush.getStatusInfo, but avoid new sidebar controls in the first rewrite.
8. Phase 8: Verification, parity, and extensibility checks. Depends on 6 and 7.
   - Add focused validation for the compute/render chain: initialization, parameter upload, nonzero active cells after injection, render pass execution, preview sync, and layer commit.
   - Compare current fluid behavior against the legacy WASM brush for representative cases: single click dab, short drag, long drag, high viscosity, high carry, different render modes, fast-first-pass enabled, and final settle replay.
   - Add at least one architecture-level verification for future compatibility: inject synthetic external influence/emitter records without using the cursor path and confirm the solver accepts them and produces visible disturbance or pigment.
   - Verify the key presentation invariants: preview appears while the stroke is active, commit persists after the next composite, and output does not disappear on the next frame.

**Relevant files**
- c:\Users\mattt\Documents\vibecoding\boid_brush\brushes.js — preserve the current FluidBrush unchanged and add the new ThreeDFluidBrush alongside it; use the existing simulation-guide seams as the reference for future agent-fluid adapters.
- c:\Users\mattt\Documents\vibecoding\boid_brush\wasm-bridge.js — keep the existing FluidSim untouched as the current fluid brush backend; avoid entangling it with the new WebGPU brush backend.
- c:\Users\mattt\Documents\vibecoding\boid_brush\wasm-sim\src\fluid.rs — source of truth for the existing LBM brush behavior and a useful reference point for transport/render expectations, but not a hard constraint on the new solver architecture.
- c:\Users\mattt\Documents\vibecoding\boid_brush\webgpu-boid-sim.js — reference for adapter/device setup, ping-pong buffers, compute dispatch orchestration, and GPU-side guide upload patterns.
- c:\Users\mattt\Documents\vibecoding\boid_brush\boid-renderer.js — reference for WebGPU preview mirroring, onSubmittedWorkDone synchronization, copyTo2D behavior, and swapchain-vs-preview safety rules.
- c:\Users\mattt\Documents\vibecoding\boid_brush\app.js — keep the current fluid brush registration and add a second registration path for the new brush, plus the eventual app-level seam for pushing external fluid interaction inputs.
- c:\Users\mattt\Documents\vibecoding\boid_brush\ui.js — preserve the current fluid control surface and add separate controls for the new brush instead of merging them.
- c:\Users\mattt\Documents\vibecoding\boid_brush\app.html — add a separate brush dropdown entry for the new brush without removing the current fluid entry.
- c:\Users\mattt\Documents\vibecoding\boid_brush\AGENTS.md — use its preview/commit/presentation debugging rules as constraints for the fluid implementation even though it is boid-focused.
- c:\Users\mattt\Documents\vibecoding\boid_brush\docs\fluid-brush.md — behavioral contract for the current LBM fluid brush that should remain intact after adding the new brush.
- New module next to c:\Users\mattt\Documents\vibecoding\boid_brush\webgpu-boid-sim.js — the WebGPU fluid compute backend.
- New renderer module or extension near c:\Users\mattt\Documents\vibecoding\boid_brush\boid-renderer.js — the WebGPU fluid renderer and preview bridge.

**Cloud Workflow**
1. Create a dedicated remote branch such as `feature/3d-fluid-brush-spike` and open a draft PR against `main` immediately.
2. Use a cloud dev environment for authoring and non-GPU validation: JS/WGSL edits, Rust/WASM builds, tests, and incremental checkpoint commits.
3. Keep WebGPU runtime validation separate from ordinary cloud editing. Standard GitHub-hosted CI or generic Codespaces are not sufficient to prove interactive WebGPU responsiveness for this repo.
4. If the work must stay entirely cloud-hosted, use a GPU-backed remote machine with a real browser and connect to the same GitHub branch from there.
5. Treat branch-based cloud work as the collaboration path, but treat final responsiveness validation as GPU-interactive validation, not just CI success.

**Verification**
1. Run a focused syntax/type pass for the touched JavaScript modules and verify browser startup without console shader compilation errors.
2. Exercise a single-click fluid dab and confirm this sequence: injection occurs, GPU active-cell count rises, preview becomes visible, preview sync completes, and final commit persists on the layer after composite.
3. Exercise a short drag stroke with Fast First Pass enabled and confirm the low-resolution preview appears during drawing, followed by a full-resolution replay render when settling completes.
4. Switch lbmRenderMode between particles, grid, and hybrid and confirm each mode produces distinct output while remaining visible and persistent.
5. Inject synthetic external influence records and synthetic emitter records directly into the fluid backend, bypassing the cursor path, and confirm they visibly disturb or seed the fluid without interface changes.
6. Resize the canvas, switch layers, undo, redo, and deactivate/reactivate the fluid brush to confirm GPU textures and preview state rebuild cleanly without stale or missing output.
7. Force WebGPU unavailability and confirm the brush falls back to the existing FluidSim pathway rather than failing open.
8. Compare at least one high-viscosity and one high-pigment-carry stroke against the legacy WASM path to catch obvious parity regressions in settling and visible pigment retention.
9. Validate active-stroke responsiveness against the boid brush baseline on the current machine and treat failure to meet that feel target as a release blocker for the new brush.

**Decisions**
- User-selected scope: full WebGPU solver plus render rewrite, not just a GPU display path over the existing WASM output.
- Included: keep the current free-flow fluid brush intact and add a separate brush for the new WebGPU height/volume/pressure system, with an internal API and solver state designed to accept future blob interactions, agent disturbances, and agent-driven spawn inputs natively.
- Excluded from the first implementation: replacing the current fluid brush, actually building the fluid blob feature, actual boid/ant coupling behavior, and new UI beyond the separate brush entry and its own controls. The requirement is architecture readiness, not delivering those future features now.
- Recommended implementation order: first add the new brush shell and registration while preserving the old fluid brush, then validate one or more candidate WebGPU fluid approaches against the responsiveness target, then proceed only with the one that can keep boid-like interaction speed while supporting the required behavior.

**Further Considerations**
1. The safest long-term shape is to treat cursor strokes, boid positions, ant trails, and future systems as producers of one shared influence/emitter schema, rather than adding dedicated fluid APIs per feature.
2. Even if the first release remains free-flow, keep the mask/phase pipeline explicit and modular so a future bounded blob can become a domain constraint plus interaction target, not a separate fluid engine.
3. Add fluid-specific debug traces similar to the boid GPU traces so invisible-output failures can be localized to injection, external influence upload, compute, render, preview sync, or commit.
