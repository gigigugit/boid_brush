# Boid Brush

A browser-based brush/painting application that explores boid-flocking behavior as a digital art tool.

## About

Boid Brush is a personal project for learning about brush behavior, experimenting with swarm-based painting techniques, and making new contributions to the area of digital art. The application simulates boid (bird-oid) flocking dynamics — cohesion, separation, alignment, and other forces — to drive brush stamps across a canvas, producing organic and emergent stroke patterns.

## Features

- **Boid Brush** – A swarm of boids follows the cursor, each stamping paint as it moves. Flocking forces (cohesion, separation, alignment, wander, flow fields, etc.) shape the resulting stroke.
- **Simple Brush** – A single-stamp brush for direct painting without boid simulation.
- **Brush Scale** – A proportional scale slider that adjusts stamp size, spawn radius, and spread together, keeping the overall look consistent at different sizes.
- **Spawn Shapes** – Circle, ring, gaussian, line, ellipse, diamond, grid, sunburst, spiral, poisson, and cluster distributions for boid placement.
- **Pixel Sensing** – Boids can react to existing canvas content (avoid or attract based on darkness, lightness, color channels, etc.).
- **Layer System** – Multiple layers with blend modes, opacity, reordering, merge, and flatten.
- **Presets** – Built-in presets (Ink Wash, Charcoal, Ribbon, Galaxy, Mist, Edge Seeker, Gap Filler, Shadow Tracer) for quick experimentation.
- **Taper** – Configurable stroke tapering for natural brush-lift effects.
- **Pressure Sensitivity** – Supports pen/stylus pressure for size and opacity.
- **Selection & Clipboard** – Rectangular selection, cut, copy, and paste.
- **Settings Persistence** – Auto-saves settings; supports save/load defaults and JSON export/import.

### GPU Acceleration

- **WebGL2 Layer Compositing** – All 16 CSS blend modes (Normal, Multiply, Screen, Overlay, Darken, Lighten, Color Dodge, Color Burn, Hard Light, Soft Light, Difference, Exclusion, Hue, Saturation, Color, Luminosity) are implemented in GLSL shaders and composited on the GPU via ping-pong framebuffers. Falls back to Canvas 2D compositing if WebGL2 is unavailable.
- **Desynchronized Canvas Contexts** – Overlay and selection canvases use `desynchronized: true` for reduced input latency.

### Architecture

- **Extensible Brush Registry** – A `BrushRegistry` system allows registering new brush types programmatically. Each brush is an object with a name, icon, and description. This provides a clean extension point for adding future "special brush" modes without modifying core event handling or rendering code.

## Usage

Open `app.html` in a modern browser (or `index.html` for the landing page with links to forks). Works on desktop and tablet (iPad) — no server or build step required.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Boid Brush |
| `2` | Bristle Brush |
| `3` | Simple Brush |
| `4` | Eraser |
| `5` | AI Diffusion |
| `M` | Rectangle Select |
| `L` | Lasso Select |
| `T` | Transform (when selection active) |
| `Esc` | Deselect |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` | Redo |
| `Ctrl/⌘ + C` | Copy |
| `Ctrl/⌘ + X` | Cut |
| `Ctrl/⌘ + V` | Paste |
| `Ctrl/⌘ + S` | Save |
| `X` | Swap Colors |
| `0` | Reset View |

## Migration Notes

This project is structured to facilitate future migration to a compiled language (C#, C++, or similar):

- **GPU pipeline** – The WebGL2 compositor uses GLSL shaders with standard blend mode math. These shaders translate directly to HLSL (DirectX), Metal Shading Language, or GLSL (OpenGL/Vulkan) with minimal changes.
- **Brush registry** – The `BrushRegistry` pattern maps naturally to an interface/abstract class pattern in C#/C++.
- **Boid simulation** – The `Boid` class and flocking forces are pure math with no DOM dependencies, making them straightforward to port.
- **Parameter system** – All brush parameters are centralized in `getP()` and `controlDefs`, providing a clear schema for native UI bindings.

## Native Prototype (C++ / SDL2 / Vulkan)

A Phase 1 native port lives in the [`native/`](native/) directory. It implements the core boid-flocking brush with a minimal C++17 / SDL2 / Vulkan stack — canvas, mouse/touch input, boid simulation, and circle stamps — without layers, presets, or advanced features. See [`native/README.md`](native/README.md) for build instructions.

## Future Plans

This project is intended as a learning sandbox and creative tool. The long-term goal is to port the core brush and boid simulation to a more robust, performance-oriented environment such as **C#**, **C++**, or a similar compiled language, enabling real-time performance with much larger swarm counts, higher resolution canvases, and tighter integration with professional digital art workflows.

## License

This project is for personal use and experimentation.
