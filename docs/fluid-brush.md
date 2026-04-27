# Fluid Brush

The Fluid Brush is now a **free-flow LBM brush** backed by the fluid WASM solver from the playground. It injects pigment into a lattice-Boltzmann flow field and continuously deposits the evolving fluid frame onto the active layer. There is no blob boundary mode in the main app implementation.

Keyboard shortcut: **`5`**

---

## How It Works

1. **Inject** — Pointer samples spawn seed packets near the cursor using the current brush radius, injection count, and stroke-shaping controls.
2. **Solve** — The WASM fluid solver runs in **LBM mode only**. Pigment mass, velocity, and interface phase evolve on an internal grid.
3. **Deposit** — Each animation frame reads the current fluid pixels from WASM and draws them onto the stroke's target layer.
4. **Settle** — After lift-off, the fluid keeps advancing while the brush remains active, so the flow can continue to spread and settle.

Because the main app version is free-flow only, the brush always uses an empty mask and can move anywhere on the canvas.

---

## Controls

### LBM Brush

| Control | ID | Description |
|---|---|---|
| Brush Radius | `lbmBrushRadius` | Size of each injected free-flow stroke sample. Scales with the global Brush Scale slider. |
| Inject | `lbmSpawnCount` | Pigment mass injected per sample. |
| Seed Radius | `lbmParticleRadius` | Radius of the seed packets used to feed the lattice. |
| Stroke Pull | `lbmStrokePull` | Bias toward the stroke tangent during injection. |
| Stroke Rake | `lbmStrokeRake` | Splits injection into lane-like flow bands. |
| Stroke Jitter | `lbmStrokeJitter` | Adds turbulence and curl to each injection. |
| Hue Jitter | `lbmHueJitter` | Per-injection hue variation. |
| Light Jitter | `lbmLightnessJitter` | Per-injection lightness variation. |
| Show Flow | `lbmShowFlow` | Renders sampled flow points and the current brush radius overlay. |

### LBM Solver

| Control | ID | Description |
|---|---|---|
| Render | `lbmRenderMode` | Chooses the fluid preview style (`hybrid`, `grid`, or `particles`). |
| Viscosity | `lbmViscosity` | Lattice relaxation strength. Higher values smooth motion. |
| Density | `lbmDensity` | Mass injected into the flow. |
| Surface Tension | `lbmSurfaceTension` | Keeps the interface tighter as it moves. |
| Time Step | `lbmTimeStep` | Simulation speed multiplier per frame. |
| Substeps | `lbmSubsteps` | Solver iterations run per frame. |
| Decay | `lbmMotionDecay` | Motion damping inside the solver. |
| Stop Speed | `lbmStopSpeed` | Velocity threshold below which motion settles out. |
| Resolution | `lbmResolutionScale` | Internal solver resolution relative to the canvas. |
| Fluid Scale | `lbmFluidScale` | Additional scale factor for the fluid grid. |

---

## Notes

- The startup defaults are tuned toward **faster settling**: lighter injection, higher viscosity/decay, lower solver speed, and a higher stop threshold so the brush stops sooner after lift-off.
- The brush uses the shared **primary color** as its base pigment color.
- The implementation is intentionally **free-flow only**; it does not expose the playground's blob authoring workflow.
- Undo snapshots the painted layer content at stroke start, not the solver's internal state.
