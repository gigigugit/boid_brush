# Boid Brush — Platform Migration Consultation

> **Status:** Consultation / Discussion — no migration has been performed.
> **Date:** March 2026

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Performance Bottleneck Analysis](#2-performance-bottleneck-analysis)
3. [Platform Options](#3-platform-options)
4. [Addon / Fork of Existing Art Applications](#4-addon--fork-of-existing-art-applications)
5. [Comparison Matrix](#5-comparison-matrix)
6. [Recommended Path](#6-recommended-path)
7. [Migration Strategy](#7-migration-strategy)
8. [Open Questions for Discussion](#8-open-questions-for-discussion)

---

## 1. Current Architecture Summary

Boid Brush is a single-file browser application (`index.html`, ~1,070 lines) with the following stack:

| Component | Technology | Notes |
|-----------|-----------|-------|
| Boid physics | JavaScript (main thread) | O(n²) neighbor queries, no spatial partitioning |
| Brush stamping | Canvas 2D (`ctx.arc()` + `ctx.fill()`) | Interpolated stamps along boid trajectories |
| Layer compositing | WebGL2 (GLSL shaders) | 16 blend modes, ping-pong FBOs, per-layer dirty caching |
| UI / Controls | HTML + CSS (inline) | Sliders, collapsible panels, keyboard shortcuts |
| Input handling | Pointer Events API | Coalesced events, pressure sensitivity |
| Persistence | localStorage | Auto-save, presets, JSON export/import |

**What works well today:**
- WebGL2 layer compositing is efficient (GPU-accelerated, dirty-flagged)
- The brush registry pattern is clean and extensible
- Boid physics are pure math with no DOM dependencies (portable)
- At ≤25 boids, the app runs smoothly at 60fps

**What doesn't scale:**
- Boid simulation is single-threaded JavaScript on the main thread
- Canvas 2D stamping generates thousands of draw calls per frame at high boid counts
- No spatial partitioning — all boids check all other boids every frame
- Pixel sensing rebuilds a full composite image on CPU every frame

---

## 2. Performance Bottleneck Analysis

### Profiled Costs (estimated per frame at 60fps)

| Operation | 25 boids | 200 boids | Bottleneck type |
|-----------|----------|-----------|-----------------|
| Boid physics (O(n²)) | ~1-2ms | ~60-100ms | **CPU compute** |
| Stamp rendering (Canvas 2D) | ~2-5ms | ~30-60ms | **CPU draw calls** |
| Layer compositing (WebGL2) | ~0.5-1ms | ~0.5-1ms | GPU (fine) |
| Overlay rendering | ~0.5-1ms | ~2-3ms | CPU |
| Sensing image build | ~5-10ms | ~5-10ms | CPU (if enabled) |
| **Total** | **~10-20ms ✓** | **~100-170ms ✗** | — |

**The 16.6ms frame budget (60fps) is exceeded at ~50+ boids.** The two dominant costs are:

1. **O(n²) boid neighbor queries** — Each boid loops over all other boids to find neighbors for cohesion, separation, and alignment. At 200 boids that's 40,000 distance calculations per frame plus `Math.atan2` FOV checks.

2. **Canvas 2D stamp volume** — Each boid generates multiple interpolated stamps per frame. At 200 boids with moderate stroke speed, that's 5,000-10,000 `ctx.arc()` + `ctx.fill()` calls per frame.

### What a platform migration could unlock

| Metric | Current (JS/Canvas) | Realistic target (native/GPU) |
|--------|---------------------|-------------------------------|
| Max boids at 60fps | ~50 | 1,000-10,000+ |
| Stamp throughput | ~10K/frame | 100K-1M+/frame (instanced GPU) |
| Canvas resolution | Limited by main thread | 4K-8K+ with GPU rendering |
| Neighbor queries | O(n²) CPU | O(n log n) with spatial hash, or GPU parallel |

---

## 3. Platform Options

### Option A: WebGPU (stay in browser)

**What it is:** The successor to WebGL, with compute shader support — enables running boid physics on the GPU without leaving the browser.

**Pros:**
- **No distribution change** — still a web app, no install required
- **Compute shaders** solve the main bottleneck — boid physics can run entirely on the GPU in parallel
- **Instanced rendering** for stamps (one draw call for all boids)
- Existing GLSL shaders translate to WGSL with moderate effort
- Cross-platform by default (any browser)
- Can keep the same HTML/CSS UI

**Cons:**
- Browser support is still maturing (Chrome/Edge stable, Firefox/Safari catching up)
- Still bound by browser security sandbox (no file system, limited threads)
- JavaScript overhead remains for UI and orchestration
- Debugging GPU compute is harder than CPU code
- Cannot exceed browser memory limits for very large canvases

**Effort:** Medium (~2-4 weeks for compute + instanced rendering migration)
**Max boids (realistic):** 10,000-100,000+ (GPU compute)

---

### Option B: C++ with SDL2/OpenGL or Vulkan

**What it is:** A native desktop application using C++ for physics and rendering.

**Pros:**
- **Maximum raw performance** — full control over CPU threads, SIMD, GPU compute
- Multithreaded boid simulation with spatial partitioning
- GPU instanced/compute stamp rendering
- No browser overhead or garbage collection pauses
- Professional art tools (Krita, Photoshop) use this stack
- Can target very high resolutions (8K+)

**Cons:**
- **Highest development effort** — must build or adopt UI framework (Dear ImGui, Qt, etc.)
- Cross-platform build complexity (Windows/macOS/Linux)
- Manual memory management (unless using smart pointers rigorously)
- Loses the "open a URL" deployment model
- Need to implement file I/O, settings, undo system from scratch or use libraries

**Effort:** High (~2-4 months for feature parity)
**Max boids (realistic):** 100,000+ (CPU multithreaded + GPU compute)

---

### Option C: Rust with wgpu

**What it is:** A native application using Rust for safety + performance, with `wgpu` (a WebGPU-compatible GPU abstraction that runs on Vulkan/Metal/DX12/OpenGL).

**Pros:**
- **Performance on par with C++** with memory safety guarantees
- `wgpu` shaders (WGSL) are the same as WebGPU — future path to compile back to web via WASM
- Strong ecosystem for creative coding (`nannou`, `egui`, `winit`)
- No garbage collector — deterministic performance
- Can compile to WebAssembly for hybrid web/native deployment
- Growing community in creative/generative art space

**Cons:**
- **Steep learning curve** if not already familiar with Rust
- Smaller ecosystem for art/painting-specific tools compared to C++
- UI options are less mature than C++ (egui is good but not Qt-level)
- Compile times can be slow for large projects

**Effort:** High (~2-4 months for feature parity, longer if learning Rust)
**Max boids (realistic):** 100,000+ (same as C++)

---

### Option D: C# with MonoGame or Unity

**What it is:** A managed-language native app using C# for a balance of productivity and performance.

**Pros:**
- **Good balance of performance and ergonomics** — faster than JS, easier than C++
- MonoGame: lightweight framework, good for custom rendering pipelines
- Unity: full engine with compute shaders, but heavier
- Existing BrushRegistry pattern maps directly to C# interfaces
- HLSL/compute shaders for boid simulation
- Cross-platform via .NET (Windows/macOS/Linux)
- Familiar to many developers

**Cons:**
- **GC pauses** can cause micro-stutters (mitigable but not eliminable)
- MonoGame UI must be built from scratch
- Unity is overkill and brings engine overhead; also has licensing considerations
- Performance ceiling lower than C++ or Rust for extreme boid counts

**Effort:** Medium-High (~1-3 months)
**Max boids (realistic):** 10,000-50,000 (compute shaders + managed code)

---

### Option E: Godot Engine (GDScript or C#)

**What it is:** An open-source game engine with compute shader support and a built-in editor.

**Pros:**
- **Fastest time to prototype** — built-in 2D rendering, UI system, and scene management
- Compute shaders for boid simulation (Godot 4.x)
- Cross-platform export (desktop, web, mobile)
- Open source, no licensing concerns
- Can use C# or GDScript (or C++ via GDExtension for hot paths)

**Cons:**
- **Game engine overhead** — designed for games, not painting tools
- Canvas/brush rendering may fight against engine assumptions
- Less control over the rendering pipeline vs. custom solutions
- GDScript is slower than C#/C++ for heavy compute
- Brush blending modes would need custom shader work

**Effort:** Medium (~1-2 months for prototype, longer for polish)
**Max boids (realistic):** 5,000-50,000 (compute shaders)

---

### Option F: WebAssembly + Canvas/WebGPU (hybrid browser)

**What it is:** Keep the app in the browser but compile the boid physics to WebAssembly (from C, C++, or Rust) for near-native compute speed.

**Pros:**
- **Keeps the web deployment model** — no install required
- WASM boid physics can be 10-50x faster than JavaScript
- Can combine with WebGPU for GPU compute + instanced rendering
- Incremental migration — only the hot loop changes
- TypeScript/JavaScript UI code stays as-is

**Cons:**
- WASM ↔ JS interop has overhead (data passing through shared memory)
- Still limited by browser sandbox
- Debugging WASM is harder than JS
- Must set up a build toolchain (emscripten for C++, wasm-pack for Rust)
- Canvas 2D stamping bottleneck remains unless also moved to GPU

**Effort:** Low-Medium (~1-3 weeks for WASM physics, more for GPU stamps)
**Max boids (realistic):** 1,000-5,000 (WASM CPU), 10,000+ (WASM + WebGPU)

---

## 4. Addon / Fork of Existing Art Applications

A fundamentally different approach from building a standalone app: integrate Boid Brush's boid-flocking brush engine into an existing professional painting application as a **plugin/addon**, or **fork** that application and add boid brushes directly.

### How Boid Brush Maps to a Host Application

Before comparing candidates, it helps to understand which Boid Brush components are portable "brush engine" logic vs. "application shell" that a host app already provides:

| Boid Brush Component | Type | Portable? | Host App Provides? |
|----------------------|------|-----------|-------------------|
| Boid class (flocking physics) | Pure math | ✓ Fully portable | ✗ (novel — this is what we bring) |
| Spawn shapes (circle, ring, spiral, etc.) | Pure math | ✓ Fully portable | ✗ (novel) |
| Simplex noise (flow field, wander) | Pure math | ✓ Libraries exist | Partial (some apps have noise) |
| Stamp interpolation logic | Pure math | ✓ Fully portable | ✓ (host apps handle stroke interpolation) |
| Brush parameter schema (`controlDefs`) | Data | ✓ Translates to settings classes | ✓ (host apps have settings frameworks) |
| BrushRegistry pattern | Pure logic | ✓ Maps to factory/interface | ✓ (host apps have plugin registries) |
| Stamp rendering (Canvas 2D `arc()` calls) | Rendering | ✗ Must adapt | ✓ (host apps have their own paint/dab APIs) |
| Layer system + blend modes | Application | ✗ Not needed | ✓ (host apps handle layers) |
| Undo/redo | Application | ✗ Not needed | ✓ (host apps handle undo) |
| UI controls (sliders, panels) | Application | ✗ Must rebuild | ✓ (host apps have settings widgets) |
| File I/O, persistence | Application | ✗ Not needed | ✓ (host apps handle files) |

**Key insight:** Based on the current ~1,070-line codebase, roughly 60-70% of the code is "application shell" (layers, UI, undo, compositing, input handling) that a host app already provides. The novel ~30-40% — boid physics, spawn shapes, flocking forces, and the brush behavior logic — is pure math that ports to any language. (These are approximate line-count estimates; actual effort may vary.)

---

### Option G: Krita Brush Engine Plugin (C++)

**What it is:** Implement the boid-flocking brush as a new "paintop" (paint operation) plugin in Krita's brush engine framework, written in C++.

**How Krita's brush engine works:**
- Brush engines are C++ classes registered via `KisPaintopRegistry`
- Each engine subclasses `KisPaintop` and implements:
  - `paintAt(const KisPaintInformation &info)` — stamp a single dab at a point
  - `paintLine(const KisPaintInformation &pi1, const KisPaintInformation &pi2, ...)` — paint between two input points (stroke interpolation)
- Settings are managed via `KisPaintopSettings` (serializable to XML/presets)
- UI is built with `KisPaintopSettingsWidget` (Qt-based parameter panels)
- Krita provides: layers, blend modes, undo, canvas, color management, file I/O, pressure/tilt input, brush tip textures, and the entire professional painting workflow

**How Boid Brush would map:**

| Boid Brush | → Krita Plugin |
|-----------|---------------|
| `Boid` class | C++ `BoidParticle` class (pure math, straightforward port) |
| `update()` (flocking physics) | Called inside `paintLine()` — advance all boids between input points |
| `stampBoid()` (Canvas 2D `arc`) | → `KisPainter::paintAt()` or direct pixel/dab operations via `KisFixedPaintDevice` |
| `getP()` parameter cache | → `KisPaintopSettings` subclass with named properties |
| `controlDefs` (sliders, checkboxes) | → `KisPaintopSettingsWidget` subclass (Qt widgets) |
| Spawn shapes | C++ helper functions, called on stroke start |
| Simplex noise (flow field) | C++ noise library (FastNoiseLite or similar) |
| Pixel sensing | → `KisPaintDevice::pixel()` to read existing canvas content |
| Layer system, undo, blend modes | ✗ Not needed — Krita handles all of this |
| BrushRegistry | ✗ Not needed — Krita's `KisPaintopRegistry` replaces this |

**Pros:**
- **Inherit a professional painting application for free** — layers, blend modes, color management, file formats (KRA, PSD, PNG, etc.), undo/redo, canvas management, pen tablet support, HDR, CMYK, and hundreds of other features you'd never build yourself
- **C++ performance** — boid physics run natively, no JavaScript bottleneck
- **Krita already handles stroke interpolation** — `paintLine()` receives smoothed input; you focus on the boid simulation
- **Large existing user base** — Krita users could discover and use boid brushes immediately
- **Presets system** — boid brush configurations become shareable `.kpp` preset files
- **GPU acceleration is possible** — Krita supports OpenGL/Vulkan rendering; compute shaders could accelerate the boid simulation
- **Open source (GPL)** — no licensing cost, can be distributed as a plugin

**Cons:**
- **C++ required** — must write the plugin in C++ with Qt/KDE dependencies
- **Large build environment** — Krita's full source tree + dependencies (Qt, KDE Frameworks, Boost, etc.) needed to build plugins
- **Steep learning curve for Krita internals** — the paintop API is powerful but not heavily documented; requires reading existing engine source code (Pixel, Bristle, Spray are good references)
- **Stroke model mismatch** — Krita calls `paintLine()` per input segment; Boid Brush runs boids continuously between frames. Need to adapt: advance boid simulation within `paintLine()` calls, generating dabs along boid trajectories
- **No Python path for brush engines** — Krita's Python scripting can automate tasks and create tool plugins, but **cannot** create new brush engines (paintops require C++)
- **Plugin distribution** — must be compiled per platform (Windows/macOS/Linux) or merged upstream into Krita's source tree
- **Coupling to Krita's release cycle** — API changes in Krita may require plugin updates

**Effort:** High (~2-3 months for a working prototype, longer for polish)
**Performance ceiling:** Excellent — native C++ with potential GPU compute

---

### Option H: Fork of Krita

**What it is:** Fork Krita's entire source repository and add boid brush as a built-in brush engine.

**Pros:**
- **Full control** — can modify any part of Krita (canvas rendering, brush engine framework, UI)
- **No plugin API constraints** — can add boid-specific features to the core (e.g., overlay visualization of boid trails, custom canvas interactions)
- **If merged upstream**, becomes part of Krita for all users
- Same C++ performance benefits as the plugin approach

**Cons:**
- **Massive maintenance burden** — Krita is 1.5M+ lines of C++; you inherit all of it
- **Must keep fork in sync** with upstream Krita to get bug fixes and features — merge conflicts are inevitable
- **Overkill for a brush engine** — a plugin achieves the same result without forking
- **Community friction** — Krita's maintainers prefer contributions as plugins or upstream PRs, not competing forks
- **Build complexity** — full Krita builds require significant infrastructure

**Recommendation:** **Plugin is strongly preferred over fork.** A fork only makes sense if you need to modify Krita's core painting pipeline in ways the plugin API doesn't allow — which is unlikely for a boid brush. If the plugin works well, it can be submitted upstream to become part of Krita proper.

**Effort:** Very High (same as plugin + ongoing merge maintenance)

---

### Option I: GIMP Plugin (Python or C)

**What it is:** Implement boid brush behavior as a GIMP plugin.

**How GIMP plugins work:**
- **Python-Fu** (Python 3 in GIMP 3.x): Full access to GIMP's Procedure Database (PDB) — can call `gimp-paintbrush`, `gimp-pencil`, manipulate images, create tools
- **C plugins**: Deeper access, can register new tools and painting functions
- GIMP's plugin system is more "automation" oriented — you script actions using existing tools rather than creating new real-time brush engines

**Mapping challenge:**
- GIMP does **not** expose a real-time brush engine plugin API like Krita's `KisPaintop`
- You cannot create a new "brush engine" that runs during live painting via Python-Fu
- A Python plugin could simulate boid painting by programmatically calling `gimp-paintbrush` in a loop, but this would be:
  - **Not real-time** — runs as a batch operation after the fact
  - **No live visual feedback** — boids wouldn't visually follow the cursor
  - **Limited to existing brush tips** — can't define custom dab generation

**Pros:**
- Python is easier than C++
- GIMP has a large user base
- Could work as a "generate boid stroke from path" tool (non-real-time)

**Cons:**
- **Cannot create real-time brush engines** — fundamental limitation
- No live boid visualization during painting
- Performance would be poor (Python + PDB call overhead per stamp)
- **Not a viable path for the Boid Brush experience**

**Verdict:** GIMP is **not suitable** for a real-time boid brush. The plugin model doesn't support custom real-time brush engines. It could only work as a non-interactive batch tool, which loses the core appeal of Boid Brush.

---

### Option J: MyPaint / libmypaint Integration

**What it is:** Integrate boid behavior into [libmypaint](https://github.com/mypaint/libmypaint), the standalone brush engine library used by MyPaint, GIMP, and Krita.

**How libmypaint works:**
- A C library with a clean abstraction: `MyPaintBrush` (processes input → generates dabs) + `MyPaintSurface` (receives dabs → renders pixels)
- Brush behavior is defined by JSON settings files mapping inputs (pressure, speed, tilt) to outputs (radius, opacity, color shift)
- **No plugin API for custom brush algorithms** — all customization is via parameter mapping, not code

**Mapping challenge:**
- libmypaint's brush model is fundamentally single-cursor: one input position → one dab output
- Boid Brush needs **multiple autonomous agents** generating dabs simultaneously from a single input
- This is architecturally incompatible with libmypaint's single-point-in-single-dab-out model
- Would require modifying libmypaint's core C code, not just JSON settings

**Pros:**
- If modified, changes would propagate to all apps using libmypaint (GIMP, MyPaint, etc.)
- C performance for boid physics
- Clean architecture

**Cons:**
- **Architecturally incompatible** — single-cursor model vs. multi-agent model
- No plugin system — requires forking/modifying libmypaint source
- Very niche library; small maintainer community
- Changes unlikely to be accepted upstream (too specialized)

**Verdict:** libmypaint's architecture is a **poor fit** for boid brushes. The single-cursor-to-single-dab model doesn't accommodate swarm behavior. Modifying the core would be a deep fork with maintenance burden and little community benefit.

---

### Addon/Fork Summary

| Approach | Feasibility | Real-time? | Performance | Effort | Recommended? |
|----------|-------------|------------|-------------|--------|-------------|
| **G: Krita Plugin** | ✓ Excellent | ✓ Yes | C++ native | High (2-3 months) | **✓ Yes — best addon path** |
| **H: Krita Fork** | ✓ Possible | ✓ Yes | C++ native | Very High + maintenance | ✗ Plugin preferred |
| **I: GIMP Plugin** | ✗ Limited | ✗ No (batch only) | Python (slow) | Medium | ✗ Not suitable |
| **J: libmypaint** | ✗ Poor fit | ✗ Architecture mismatch | C native | Very High (core mod) | ✗ Not suitable |

**Bottom line:** If integrating into an existing art application, **Krita plugin (Option G) is the clear winner**. Krita's `KisPaintop` framework is specifically designed for custom brush engines, the API maps well to Boid Brush's architecture, and you get a professional painting application for free.

---

## 5. Comparison Matrix

| Criteria | A: WebGPU | B: C++/SDL2 | C: Rust/wgpu | D: C#/MonoGame | E: Godot | F: WASM+WebGPU | G: Krita Plugin |
|----------|-----------|-------------|-------------|---------------|----------|----------------|-----------------|
| **Max boids (60fps)** | 10K-100K | 100K+ | 100K+ | 10K-50K | 5K-50K | 1K-10K+ | 10K-100K+ |
| **Development effort** | Medium | High | High | Medium-High | Medium | Low-Medium | High |
| **Learning curve** | Low | High | Very High | Medium | Low-Medium | Low-Medium | High (C++ / Krita API) |
| **Cross-platform** | ✓ (browser) | Build per OS | Build per OS | .NET multi-OS | Export per OS | ✓ (browser) | ✓ (Krita runs on all) |
| **Distribution** | URL | Installer | Installer | Installer | Installer/Web | URL | Krita plugin / upstream |
| **UI maturity** | HTML/CSS | Dear ImGui/Qt | egui | WinForms/WPF | Built-in | HTML/CSS | ✓ Qt (Krita provides) |
| **GPU compute** | ✓ (compute shaders) | ✓ (OpenGL/Vulkan) | ✓ (wgpu) | ✓ (HLSL) | ✓ (Godot 4) | ✓ (WebGPU) | ✓ (OpenGL/Vulkan) |
| **Stamp rendering** | GPU instanced | GPU instanced | GPU instanced | GPU instanced | GPU instanced | GPU instanced | Krita paint API |
| **Code reuse from current** | High (GLSL→WGSL) | Medium (math ports) | Medium (math ports) | Medium (math ports) | Low-Medium | High | Medium (math ports to C++) |
| **Future scalability** | Good | Excellent | Excellent | Good | Good | Good | Excellent (Krita ecosystem) |
| **Professional art tool viable** | Limited | ✓ | ✓ | ✓ | Possible | Limited | **✓ Already professional** |
| **Layers, undo, file I/O** | Must build | Must build | Must build | Must build | Built-in | Must build | **✓ Free (Krita provides)** |
| **Existing user base** | None | None | None | None | None | None | **✓ Krita's millions of users** |

---

## 6. Recommended Path

### If the goal is **maximum performance with professional tool ambitions**:

> **Recommendation: Option G (Krita plugin) or Option C (Rust + wgpu) or Option B (C++ with SDL2/Vulkan)**
>
> A Krita plugin gives you a professional painting application for free — layers, blend modes, color management, file formats, tablet support, and an existing user base. You write only the boid simulation and dab generation in C++. If you want full control over the entire experience (custom UI, custom canvas, custom rendering pipeline), a standalone app in Rust or C++ is the way to go.

### If the goal is **fastest improvement with least disruption**:

> **Recommendation: Option F (WASM + WebGPU hybrid), then Option A (full WebGPU)**
>
> This is an incremental path:
> 1. **Phase 1:** Compile boid physics to WASM (Rust or C) — keeps everything in the browser, 10-50x physics speedup, ~1-3 weeks effort.
> 2. **Phase 2:** Migrate stamp rendering and compositing to WebGPU with compute shaders and instanced drawing — another 10-100x for rendering, ~2-4 weeks.
> 3. **Phase 3:** Optionally extract to a native app later, reusing the Rust/WASM core.

### If the goal is **exploring and learning**:

> **Recommendation: Option C (Rust + wgpu)**
>
> Rust is an excellent learning investment. The `wgpu` ecosystem has a vibrant creative-coding community, and the same code can target both native and web (via WASM). The boid physics are pure math and translate cleanly.

### If the goal is **integrating into an existing professional art tool**:

> **Recommendation: Option G (Krita brush engine plugin)**
>
> Krita is the only viable host application. Its `KisPaintop` framework is specifically designed for custom brush engines, and its API maps well to Boid Brush's architecture. GIMP lacks a real-time brush engine plugin API, and libmypaint's single-cursor model is architecturally incompatible with swarm brushes.
>
> **Tradeoff vs. standalone app:** You get layers, undo, blend modes, file I/O, color management, and millions of existing users for free — but you must write C++, deal with Krita's build system, and work within Krita's stroke model (adapting continuous boid simulation to `paintLine()` callbacks).

---

## 7. Migration Strategy

Regardless of which platform is chosen, the migration can follow this general phased approach:

### Phase 1: Optimize Within Current Platform (optional, quick wins)
- Add spatial hashing for boid neighbor queries (O(n²) → O(n))
- Batch Canvas 2D stamps with `Path2D` objects
- Move sensing image rebuild off main thread with `OffscreenCanvas` + Web Worker
- **Estimated improvement:** 2-4x more boids at 60fps (~100-200 boids)
- **Effort:** ~1 week

### Phase 2: Core Compute Migration
- Port boid physics to target platform (WASM, Rust, C++, or GPU compute shader)
- Validate physics match (record JS boid trajectories, compare with ported version)
- **Estimated improvement:** 10-50x physics throughput
- **Effort:** 1-4 weeks depending on platform

### Phase 3: Rendering Migration
- Move stamp rendering to GPU (instanced rendering or compute → texture)
- Port layer compositing shaders (GLSL → WGSL/HLSL/Metal)
- Implement brush parameter system in target platform
- **Effort:** 2-4 weeks

### Phase 4: UI & Feature Parity
- Rebuild controls UI (or keep HTML if browser-based)
- Port layers panel, presets, persistence, undo/redo
- Port selection, clipboard, keyboard shortcuts
- **Effort:** 2-6 weeks (most effort for native platforms)

### What Ports Easily (from current codebase)

| Component | Portability | Notes |
|-----------|-------------|-------|
| Boid class + physics | ✓ Easy | Pure math, no DOM deps |
| GLSL blend mode shaders | ✓ Easy | Standard math, direct WGSL/HLSL translation |
| Spawn shape functions | ✓ Easy | Pure geometry math |
| Simplex noise | ✓ Easy | Standard algorithm, libraries exist everywhere |
| Brush parameter schema | ✓ Easy | `controlDefs` array is a clean data schema |
| Stamp interpolation logic | ✓ Easy | Simple linear interpolation |
| Layer system | Medium | Data model is simple; GPU texture management varies by platform |
| Undo/redo | Medium | Canvas snapshot approach may change to command pattern |
| UI (HTML/CSS) | ✗ Rebuild | Must be rebuilt for native platforms; stays for web |
| Pointer/pressure input | ✗ Platform-specific | Each platform has its own input API |
| Settings persistence | ✗ Platform-specific | localStorage → file system or registry |

---

## 8. Open Questions for Discussion

Before deciding, consider these questions:

1. **What is the target boid count?**
   - 200-500 boids? → WASM or WebGPU in-browser is sufficient.
   - 1,000-10,000? → WebGPU compute shaders or native app.
   - 10,000-100,000+? → Native app (Rust/C++) with GPU compute is required.

2. **Is web distribution important?**
   - If yes → WebGPU or WASM hybrid keeps the "share a URL" model.
   - If no → Native app gives more power and fewer constraints.

3. **Is this intended to become a professional tool?**
   - If yes → C++ or Rust for long-term viability, industry compatibility.
   - If no → WebGPU or Godot for faster iteration.

4. **What languages are you most comfortable with?**
   - Already know C++? → Option B is fastest to productive.
   - Already know Rust? → Option C is ideal.
   - Prefer to stay in JS/TS? → Options A or F keep you in familiar territory.
   - Know C#? → Option D or E are practical choices.

5. **How important is mobile/tablet support?**
   - Web options (A, F) work on tablets out of the box.
   - Native apps need explicit mobile builds (harder for C++/Rust, easier for Godot/Unity).

6. **Should we try quick wins first?**
   - Adding spatial hashing + batched Canvas 2D could get to ~100-200 boids at 60fps with ~1 week of work, without any platform change. This could buy time while planning a larger migration.

7. **Plugin or standalone — what matters more?**
   - **Plugin (Krita):** You get a professional app for free but give up control over UI/UX and are constrained by Krita's stroke model and C++ requirement.
   - **Standalone:** Full creative control over the entire experience but must build everything (layers, undo, file I/O, etc.) from scratch.
   - **Hybrid approach:** Start as a Krita plugin to validate the brush engine in a real art workflow, then spin off a standalone app later if needed — the C++ boid physics code is reusable either way.

8. **Are you comfortable with C++ and Krita's build environment?**
   - Krita requires Qt, KDE Frameworks, CMake, and a substantial build chain.
   - If C++ is not in your comfort zone, a standalone app in a language you know (Rust, C#, or even staying in JS with WebGPU) may be more productive.
   - Krita's plugin API documentation is sparse — expect to read a lot of source code from existing engines (Pixel, Bristle, Spray, Particle are good starting points).

---

*This document is a living consultation. Update it as decisions are made and directions are chosen.*
