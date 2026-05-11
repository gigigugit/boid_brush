# AI Agent Guidance for Boid Brush WebGPU Rendering

## Purpose

This repository is a browser-based painting application with:

- vanilla JavaScript ES modules
- HTML/CSS served directly without a JS build step
- a Rust/WASM simulation engine in `wasm-sim/`
- brush rendering paths that may run on CPU, WASM, WebGL2 compositing, or WebGPU

The current development goal is to get **brush rendering processed on the GPU rather than CPU** for speed, while preserving existing painting behavior and visual output.

This file provides instructions for AI agents generating, modifying, reviewing, or debugging code related to:

- WebGPU rendering
- brush stamp generation
- boid brush rendering
- simple brush rendering
- compositing stamps onto the visible canvas
- persistent paint accumulation
- simulation mode vs normal drawing mode
- debugging invisible brush output

The main intent is to prevent repeated non-fixes and force explicit reasoning about **where brush marks are lost between simulation, rendering, persistence, and presentation**.

---

## Current Known Behavior

Assume the following behavior is accurate and must be explained by any proposed change.

### Baseline behavior on current main branch

- The **WASM path works well functionally**, but is slower than desired.
- The goal is to make **WebGPU rendering actually work correctly** and become the preferred fast path.

### Simple Brush behavior

- In **Simple Brush**, when the UI shows:
  - `Render: webgpu`
- there **is visible stamping**
- but it is **somewhat slow**

Interpretation:

- the WebGPU rendering path is **not universally broken**
- some part of the WebGPU pipeline already produces visible results on the canvas
- agents must **not** assume “WebGPU is completely nonfunctional”
- instead, compare what is different between **Simple Brush** and **Boid Brush**

### Boid Brush behavior

- In **Boid Brush simulation mode**, there is **one set of visible stamps**
- In **Boid Brush drawing/normal mode**, there are **no visible stamps**
- this occurs while the UI shows:
  - `agents: 60 | sim: webgpu | render: webgpu`

Interpretation:

- boid simulation data may be updating
- WebGPU simulation may be running
- at least one render-related path can produce visible output in simulation mode
- but the normal drawing path is failing to place visible committed brush marks on the visible canvas

This means the likely failure is **not just “WebGPU unavailable”**, but a mismatch between:

- simulation output
- brush stamp generation
- persistent paint accumulation
- final compositing to the visible canvas

---

## Primary Problem Statement

The specific problem to solve is:

> WebGPU-based rendering for brush output is not reliably producing visible stamps on the final canvas, especially for Boid Brush in normal drawing mode, despite the app indicating that simulation and rendering are both using WebGPU.

Any generated code, review, or analysis must focus on this exact question:

## “Where do the Boid Brush stamps disappear between simulation output and visible canvas presentation?”

---

## Final Rule

For this repository, the main question is not:

> “Can WebGPU run?”

The main question is:

> “Why do Boid Brush stamps fail to become visible in normal drawing mode even when simulation and render both report WebGPU?”

All generated code and reasoning should stay centered on that exact failure.

---

## Repository Context

When working in `boid_brush`, assume these architectural constraints:

- `app.html` contains the single-page shell and inline CSS
- `app.js` contains core app logic, layers, canvas handling, events, view transforms, and simulation mode wiring
- `brushes.js` contains brush engine classes including:
  - `BoidBrush`
  - `SimpleBrush`
  - other brush implementations
- `compositor.js` handles WebGL2 compositing and fallback behavior
- `wasm-sim/` contains the Rust/WASM simulation engine

Agents should preserve the existing architecture where possible and prefer **targeted fixes** over broad rewrites.

---

## Primary Investigation Focus

When working on this issue, focus specifically on the rendering path for:

- `SimpleBrush` with WebGPU render enabled
- `BoidBrush` in simulation mode
- `BoidBrush` in normal drawing mode

The task is to identify:

1. what data exists in each mode
2. which rendering path is used in each mode
3. which target receives the brush output
4. which target is finally shown to the user
5. where the Boid Brush normal-mode path diverges from a working path

