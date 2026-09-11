# Boid Brush — Native Prototype (Phase 1)

A minimal C++ / SDL2 / Vulkan port of the browser-based Boid Brush, focused on core boid-flocking brush behavior.

## What's Included (Phase 1)

| Feature | Status |
|---------|--------|
| SDL2 window + Vulkan display | ✓ |
| Mouse input (click-drag to paint) | ✓ |
| Touch input (finger down/move/up) | ✓ |
| Boid flocking (seek, cohesion, separation, alignment) | ✓ |
| Jitter + wander forces | ✓ |
| Circle stamp with interpolation | ✓ |
| Per-boid size/opacity variation | ✓ |
| Circle spawn shape | ✓ |
| Boid overlay (toggle with V) | ✓ |
| Clear canvas (C key) | ✓ |

## What's Deferred (Phase 2+)

- Multiple layers + blend modes
- Non-circle spawn shapes (ring, spiral, grid, etc.)
- Tapering (stroke fade-out)
- Pressure sensitivity
- Pixel sensing
- Flow field (Simplex noise)
- Presets
- UI controls / sliders
- Copy / paste / selection
- Undo / redo
- File save / load
- GPU-accelerated stamping (compute shaders)
- Spatial partitioning for boid neighbor queries

## Prerequisites

- **C++17** compiler (GCC 9+, Clang 10+, MSVC 2019+)
- **CMake** 3.16+
- **Vulkan SDK** (includes `glslc` shader compiler)
- **SDL2** development libraries

### Install dependencies

**Ubuntu / Debian:**
```bash
sudo apt install cmake libsdl2-dev vulkan-tools libvulkan-dev vulkan-validationlayers-dev
# Install Vulkan SDK from https://vulkan.lunarg.com/sdk/home for glslc
```

**Fedora:**
```bash
sudo dnf install cmake SDL2-devel vulkan-tools vulkan-loader-devel vulkan-headers vulkan-validation-layers-devel
```

**macOS (Homebrew):**
```bash
brew install cmake sdl2
# Install Vulkan SDK from https://vulkan.lunarg.com/sdk/home
```

**Windows:**
- Install [Vulkan SDK](https://vulkan.lunarg.com/sdk/home)
- Install SDL2 (via vcpkg: `vcpkg install sdl2:x64-windows`)
- Use Visual Studio 2019+ or MinGW

## Build

```bash
cd native
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

## Run

```bash
cd build
./boid_brush
```

The executable looks for compiled shaders at `shaders/fullscreen.vert.spv` and `shaders/fullscreen.frag.spv` relative to the working directory. CMake compiles these automatically into the build directory.

## Controls

| Input | Action |
|-------|--------|
| Left click + drag | Paint with boid swarm |
| Touch + drag | Paint with boid swarm |
| `C` | Clear canvas |
| `V` | Toggle boid overlay |
| `ESC` | Quit |

## Tuning Parameters

In Phase 1, parameters are set as compile-time constants in `src/main.cpp`. Edit the `BoidParams` struct near the top of `main()` and rebuild to experiment:

```cpp
params.count         = 20;      // Number of boids
params.seek          = 0.3f;    // Cursor attraction strength
params.cohesion      = 0.5f;    // Flock cohesion
params.separation    = 1.0f;    // Neighbor repulsion
params.alignment     = 0.3f;    // Velocity matching
params.maxSpeed      = 3.0f;    // Max boid velocity
params.damping       = 0.95f;   // Velocity damping (0–1)
params.stampSize     = 8.0f;    // Brush diameter
params.stampOpacity  = 0.15f;   // Stamp opacity (0–1)
params.spawnRadius   = 50.0f;   // Boid spawn circle radius
params.colorR/G/B    = 0;       // Stamp color (0–255)
```

## Architecture

```
native/
├── CMakeLists.txt              Build system (finds SDL2, Vulkan, compiles shaders)
├── README.md                   This file
├── src/
│   ├── main.cpp                Entry point, event loop, stamp + overlay logic
│   ├── boid.h                  Boid struct + flocking physics (header-only, pure math)
│   ├── canvas.h / canvas.cpp   CPU pixel buffer with anti-aliased circle stamps
│   └── vk_renderer.h / .cpp    Minimal Vulkan: texture upload → fullscreen display
└── shaders/
    ├── fullscreen.vert          Fullscreen triangle (no vertex buffer)
    └── fullscreen.frag          Texture sampling
```

The architecture separates concerns cleanly for future extension:
- **`boid.h`** — Pure math, no platform dependencies. Easy to port or optimize (SIMD, GPU compute).
- **`canvas.h/cpp`** — CPU-side pixel buffer. Can be replaced with GPU rendering in Phase 2.
- **`vk_renderer.h/cpp`** — Vulkan boilerplate. Uploads CPU canvas to GPU texture and displays it.
- **`main.cpp`** — Ties everything together. Stamp and overlay logic live here.
