# Fluid Brush

The Fluid Brush simulates wet paint deposited onto the canvas as a pool of particles. Each particle carries colour, wetness, and velocity. The brush drags and reshapes the pool while the stroke is active, and particles continue to flow, spread, and dry after the stroke ends — producing watercolour-like diffusion, smearing, and bleed effects.

Keyboard shortcut: **`5`**

---

## How It Works

### Particle lifecycle

1. **Deposit** — On each stroke sample the brush injects a burst of new particles near the cursor. New fluid gets forward push, lateral fan-out, and an impact-driven radial splash so the deposit can burst outward instead of only smearing.
2. **Drag** — The brush radius acts as a force field. Particles already in range receive forward drag, sideways spread, and outward splash energy, so the pool deforms and opens up while the brush moves.
3. **Physics step** — Every frame, live particles are advected through a local cell field: neighboring cell velocities are blended into coherent flow, density adds pooling and edge push, mild turbulence is added, velocity is damped, and each particle moves. Particles that drift off-canvas bounce back with reduced speed.
4. **Stamping** — After each physics step each particle draws both a motion trail and a soft pooled deposit, with optional edge bleed to make puddle rims read more like settling liquid.
5. **Drying** — Wetness decays each frame. When a particle's wetness drops below ~0.025 it is removed. Particles also keep flowing after the stroke ends until they dry out completely.

### Lateral diffusion during a stroke

Previous versions only spread randomly after lift-off. The brush now computes the **perpendicular unit vector** to the stroke direction and assigns a random lateral impulse to every new particle and every existing particle within the brush radius on each injected sample. This causes the pool to fan out to both sides of the stroke continuously while the brush is moving.

---

## Controls

### Fluid Motion section (always expanded)

| Control | ID | Range | Default | Description |
|---|---|---|---|---|
| **Drops** | `fluidParticleLimit` | 10 – 2000 | 320 | Maximum live particles at once. More drops = richer bleed but heavier CPU cost. |
| **Emit** | `fluidEmitRate` | 1 – 100 | 16 | Particles spawned per stroke sample. Higher = thicker, more saturated deposit. |
| **Brush Radius** | `fluidBrushRadius` | 2 – 400 | 42 px | The influence radius of the brush. Particles inside this radius are pushed, twisted, and given a lateral impulse on each sample. Scales with the global Brush Scale slider. |
| **Brush Force** | `fluidBrushForce` | 0 – 6× | 0.95× | Strength of the forward push applied to particles in range. At 0 the brush deposits without dragging. At high values the pool gets flung ahead of the stroke. |
| **Lateral Spread** | `fluidLateralSpread` | 0 – 400 | 70 | How far fluid fans sideways from the stroke direction **during the stroke**. At 0 the old behaviour (no in-stroke lateral motion) is restored. At 70 the pool broadens visibly as you paint. At 200+ the result is wide and splashy. |
| **Flow Speed** | `fluidFlow` | 0.01 – 5.00 | 1.20 | Multiplier on particle advection distance per frame. Low values make the fluid sluggish; high values let it race across the canvas. |
| **Viscosity** | `fluidViscosity` | 0.00 – 1.00 | 0.28 | How strongly each particle's velocity is blended toward the local cell field. Higher values give smoother streams; lower values allow more breakup and wandering droplets. |
| **Damping** | `fluidVelocityDamping` | 0.01 – 1.00 | 0.92 | Velocity decay per frame (applied as `v × damping^dt`). Values near 1.00 let particles coast for a long time; lower values stop them quickly. |
| **Impact** | `fluidImpact` | 0.00 – 1.00 | 0.65 | Strength of the outward impact burst added when fresh paint lands. Higher values make strokes bloom into splash crowns faster. |
| **Splash Radius** | `fluidSplashRadius` | 0.00 – 1.00 | 0.55 | How far the impact burst throws fluid from the core deposit. Higher values widen the crown and the detached rim. |
| **Breakup** | `fluidBreakup` | 0.00 – 1.00 | 0.35 | How readily fast-moving fluid splits into smaller detached droplets and flecks. |

### Fluid Surface section (collapsed by default)

