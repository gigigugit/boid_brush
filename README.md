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

## Usage

Open `index.html` in a modern browser. Works on desktop and tablet (iPad) — no server or build step required.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `B` | Boid Brush tool |
| `S` | Simple Brush tool |
| `I` | Eyedropper |
| `G` | Fill |
| `M` | Selection |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` | Redo |
| `Ctrl/⌘ + X/C/V` | Cut / Copy / Paste |
| `Ctrl/⌘ + D` | Deselect |

## Future Plans

This project is intended as a learning sandbox and creative tool. The long-term goal is to port the core brush and boid simulation to a more robust, performance-oriented environment such as **C#**, **C++**, or a similar compiled language, enabling real-time performance with much larger swarm counts, higher resolution canvases, and tighter integration with professional digital art workflows.

## License

This project is for personal use and experimentation.