---

## Non-Negotiable Reasoning Rules

### 1. Do not treat “simulation works” as “rendering works”

For Boid Brush, simulation and rendering are distinct stages.

A correct analysis must separate:

1. boid state update
2. boid positions or trajectories
3. conversion of boid state into stamp instances, quads, points, or brush marks
4. rasterization into a paint target or intermediate texture
5. compositing into the visible canvas

If boids simulate but no marks appear, the problem may be in stages 3–5, not stage 1.

### 2. Do not treat “one visible set of stamps in simulation mode” as success

If simulation mode shows one set of stamps but normal mode shows none, suspect one of these:

- simulation mode draws ephemeral preview output directly
- normal mode expects persistent paint accumulation but does not write to the persistent target
- a one-frame render occurs but is not committed
- simulation mode and normal mode use different render passes or targets
- normal mode clears or replaces the output before presentation

Agents must explicitly determine what is different between these two modes.

### 3. Compare Simple Brush and Boid Brush before inventing new architecture

Because Simple Brush with `Render: webgpu` produces visible stamps, it provides a working reference path.

Before proposing major rewrites, compare:

- target textures
- pass order
- bind groups
- vertex generation
- coordinate conversion
- blending
- persistent layer writes
- final canvas compositing

The first debugging move should be:

> “What does Simple Brush do that Boid Brush does not?”

### 4. Distinguish clearly between preview rendering and committed painting

In painting apps, “I can see a stroke once” is not the same as “the stroke is committed to the painting layer.”

Agents must determine whether Boid Brush:

- renders only a transient preview
- writes only to a temporary frame texture
- fails to commit marks to the persistent layer/canvas state
- commits, but the committed layer is not composited back to screen

### 5. Do not assume the visible canvas is the painting state

If the app is built like a painting system, the visible canvas is often only the final presentation target.

Persistent brush marks should usually live in:

- a layer canvas
- a backing bitmap
- an offscreen texture
- a persistent paint texture

If rendering is done only into the current presented texture, results may disappear next frame.

### 6. Prefer proving each stage over guessing

Any useful debugging or code change should explicitly verify:

- data exists
- instance generation happens
- draw calls execute
- output reaches the intended target
- target content survives
- final compositing presents the result

Do not skip intermediate verification.

---

## Required Comparison Questions

Any useful analysis or generated patch must answer these questions.

### Simple Brush WebGPU path

- How are stamps generated?
- What target do they render into?
- How do they become visible?
- Why do they persist?

### Boid Brush simulation mode

- What exactly is being drawn?
- Is it a preview, debug visualization, or committed brush output?
- Is it drawn directly to the visible canvas?
- Is it drawn only once per frame?

### Boid Brush normal mode

- Are boid positions produced?
- Are stamp instances generated from those positions?
- Is the draw call executed?
- Is the draw call targeting the correct texture or canvas?
- Is the result preserved after the pass?
- Is the target later composited onto the visible canvas?

If these questions are not answered, the work is incomplete.

---

## Most Likely Failure Categories

Agents should prioritize these hypotheses before proposing unrelated changes.

### 1. Simulation output exists, but no render instances are emitted in normal mode

Possible symptoms:

- boids update
- no visible marks
- simulation mode may still show something

Check:

- whether boid positions are converted into stamp data in normal mode
- whether normal mode short-circuits stamp emission
- whether the instance count is zero
- whether Boid Brush uses a different commit path than Simple Brush

### 2. Stamps are rendered to the wrong target

Possible symptoms:

- rendering appears to run
- nothing visible on final canvas

Check:

- whether boid normal mode renders into an offscreen texture never presented
- whether it renders into a temporary texture instead of the persistent paint target
- whether the final composite pass samples the wrong texture

### 3. Stamps are rendered for one frame only and then lost

Possible symptoms:

- simulation mode shows one transient set
- normal mode appears blank
- visible output does not persist

Check:

- whether drawing is done directly to `context.getCurrentTexture()`
- whether the paint result is stored anywhere persistent
- whether the next frame clears the target

### 4. Normal mode uses a pass that clears before compositing prior paint

Possible symptoms:

- draw call executes
- final result vanishes
- behavior remains unchanged across many attempted fixes

Check:

- `loadOp`
- `storeOp`
- pass ordering
- whether persistent layers are redrawn every frame

### 5. Coordinate conversion differs between Boid Brush and Simple Brush

Possible symptoms:

- Simple Brush visible
- Boid Brush invisible
- boid positions may be in simulation space, world space, or normalized space instead of paint-target pixel space

Check:

- boid-space to canvas-space conversion
- zoom/pan/rotation transforms
- device pixel ratio
- viewport bounds
- whether boid positions fall outside the visible render area

### 6. Blend or alpha output makes the boid marks effectively invisible

Possible symptoms:

- draw calls happen
- fragments are written with low or zero alpha
- output blends away

Check:

- fragment shader output color and alpha
- premultiplied alpha assumptions
- blend factors
- brush falloff values
- whether normal mode uses different opacity math than simulation mode

### 7. Simulation mode and normal mode use different rendering code paths

Possible symptoms:

- one mode works partially
- the other does not
- repeated changes do not affect behavior

Check:

- whether simulation mode uses debug rendering
- whether normal mode uses a separate pipeline
- whether only one path is actually wired to the current canvas

---

## WebGPU Rules for This Repo

### 1. Always identify the texture lifecycle

For every texture involved, state:

- who creates it
- what usage flags it has
- whether it is persistent or per-frame
- whether it is sampled, copied, or rendered into
- whether it is ever shown on screen

Never refer vaguely to “the render texture” if multiple textures exist.

### 2. Always distinguish the visible canvas from offscreen paint storage

Always identify:

- the `GPUCanvasContext` current texture
- any persistent painting texture
- any intermediate compositing texture
- any temporary preview or stamp texture

Do not assume rendering to an offscreen texture automatically makes it visible. A texture becomes visible only if it is copied, sampled, or composited into the final pass targeting the current canvas texture.

### 3. Reacquire the current canvas texture every frame

Do not cache `context.getCurrentTexture()` across frames.

The final visible render pass must target the current frame’s canvas texture view.

### 4. Persistent paint must not rely on the swapchain texture

If a stroke should remain visible after the frame ends, it must be written to persistent paint storage or re-rendered from persistent state every frame.

### 5. Validate all required texture usage flags

Common needed flags:

- `GPUTextureUsage.RENDER_ATTACHMENT`
- `GPUTextureUsage.TEXTURE_BINDING`
- `GPUTextureUsage.COPY_SRC`
- `GPUTextureUsage.COPY_DST`

Do not assume a texture can be sampled or copied unless the flags allow it.

### 6. Inspect load and store ops every time output disappears

If output is expected to survive after a pass:

- use `storeOp: "store"`

If appending to an existing target:

- use `loadOp: "load"`

If a pass uses `loadOp: "clear"` or otherwise recreates its target, verify that prior paint data is intentionally restored.

### 7. Re-render the full visible scene if persistence is state-driven

If the app architecture is state-driven rather than directly painting pixels to a persistent GPU surface, assume the visible frame should be reconstructed each frame from:

- background
- existing paint layer(s)
- current stroke preview
- overlays/debug UI if applicable

Do not assume pixels from a previous frame remain on screen by default.

### 8. Respect canvas size, device pixel ratio, and coordinate spaces

Brush marks may be “missing” because they are rendered off-screen, clipped, or too small.

Always verify:

- CSS canvas size vs backing store size
- device pixel ratio handling
- pointer coordinates converted into render-target pixel space
- clip-space conversion
- viewport/scissor settings
- Y-axis orientation

### 9. Validate shader output explicitly during debugging

When invisible stamps are reported:

- replace fragment logic with solid opaque output
- test with a single centered stamp or quad
- verify visibility before restoring full brush math

