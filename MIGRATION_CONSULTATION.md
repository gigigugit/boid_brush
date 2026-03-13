# Boid Brush — Platform Migration Consultation

> **Status:** Consultation / Discussion — no migration has been performed.
> **Date:** March 2026

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Performance Bottleneck Analysis](#2-performance-bottleneck-analysis)
3. [Platform Options](#3-platform-options)
4. [Comparison Matrix](#4-comparison-matrix)
5. [Recommended Path](#5-recommended-path)
6. [Migration Strategy](#6-migration-strategy)
7. [Open Questions for Discussion](#7-open-questions-for-discussion)

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

## 4. Comparison Matrix

| Criteria | A: WebGPU | B: C++/SDL2 | C: Rust/wgpu | D: C#/MonoGame | E: Godot | F: WASM+WebGPU |
|----------|-----------|-------------|-------------|---------------|----------|----------------|
| **Max boids (60fps)** | 10K-100K | 100K+ | 100K+ | 10K-50K | 5K-50K | 1K-10K+ |
| **Development effort** | Medium | High | High | Medium-High | Medium | Low-Medium |
| **Learning curve** | Low | High | Very High | Medium | Low-Medium | Low-Medium |
| **Cross-platform** | ✓ (browser) | Build per OS | Build per OS | .NET multi-OS | Export per OS | ✓ (browser) |
| **Distribution** | URL | Installer | Installer | Installer | Installer/Web | URL |
| **UI maturity** | HTML/CSS | Dear ImGui/Qt | egui | WinForms/WPF | Built-in | HTML/CSS |
| **GPU compute** | ✓ (compute shaders) | ✓ (OpenGL/Vulkan) | ✓ (wgpu) | ✓ (HLSL) | ✓ (Godot 4) | ✓ (WebGPU) |
| **Stamp rendering** | GPU instanced | GPU instanced | GPU instanced | GPU instanced | GPU instanced | GPU instanced |
| **Code reuse from current** | High (GLSL→WGSL) | Medium (math ports) | Medium (math ports) | Medium (math ports) | Low-Medium | High |
| **Future scalability** | Good | Excellent | Excellent | Good | Good | Good |
| **Professional art tool viable** | Limited | ✓ | ✓ | ✓ | Possible | Limited |

---

## 5. Recommended Path

### If the goal is **maximum performance with professional tool ambitions**:

> **Recommendation: Option C (Rust + wgpu) or Option B (C++ with SDL2/Vulkan)**
>
> These give the highest performance ceiling and the most control. Rust's safety guarantees reduce crash risk, and `wgpu` shaders are forward-compatible with WebGPU for potential web builds later. C++ is the industry standard for professional art tools but carries more maintenance burden.

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

---

## 6. Migration Strategy

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

## 7. Open Questions for Discussion

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

---

*This document is a living consultation. Update it as decisions are made and directions are chosen.*
