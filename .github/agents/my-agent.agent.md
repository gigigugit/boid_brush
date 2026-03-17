---
# Fill in the fields below to create a basic custom agent for your repository.
# The Copilot CLI can be used for local testing: https://gh.io/customagents/cli
# To make this agent available, merge this file into the default repository branch.
# For format details, see: https://gh.io/customagents/config

name:
description:
---

# My Agent

# Plan: AI Diffusion Stamp Brush

## TL;DR
Add an AI-powered brush that uses a local Stable Diffusion inpainting model to generate stamps (leaves, clouds, etc.) on the canvas. The browser captures a region around the cursor + circular mask, sends to a local Python FastAPI server running `diffusers`, receives the inpainted result, and stamps it onto the active layer. Supports both click-to-stamp and continuous queued modes. Server setup via one-click script or copy-paste commands.

---

## Architecture

```
Browser (boid_brush app)              Local Python Server (localhost:7860)
├─ AIDiffusionBrush                   ├─ FastAPI
│  ├─ captureRegion()                 │  ├─ POST /api/inpaint
│  ├─ buildMask()                     │  │   {image, mask, prompt, params}
│  ├─ sendToServer()                  │  │   → {image: base64}
│  └─ stampResult()                   │  ├─ GET /api/health
├─ ai-server.js (HTTP client)        │  └─ POST /api/config
├─ UI: AI Settings panel              └─ diffusers inpainting pipeline
└─ UI: Server Setup modal                 (SD 1.5 Inpaint + LCM scheduler)
```

- **Primary Model**: `stabilityai/sd-turbo` with inpainting pipeline — 1-4 steps, ~100-300ms per stamp on consumer GPU (~4GB VRAM). Fallback: `runwayml/stable-diffusion-inpainting` + LCM scheduler (4-8 steps, ~500ms).
- **Future GAN path**: Predefined texture packs (leaves, clouds, stone, etc.) using small trained GANs for ~10ms stamps. Complementary to diffusion, not a replacement — GAN for speed on known categories, diffusion for open-ended prompts.
- **Resolution**: Always generate at 512×512 internally. The capture region maps canvas area to 512×512, result resizes back to brush size.
- **Inpainting**: Circular soft-edged mask in center of captured region. Model regenerates only the masked area, preserving surrounding context for seamless blending.

---

## Steps

### Phase A: UI Shell & Brush Skeleton (visible-first, no server needed)

**Goal**: Get all UI elements visible and interactive, with a stub brush that shows the complete user experience minus actual generation. Everything testable by just opening the app in a browser.

1. **Add AI brush to brush selector** in `index.html` — `<option value="ai">AI Diffusion</option>` in the dropdown

2. **Add `AIDiffusionBrush` stub class** in `brushes.js`:
   - Implements full brush interface (`onDown`, `onMove`, `onUp`, `onFrame`, `drawOverlay`, `deactivate`, `getStatusInfo`)
   - `onDown`: pushes undo, captures region to temp canvas (visible or active layer), builds mask canvas, draws the capture preview in overlay — but instead of calling the server, stamps a **placeholder** (the captured region with a colored tint or crosshatch pattern) to prove the pipeline works
   - `onMove`: in continuous mode, queues stamp positions with throttle
   - `onFrame`: processes queued stamps (placeholder for now), draws loading spinner overlay for "pending" stamps
   - `drawOverlay`: shows stamp preview circle at cursor, any pending stamp indicators
   - `captureRegion(cx, cy, size, source)`: fully functional — reads from visible composite or active layer, resizes to 512×512
   - `buildMask(brushSize, feather)`: fully functional — creates 512×512 soft-edged circular mask
   - `stampResult(resultCanvas, cx, cy, targetSize)`: fully functional — resizes, draws to active layer, respects symmetry, marks dirty

3. **Create AI Setup Modal** (`<div id="aiSetupModal">` in `index.html`, logic in `ui.js`):
   - Full modal structure: backdrop, centered panel, close button, Save & Close
   - **Requirements banner** at top
   - **Tabbed backend selector**: "Built-in Python Server" tab (populated with instructions) | "Draw Things / A1111 WebUI" tab (populated with instructions)
   - **Connection section** at bottom: URL input, Test Connection button, status badge (always shows "Disconnected" in this phase since no server exists yet)
   - **Diagnostics area** (always visible for now, shows setup-needed message)
   - All copy buttons functional (copy to clipboard)
   - Modal opens/closes correctly, persists backend+URL to localStorage

4. **Add AI Generation Settings sidebar section** (`data-brushes="ai"`) in `ui.js`:
   - **Connection row**: status dot (hardcoded red for now) + "⚙ Setup" button wired to open modal
   - **Prompt row**: truncated display + "✏ Edit" button opening the Prompt Popout
   - **Prompt Popout**: textarea for prompt/negative prompt, recent prompts list (localStorage), close-on-outside-click
   - **Generation sliders**: Stamp Size, Steps, Strength, Guidance Scale, Mask Feather — all using `sliderRow()` pattern
   - **Mode controls**: Input Source select, Mode select, Continuous Interval slider (conditionally visible)
   - **Seed controls**: Random checkbox + seed number input
   - All controls wired to `invalidateParams()`

