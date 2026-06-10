# Multi-Session Simulation Isolation

## Problem

Multi-session boid playback could report `Simulation running (N sessions)` while placing no stamps, and repeated starts could intermittently fail with `Simulation start failed`.

## Root Cause

The boid WASM bridge originally exposed a single global simulator through `sim_init()` and the related no-handle exports in `wasm-sim/src/lib.rs`.

That worked for the main brush path, but multi-session playback creates isolated boid runtimes. Each runtime called `BoidSim.create()`, which still bound to the same singleton WASM simulator. The consequences were:

- creating one runtime could reset another runtime's agent pool
- deactivating the main boid brush could clear agents for every runtime session
- WebGPU readback could drift out of sync with the shared CPU/WASM state, producing `readback count mismatch` warnings
- sessions could appear to start successfully while their agent counts immediately dropped back to zero

## Fix

The boid WASM layer now supports per-instance simulator handles, matching the fluid simulator pattern.

- `wasm-sim/src/lib.rs` adds `boid_create_simulator`, `boid_destroy_simulator`, and handle-based boid exports
- the legacy singleton exports remain for the main brush path
- `wasm-bridge.js` uses the handle-based boid exports when they are available and falls back to the legacy singleton API otherwise

## Validation

Validated against a deterministic browser repro:

- 2 saved boid sessions
- 2 target layers
- repeated multi-session start/step/stop cycles

Expected post-fix behavior:

- each runtime retains its own agent count
- each routed layer receives visible paint
- repeated starts reuse cached runtimes without `Simulation start failed`
- no `WebGPU boid sim readback count mismatch` warnings during the repro