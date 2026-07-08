# Future Plan / Prompt: AI-Assisted Stamp Brush

This document is planning-only. It is meant to be reused later as an implementation brief or agent prompt.

## Scope

Design a future **AI-assisted stamp brush** for Boid Brush without implementing any AI, GAN, diffusion, server, or model features in the current work.

## Non-goals for the current task

- Do not add a new brush yet
- Do not add AI UI yet
- Do not add backend/server code
- Do not add model downloads or dependencies
- Do not add GAN, diffusion, or image-generation logic

## Product goal

Add a brush mode that can:

1. capture a region around the cursor
2. prepare a masked stamp input
3. send that input to a local image-generation backend
4. receive a generated result
5. stamp the result onto the active layer

The feature should feel native to the existing app, preserve normal painting workflows, and remain optional when no backend is configured.

## Repository constraints

- Keep the browser-first architecture intact
- Reuse the existing single-page UI patterns in `app.html`, `app.js`, `ui.js`, and `brushes.js`
- Prefer the existing brush parameter flow: UI controls -> `app.getP()` -> brush behavior
- Preserve undo/redo, symmetry, layers, and session persistence
- Do not introduce a JS build step

## Suggested phased rollout

### Phase 1: UI-only shell

Create only the user-facing shell for the feature:

- AI brush entry in the brush picker
- sidebar section for prompt/settings
- setup modal for backend configuration
- prompt editor popout
- placeholder/stub status states

Validation for this phase:

- UI appears only for the AI brush
- controls persist correctly
- no server is required
- selecting the brush does not break existing brushes

### Phase 2: Local backend contract

Add a browser/client contract for a local backend:

- health-check endpoint
- inpaint/generate endpoint
- request/response shape for image + mask + prompt + numeric params
- connection state handling
- graceful error handling

Validation for this phase:

- disconnected state is clear
- connection test gives useful feedback
- failures do not crash painting

### Phase 3: First real stamping flow

Connect the brush to a real backend:

- capture visible or active-layer pixels
- generate a masked request
- receive an image result
- stamp it back onto the active layer
- support click-to-stamp first, then continuous mode

Validation for this phase:

- undo/redo works
- symmetry works
- layer targeting is correct
- generated stamps respect opacity/placement expectations

### Phase 4: Optional backend expansion

Only after the core flow is stable, evaluate additional backends or model families, such as:

- local diffusion server
- Automatic1111 (A1111)-compatible endpoints
- Draw Things-compatible endpoints for compatible local image-generation apps
- future category-specific fast generators, such as foliage generators, cloud generators, stone texture generators, and other texture-oriented tools

## Key design questions to answer before implementation

1. **Undo granularity:** Should continuous AI stamping create one undo step per stroke or per stamp? Per-stamp undo gives finer control, while per-stroke undo keeps history simpler and closer to existing brush behavior.
2. **Prompt scope:** Should prompts be global, brush-specific, or saved in presets?
3. **Input sampling:** Should the brush sample the visible composite, the active layer, or both?
4. **Output compositing:** How should generated output respect opacity, blend mode, and symmetry?
5. **Latency target:** What is the maximum acceptable latency for single-stamp and continuous workflows?
6. **Failure behavior:** What should happen when the backend is unavailable mid-stroke?

## Acceptance criteria for a future implementation

- Existing brushes remain unchanged
- The AI brush is optional and fails safely
- No backend is required for the app to load normally
- Undo/redo, layers, symmetry, and session save/restore still work
- The feature is clearly separated into UI shell, client contract, and backend integration

## Reusable implementation prompt

Use the following prompt in a future implementation task:

> Implement an AI-assisted stamp brush for Boid Brush in phased, reviewable steps.
>
> Constraints:
> - Do not rewrite unrelated brush systems
> - Preserve the browser-first architecture
> - Reuse existing UI patterns in `app.html`, `app.js`, `ui.js`, and `brushes.js`
> - Preserve undo/redo, symmetry, layer targeting, and session persistence
> - Do not add a JS build step
>
> Delivery order:
> 1. Add a UI-only shell for the AI brush with no backend dependency
> 2. Define a local backend client contract and connection states
> 3. Implement click-to-stamp generation
> 4. Add continuous mode only after single-stamp behavior is stable
> 5. Add optional backend variants only after the primary flow works
>
> Validation requirements:
> - Existing brushes still behave the same
> - App loads and paints normally when AI is unconfigured
> - Generated stamps integrate correctly with layers, undo/redo, and symmetry
> - Errors are surfaced clearly without breaking the canvas session

## Notes

- Keep this document as planning/reference material only.
- Any future implementation should happen in a separate task/PR.