5. **Wire into `app.js`**:
   - Register `AIDiffusionBrush` in brush map
   - Extend `getP()` with all AI params (prompt, negativePrompt, steps, strength, guidanceScale, seed, aiStampSize, maskFeather, aiInputSource, aiMode, aiInterval)
   - Add AI params to `saveSession()` / `_restoreSession()` (prompt and negativePrompt are textareas, not in `#sidebar input[type="range"]` — need explicit handling)
   - `_toggleBrushSections('ai')` works for `data-brushes="ai"`
   - Add `captureVisibleRegion()` and `captureActiveRegion()` helpers (reuse `buildSensingData()` patterns)

**Phase A Verification**:
- Select AI brush → sidebar shows AI section, other brush sections hidden
- Click "⚙ Setup" → modal opens with full instructions, tabs switch, copy buttons work
- Edit prompt via popout → sidebar row updates with truncated text
- All sliders/controls functional and persisted across reload
- Click on canvas → placeholder stamp appears at cursor (captured region with tint)
- Continuous mode → placeholder stamps along stroke path
- Undo reverses stamps, symmetry replicates stamps
- Status dot stays red ("not connected") — expected

---

### Phase B: Local PC Server + HTTP Client (built-in Python backend)

**Goal**: Add the real server and connect it. Replace placeholder stamps with actual AI-generated content. *Depends on Phase A.*

6. **Create `server/server.py`** — FastAPI application:
   - `GET /api/health` → status + model info + device
   - `POST /api/inpaint` → accepts `{image, mask, prompt, negative_prompt, steps, strength, guidance_scale, seed}`, returns `{image: base64}`
   - Loads `stabilityai/sd-turbo` via AutoPipelineForInpainting, fp16, CUDA/MPS auto-detect
   - Model selectable via `--model` CLI arg (`sd-turbo` | `sd-inpaint`)
   - CORS for localhost/127.0.0.1/null origins
   - Single-pipeline request queue (asyncio.Queue, one at a time)

7. **Create `server/requirements.txt`** — `diffusers`, `transformers`, `torch`, `accelerate`, `fastapi`, `uvicorn[standard]`, `Pillow`, `safetensors`

8. **Create `server/setup.bat`** (Windows) + **`server/setup.sh`** (macOS/Linux):
   - Check Python 3.10+ exists
   - Create/reuse venv in `server/.venv`
   - Install requirements via pip
   - Launch `server.py` with uvicorn on port 7860
   - Model downloads automatically on first pipeline load

9. **Create `server/README.md`** — manual setup instructions

10. **Create `ai-server.js`** — `AIServer` class (custom backend only in this phase):
    - `constructor(baseUrl)`, `backend = 'custom'`
    - `async checkHealth()` → GET `/api/health`
    - `async inpaint({imageBase64, maskBase64, prompt, negativePrompt, steps, strength, guidanceScale, seed})` → POST `/api/inpaint`, returns base64 image
    - `abortPending()` via AbortController
    - Connection state: `disconnected | connecting | connected | error`
    - Auto-reconnect polling (3s interval when disconnected)