| Control | ID | Range | Default | Description |
|---|---|---|---|---|
| **Deposit** | `fluidDeposit` | 0.01 – 1.00 | 0.78 | Opacity multiplier for each stamp. Lower values give a more transparent, glazed look. Combines with the global Stamp Opacity. |
| **Spread** | `fluidSpread` | 0 – 400 | 10 | Random turbulence added to every particle's velocity each frame. Low values keep the pool coherent; high values break it into chaotic spatter. Also controls the width of the initial lateral scatter on new particles. |
| **Drying** | `fluidEvaporation` | 0.001 – 0.300 | 0.008 | Rate at which wetness decays. High values dry the pool quickly; very low values leave fluid alive on canvas for seconds. |
| **Texture Flow** | `fluidTextureFollow` | 0.00 – 1.00 | 0.28 | When a canvas texture is loaded and enabled, particles are steered into texture valleys. At 1.0 the fluid follows texture contours strongly, giving a paper-grain effect. |
| **Pooling** | `fluidPooling` | 0.00 – 1.00 | 0.70 | How strongly dense wet paint gathers into connected puddles instead of staying as isolated streaks. |
| **Edge Bleed** | `fluidEdgeBleed` | 0.00 – 1.00 | 0.45 | How strongly the outer rim of each puddle darkens and softens as the paint settles. |
| **Show Particles** | `fluidShowParticles` | checkbox | ✓ | Renders live particle positions as faint blue dots and a circle showing the brush radius. Useful for understanding particle behaviour; uncheck for a cleaner working view. |

### Shared Stamp controls

The standard **Stamp** section applies to the fluid brush as well:

- **Size** / **Opacity** — base stamp dimensions; combined with each particle's `wetness` and `size`.
- **Press→Size** / **Press→Opac** — pen pressure scales stamp size and/or opacity at deposit time.
- **Canvas Texture** — modulates deposit opacity with a loaded greyscale texture image.
- **Trail Blur** — applies a soft-blurred halo pass on top of the particle stamps each frame.

---

## Suggested Presets / Exploration Starting Points

### Thin ink bleed
```
Drops 150, Emit 6, Brush Radius 30, Brush Force 0.80×, Lateral Spread 20,
Flow 0.80, Viscosity 0.30, Damping 0.82, Deposit 0.40, Spread 12, Drying 0.008
```
Produces a tight, slow-creeping stain that bleeds gently at the edges.

### Watercolour wash
```
Drops 500, Emit 20, Brush Radius 80, Brush Force 0.50×, Lateral Spread 90,
Flow 1.20, Viscosity 0.60, Damping 0.92, Deposit 0.25, Spread 30, Drying 0.006
```
A wide, soft pool that fans out strongly while painting and continues flowing after lift-off.

### Thick oil drag
```
Drops 300, Emit 30, Brush Radius 50, Brush Force 2.00×, Lateral Spread 10,
Flow 0.60, Viscosity 0.85, Damping 0.95, Deposit 0.90, Spread 5, Drying 0.030
```
High viscosity keeps particles moving together; high force and low lateral spread drags paint like thick impasto.

### Chaotic splatter
```
Drops 800, Emit 40, Brush Radius 120, Brush Force 3.00×, Lateral Spread 300,
Flow 2.50, Viscosity 0.10, Damping 0.70, Deposit 0.50, Spread 200, Drying 0.050
```
Very wide range values to explore extreme behaviour: paint flies in all directions, dries fast.

---

## Technical Notes

- **Particle cap**: When the particle pool reaches `fluidParticleLimit`, the oldest particles are removed. This keeps performance stable regardless of stroke length.
- **Sub-stepping**: The physics integrator sub-steps up to ~90× per frame (capped at 50 ms Δt) to remain stable at low frame rates.
- **Cell grid**: Velocity averaging for viscosity uses a spatial hash grid with cell size `fluidBrushRadius × 0.45`. Particles in the same cell share velocity, so tighter radii produce finer, more independent flow.
- **Bounce**: Particles that leave the canvas boundary are reflected with a coefficient of 0.28, so they don't escape but do lose most of their speed on contact.
- **Undo**: One undo entry is pushed at stroke start (`onDown`). The full particle state is not saved — only the canvas layer content. A full undo returns the layer to its pre-stroke state and clears the particle pool implicitly on next stroke.