If a solid color appears, the issue is likely in:
- mask sampling
- UVs
- alpha computation
- blend state
- falloff logic

If a solid color does not appear, inspect:
- target selection
- geometry coordinates
- bind groups
- pipeline state
- pass execution
- final presentation

### 10. Submit command buffers and verify pass ordering

Always confirm the rendering sequence is actually submitted:

1. create command encoder
2. begin pass(es)
3. issue draw calls
4. end pass(es)
5. finish encoder
6. `device.queue.submit([...])`

If offscreen rendering and final compositing both occur, verify their ordering.

---

## Required Debugging Strategy

When debugging Boid Brush normal-mode WebGPU rendering, follow this order.

### Step 1: Verify data existence

Determine whether boid positions or stamp instances actually exist in normal mode.

Questions:

- Is the boid simulation producing positions?
- Are those positions converted into draw instances?
- Is instance count nonzero?

### Step 2: Verify draw execution

Determine whether a draw call actually happens.

Questions:

- Does the pipeline execute?
- Is the vertex/index/instance count correct?
- Are bind groups valid?

### Step 3: Verify target correctness

Determine what texture or canvas receives the output.

Questions:

- Is the draw call targeting a persistent paint texture?
- Is it targeting only a temporary or preview texture?
- Is it targeting the visible canvas?
- Is it targeting a texture that is later sampled or copied?

### Step 4: Verify output visibility

Determine whether the texture with the rendered marks is composited to the visible canvas.

Questions:

- Which pass samples the rendered result?
- Does the final pass target `context.getCurrentTexture().createView()`?
- Is the correct texture bound in that pass?

### Step 5: Verify persistence

Determine whether the output survives into subsequent frames.

Questions:

- Is the target cleared next frame?
- Is previous paint re-rendered?
- Is normal mode missing the commit step used by Simple Brush?

### Step 6: Verify visual correctness assumptions

Determine whether marks are technically rendered but visually hidden.

Questions:

- Is alpha nonzero?
- Are stamps drawn inside the viewport?
- Is blending masking the output?
- Are marks too small, transparent, or off-canvas?

---

## Mandatory Comparison Method

When generating code or analysis, use this comparison sequence:

1. Trace the **Simple Brush WebGPU path**
2. Trace the **Boid Brush simulation-mode path**
3. Trace the **Boid Brush normal-mode path**
4. Identify the first point where the normal-mode path diverges from a working path
5. Fix that divergence first

Do not skip directly to speculative shader rewrites or architecture changes.

---

## Guidance for AI Code Generation

When writing or modifying code for this issue:

- prefer minimal, targeted changes
- preserve working WASM behavior as a reference
- preserve working Simple Brush behavior
- preserve simulation-mode behavior unless a direct bug requires adjustment
- add explicit comments around:
  - where boid positions become renderable stamps
  - what texture receives committed paint
  - what pass presents the result to screen
- avoid broad refactors unless necessary to expose the actual failing path
- do not claim the issue is fixed unless the patch explains why:
  - Simple Brush still works
  - Boid Brush simulation mode still works
  - Boid Brush normal mode now shows visible stamps

### Preferred code qualities

- explicit function names
- explicit target names
- explicit mode branching
- explicit commit/present distinction
- traceable texture ownership
- explicit pass ordering

### Avoid

- hidden state transitions
- mixing preview and committed paint logic
- caching per-frame canvas textures
- introducing another intermediate texture without documenting its role
- changing multiple unrelated systems at once
- falling back silently to CPU while claiming GPU success

---

## Required Debug Instrumentation

If you add temporary debug code, prefer instrumentation that can answer these exact questions:

- How many boid render instances are emitted in normal mode?
- What texture is the Boid Brush rendering into?
- Is the normal-mode pass running at all?
- Is the output texture later sampled in the final composite pass?
- Is alpha nonzero for the produced fragments?
- Are boid positions inside visible render bounds?

Good temporary debugging additions include:

- logging instance counts
- rendering boid stamps as opaque solid circles or quads
- fullscreen display of the intermediate paint texture
- toggles to inspect preview texture vs committed paint texture
- temporary overlays for stamp centers and bounds
- temporary rendering of one known test stamp at canvas center

---

## Debugging Checklist for Invisible Brush Stamps

When brush stamps do not appear on the visible canvas, check in this order:

1. input event or brush update path fires
2. boid state updates as expected
3. boid positions are converted into renderable stamp instances
4. the instance count is nonzero
5. the draw call executes
6. the draw call targets the intended texture
7. the target has correct usage flags
8. the output survives after the pass
9. the output texture is sampled or copied in the final composite pass
10. the final pass targets `context.getCurrentTexture().createView()`
11. commands are submitted
12. a later pass is not clearing or replacing the result
13. marks are inside the visible area
14. alpha and blend state do not hide the marks
15. committed paint persists across frames

---

## Red Flags That Usually Mean the Fix Is Wrong

Be skeptical of generated solutions if they:

- say “WebGPU works” without explaining why Boid Brush normal mode is blank
- modify simulation logic without tracing render-target flow
- only change shader math without comparing Simple Brush vs Boid Brush
- add more buffers or textures without explaining presentation
- claim success based on simulation mode alone
- confuse “one visible frame” with “committed painting works”
- do not identify where normal mode diverges from the working path
- do not explain persistence
- do not explain why the final canvas remained blank before the fix

---

## Concrete Working Theory to Test First

Agents should start from this working theory:

> Simple Brush proves there is at least one WebGPU rendering path that reaches the visible canvas.  
> Boid Brush simulation mode proves some boid-related GPU path can produce visible output.  
> Therefore, the most likely bug is that Boid Brush normal-mode stamps are either not being emitted, not being committed to the persistent paint target, or not being composited into the final visible canvas.

Test this theory before proposing anything more exotic.

---

## Acceptance Criteria for a Real Fix

A proposed solution is only credible if it makes the following true:

1. `Simple Brush` with `Render: webgpu` still shows visible stamps
2. `Boid Brush` in simulation mode still shows expected simulated output
3. `Boid Brush` in normal drawing mode shows visible stamps
4. Boid Brush marks are rendered through the GPU path rather than falling back silently to CPU
5. The path from boid state → stamp generation → paint target → final canvas is explicit and traceable
6. The explanation identifies the exact failure point that previously caused invisible output
7. The fix does not rely on accidental one-frame visibility
8. The output persists or redraws correctly according to the intended architecture

---

## Agent Output Expectations

When summarizing a diagnosis or proposing a fix, explicitly state:

- whether the issue is in simulation, stamp generation, rasterization, persistence, or presentation
- what the render target is before the fix
- what the render target is after the fix
- why marks were previously invisible
- why they should now be visible
- whether the result is persistent or recomputed each frame

Do not provide vague conclusions such as “updated the WebGPU path” without tracing the actual flow.

---

## Preferred Mental Model

For this repository, assume the rendering flow should be reasoned about like this:

1. input or simulation produces boid state
2. boid state is converted into stamp geometry or instances
3. stamps are rasterized into a paint target or layer target
4. committed paint is preserved or reproducible
5. final compositing draws that result to the current canvas texture
6. the visible frame is presented

If any one of these stages is missing, blank output is expected.

---

## Minimal Success Definition

A minimal successful WebGPU rendering path for Boid Brush normal mode must make it possible to answer:

- Where are boid positions produced?
- Where are stamp instances created?
- Which pass actually draws them?
- Which texture receives the result?
- How does that result reach the visible canvas?
- Why does the result remain visible after the frame ends?

If these questions cannot be answered clearly, the implementation is not complete.

---

## Closing Instruction

For this repository, do not optimize for elegance before correctness.

First make the Boid Brush normal-mode WebGPU path:

- traceable
- visible
- persistent or correctly redrawn
- comparable to the working Simple Brush path

Only after that should performance tuning or abstraction cleanup be considered.