11. **Wire real generation into `AIDiffusionBrush`**:
    - Replace placeholder stamp logic with actual server call
    - `onDown` / `onMove` → call `server.inpaint()` with captured region + mask + params
    - `onFrame` → check for resolved promises, call `stampResult()` with decoded image
    - Handle errors gracefully: show toast on server error, fall back to no-op (don't crash the brush)
    - Queue cap: max 3 pending requests in continuous mode, drop oldest

12. **Wire live connection status into UI**:
    - Modal "Test Connection" button calls `server.checkHealth()`, updates status badge
    - Sidebar status dot reflects `server.state` (poll or event-driven)
    - Auto-open Setup modal if server disconnected on first AI brush selection

**Phase B Verification**:
- Run `server/setup.bat` → server starts, `http://127.0.0.1:7860/api/health` returns JSON
- Select AI brush → status dot turns green (if server running)
- Click canvas with prompt "green leaves" → real AI-generated content stamps onto layer (~1-3s)
- Continuous mode works with real generation (stamps appear as requests complete)
- Adjusting Steps/Strength/Guidance produces visibly different results
- Mask feather=0 vs feather=50 shows hard vs soft blending
- Server down → status dot red, toast on stamp attempt, no crash

---

### Phase C: Draw Things / A1111 WebUI Integration

**Goal**: Add A1111-compatible backend support for Draw Things (iOS/macOS), Forge, and A1111 WebUI. *Depends on Phase B.*

13. **Extend `ai-server.js`** with A1111 backend:
    - `backend` property: `'custom'` | `'a1111'`
    - `checkHealth()` for a1111: GET `/sdapi/v1/options` or `/sdapi/v1/sd-models`
    - `inpaint()` for a1111: POST `/sdapi/v1/img2img` with field mapping:
      - `init_images: [base64]`, `mask: base64`, `prompt`, `negative_prompt`
      - `denoising_strength` (= strength), `cfg_scale` (= guidanceScale), `steps`, `seed`
      - `inpainting_fill: 1` (original), `mask_blur: feather`, `inpaint_full_res: false`
      - `width: 512`, `height: 512`
    - Response parsing: A1111 returns `{images: [base64, ...]}` — take first

14. **Update AI Setup Modal**:
    - Backend tab selection now controls `server.backend` property
    - "Draw Things / A1111" tab instructions fully functional
    - Test Connection works for both backends
    - URL default changes per backend (7860 for custom, 7860 or device IP for Draw Things)

15. **Test across backends**:
    - Same brush behavior regardless of backend — results may differ (different models) but pipeline is identical

**Phase C Verification**:
- Select "Draw Things" backend in modal → enter Draw Things IP → Test Connection succeeds
- Same painting workflow produces stamps via Draw Things API
- Switch between backends without losing sidebar settings
- A1111 WebUI (with --api flag) also works as backend

---

## Relevant Files

### New files
- `server/server.py` — FastAPI inpainting server (main server code)
- `server/requirements.txt` — Python dependencies
- `server/setup.bat` — Windows one-click setup script
- `server/setup.sh` — macOS/Linux one-click setup script
- `server/README.md` — Manual setup instructions
- `ai-server.js` — Browser-side HTTP client for the diffusion server

### Modified files
- `brushes.js` — Add `AIDiffusionBrush` class (implement standard brush interface, capture/mask/stamp pipeline)
- `ui.js` — Add AI settings sidebar section (prompt, strength, steps, connection, setup wizard), wire `data-brushes="ai"` visibility
- `app.js` — Register AI brush, create AIServer singleton, add `captureVisibleRegion()`/`captureActiveRegion()` helpers, extend `getP()` with AI params, add to session persistence
- `index.html` — Add `<option value="ai">AI Diffusion</option>` to brush dropdown

---

## Verification

1. **Server standalone test**: Run `server/setup.bat`, hit `http://127.0.0.1:7860/api/health` in browser — should return `{status: "ready", model: "...", device: "cuda"}`
2. **Connection test**: Select AI brush in app, click "Test Connection" — status should turn green
3. **Click-to-stamp test**: Set prompt to "green leaves", click on canvas — should show loading overlay, then stamp generated leaf content onto active layer within ~1-3s
4. **Continuous mode test**: Switch to continuous, drag across canvas — stamps should appear along the stroke path at the configured interval
5. **Input source test**: Paint some content on a layer, then use AI brush with "Visible pixels" vs "Active layer" — results should differ based on what the model sees
6. **Mask feather test**: Compare feather=0 (hard edge) vs feather=50 (soft blend) — soft should blend seamlessly into surroundings
7. **Undo test**: AI stamps should be undoable via Ctrl+Z (undo captures layer state before stamp)
8. **Symmetry test**: Enable symmetry, click with AI brush — stamps should appear at all symmetry points

---

## Decisions

- **Model**: `stabilityai/sd-turbo` (primary) — 1-4 steps, ~100-300ms per stamp. Selectable via `--model` flag. Fallback `runwayml/stable-diffusion-inpainting` + LCM for broader compatibility.
- **Future GAN texture packs**: Train small category-specific GANs (leaves, clouds, stone) for ~10ms stamps. Complements diffusion for known categories. Out of scope for initial implementation.
- **Resolution**: Fixed 512×512 generation. Canvas region scales to/from 512 regardless of brush stamp size.
- **Inpainting approach**: Circular soft-edged mask. Center of capture region is regenerated, edges preserved for context blending.
- **Server port**: 7860 (standard for ML inference servers, avoids common dev server ports)
- **GPU only**: CUDA (NVIDIA) and MPS (Apple Silicon) auto-detected. No CPU fallback.
- **CORS**: Server allows `localhost`, `127.0.0.1`, and `null` origins (for file:// protocol if used)
- **Scope exclusions**: No model picker UI (user edits server config), no cloud/remote server support, no ControlNet/LoRA integration (future work)

## Further Considerations

1. **Undo granularity**: In continuous mode, should each stamp be individually undoable, or should an entire stroke be one undo step? Recommend: one undo step per stroke (pushUndo on onDown, same as existing brushes).
2. **Model alternatives**: If the user has an NVIDIA 30/40-series GPU with 8GB+ VRAM, SDXL-Inpainting or Flux would give higher quality. Could add a model selection dropdown in a future iteration.
3. **Opacity/blend**: Should the AI stamp respect the brush opacity slider and layer blend mode? Recommend: yes, stamp at brush opacity using the active layer's context, consistent with other brushes.
