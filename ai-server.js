// =============================================================================
// ai-server.js — Browser-side HTTP client for the AI diffusion server
//
// Manages connection state, health polling, inpaint requests, and supports
// both the built-in Python server and A1111-compatible backends.
// =============================================================================

const AI_SETTINGS_KEY = 'bb_ai_settings';

export class AIServer {
  constructor() {
    const saved = this._loadSettings();
    this.baseUrl = saved.serverUrl || 'http://127.0.0.1:7860';
    this.backend = saved.backend || 'builtin';  // 'builtin' | 'a1111'
    this.state = 'disconnected'; // disconnected | connecting | connected | error
    this.serverInfo = null;      // last health response
    this._pollTimer = null;
    this._abortController = null;
    this._listeners = new Set();
    this._pollInterval = 4000;   // starts at 4s, backs off on failure
    this._maxPollInterval = 30000; // cap at 30s

    // Only auto-poll if user previously saved settings (i.e. intentional setup)
    if (saved.serverUrl) {
      this._startPolling();
    }
  }

  // ── Event listeners (state changes) ─────────────────────
  onChange(fn) { this._listeners.add(fn); }
  offChange(fn) { this._listeners.delete(fn); }
  _notify() { for (const fn of this._listeners) fn(this.state, this.serverInfo); }

  _setState(s, info) {
    if (this.state === s) return;
    this.state = s;
    if (info !== undefined) this.serverInfo = info;
    this._notify();
  }

  // ── Settings persistence ────────────────────────────────
  _loadSettings() {
    try { return JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); }
    catch { return {}; }
  }

  updateSettings(url, backend) {
    this.baseUrl = url || this.baseUrl;
    this.backend = backend || this.backend;
    const settings = this._loadSettings();
    settings.serverUrl = this.baseUrl;
    settings.backend = this.backend;
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
    // Reset backoff and re-check with new settings
    this._pollInterval = 4000;
    this._setState('disconnected', null);
    this._startPolling();
  }

  // ── Health check ────────────────────────────────────────
  async checkHealth() {
    // Only notify 'connecting' if we weren't already in a disconnected-like state
    // to avoid rapid UI flicker (disconnected→connecting→error→connecting→...)
    if (this.state === 'connected' || this.state === 'disconnected') {
      this._setState('connecting', null);
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      let url, response, data;

      if (this.backend === 'a1111') {
        url = `${this.baseUrl}/sdapi/v1/options`;
        response = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        data = await response.json();
        this._setState('connected', { backend: 'a1111', model: data.sd_model_checkpoint || 'unknown' });
      } else {
        url = `${this.baseUrl}/api/health`;
        response = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        data = await response.json();
        if (data.status === 'ready') {
          this._setState('connected', data);
        } else {
          this._setState('connecting', data);
        }
      }
      // Reset backoff on success
      this._pollInterval = 4000;
      return data;
    } catch (e) {
      this._setState('error', null);
      // Exponential backoff on failure (4s → 8s → 16s → 30s cap)
      this._pollInterval = Math.min(this._pollInterval * 2, this._maxPollInterval);
      return null;
    }
  }

  // ── Auto-polling ────────────────────────────────────────
  _startPolling() {
    this._stopPolling();
    this.checkHealth();
    this._scheduleNextPoll();
  }

  _scheduleNextPoll() {
    this._pollTimer = setTimeout(() => {
      if (this.state !== 'connected') {
        this.checkHealth().then(() => this._scheduleNextPoll());
      } else {
        this._scheduleNextPoll();
      }
    }, this._pollInterval);
  }

  _stopPolling() {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  }

  // ── Inpaint request ─────────────────────────────────────
  async inpaint({ imageBase64, maskBase64, prompt, negativePrompt, steps, strength, guidanceScale, seed }) {
    this._abortController = new AbortController();

    try {
      if (this.backend === 'a1111') {
        return await this._inpaintA1111({
          imageBase64, maskBase64, prompt, negativePrompt,
          steps, strength, guidanceScale, seed,
        });
      }
      return await this._inpaintBuiltin({
        imageBase64, maskBase64, prompt, negativePrompt,
        steps, strength, guidanceScale, seed,
      });
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }

  async _inpaintBuiltin({ imageBase64, maskBase64, prompt, negativePrompt, steps, strength, guidanceScale, seed }) {
    const response = await fetch(`${this.baseUrl}/api/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: this._abortController.signal,
      body: JSON.stringify({
        image: imageBase64,
        mask: maskBase64,
        prompt: prompt || '',
        negative_prompt: negativePrompt || '',
        steps,
        strength,
        guidance_scale: guidanceScale,
        seed: seed ?? -1,
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Server error ${response.status}`);
    }
    const data = await response.json();
    return { imageBase64: data.image, seed: data.seed, timeMs: data.time_ms };
  }

  async _inpaintA1111({ imageBase64, maskBase64, prompt, negativePrompt, steps, strength, guidanceScale, seed }) {
    // Strip data URI prefix for A1111
    const stripPrefix = b64 => b64.includes(',') ? b64.split(',')[1] : b64;

    const response = await fetch(`${this.baseUrl}/sdapi/v1/img2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: this._abortController.signal,
      body: JSON.stringify({
        init_images: [stripPrefix(imageBase64)],
        mask: stripPrefix(maskBase64),
        prompt: prompt || 'high quality, detailed',
        negative_prompt: negativePrompt || 'blurry, low quality',
        denoising_strength: strength,
        cfg_scale: guidanceScale,
        steps,
        seed: seed ?? -1,
        width: 512,
        height: 512,
        inpainting_fill: 1,   // original
        inpaint_full_res: false,
        mask_blur: 4,
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `A1111 error ${response.status}`);
    }
    const data = await response.json();
    return { imageBase64: data.images?.[0] || '', seed: data.parameters?.seed ?? -1, timeMs: 0 };
  }

  // ── Abort pending request ───────────────────────────────
  abortPending() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  destroy() {
    this._stopPolling();
    this.abortPending();
    this._listeners.clear();
  }
}
