// Boid Brush — Native Prototype (Phase 1)
// C++ / SDL2 / Vulkan
//
// A minimal migration of the browser-based Boid Brush.
// Included: canvas, touch/mouse input, boid flocking, circle stamps.
// Excluded: layers, blend modes, tapering, pressure, sensing, presets, UI.

#include "boid.h"
#include "canvas.h"
#include "vk_renderer.h"

#include <SDL2/SDL.h>
#include <SDL2/SDL_vulkan.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

// ---------------------------------------------------------------------------
// Stamp a single boid onto the canvas (port of JS stampBoid, simplified)
// ---------------------------------------------------------------------------
static void stampBoid(Canvas& canvas, Boid& b, const BoidParams& p) {
    float sz = p.stampSize * b.sm;
    float op = p.stampOpacity * b.om;
    if (op < 0.003f || sz < 0.3f) return;

    float step = p.stampSeparation > 0
                     ? p.stampSeparation
                     : std::max(1.0f, sz * 0.25f);

    float dx   = b.x - b.lsx;
    float dy   = b.y - b.lsy;
    float dist = std::sqrt(dx * dx + dy * dy);

    // First stamp (boid hasn't stamped yet this stroke)
    if (!b.hasStamped) {
        canvas.stampCircle(b.x, b.y, std::max(0.5f, sz / 2.0f), op,
                           p.colorR, p.colorG, p.colorB);
        b.lsx = b.x;
        b.lsy = b.y;
        b.hasStamped = true;
        return;
    }

    // Not enough movement since last stamp
    if (dist < step) return;

    // Interpolated stamps along the trajectory
    int count = static_cast<int>(dist / step);
    for (int i = 1; i <= count; i++) {
        float t  = (i * step) / dist;
        float sx = b.lsx + dx * t;
        float sy = b.lsy + dy * t;
        canvas.stampCircle(sx, sy, std::max(0.5f, sz / 2.0f), op,
                           p.colorR, p.colorG, p.colorB);
    }

    // Advance last-stamp position by the distance actually stamped
    float lt = (count * step) / dist;
    b.lsx += dx * lt;
    b.lsy += dy * lt;
}

// ---------------------------------------------------------------------------
// Draw boid overlay on a display-buffer copy (cursor + boid dots)
// ---------------------------------------------------------------------------
static void drawDot(uint8_t* buf, int w, int h,
                    float cx, float cy, float radius,
                    uint8_t r, uint8_t g, uint8_t b_) {
    int ir = static_cast<int>(std::ceil(radius));
    int ix = static_cast<int>(cx), iy = static_cast<int>(cy);
    for (int dy = -ir; dy <= ir; dy++) {
        for (int dx = -ir; dx <= ir; dx++) {
            if (dx * dx + dy * dy > ir * ir) continue;
            int px = ix + dx, py = iy + dy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            int idx         = (py * w + px) * 4;
            buf[idx + 0]    = r;
            buf[idx + 1]    = g;
            buf[idx + 2]    = b_;
            buf[idx + 3]    = 255;
        }
    }
}

// ===========================================================================
// main
// ===========================================================================
int main(int /*argc*/, char* /*argv*/[]) {
    constexpr int WIDTH  = 1280;
    constexpr int HEIGHT = 800;

    // Boid parameters — edit these to experiment (no runtime UI in Phase 1)
    BoidParams params;
    params.count         = 20;
    params.seek          = 0.3f;
    params.cohesion      = 0.5f;
    params.separation    = 1.0f;
    params.alignment     = 0.3f;
    params.maxSpeed      = 3.0f;
    params.damping       = 0.95f;
    params.jitter        = 0.1f;
    params.wander        = 0.0f;
    params.wanderSpeed   = 0.3f;
    params.fov           = 270.0f;
    params.individuality = 0.3f;
    params.spawnRadius   = 50.0f;
    params.stampSize     = 8.0f;
    params.stampOpacity  = 0.15f;
    params.stampSeparation = 0.0f;
    params.colorR = 0; params.colorG = 0; params.colorB = 0;

    // --- SDL2 init ---------------------------------------------------------
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    SDL_Window* window = SDL_CreateWindow(
        "Boid Brush — Native Prototype",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        WIDTH, HEIGHT,
        SDL_WINDOW_VULKAN | SDL_WINDOW_SHOWN);
    if (!window) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        return 1;
    }

    // --- Vulkan renderer ---------------------------------------------------
    VkRenderer renderer;
    renderer.init(window, WIDTH, HEIGHT);

    // --- Canvas + boids ----------------------------------------------------
    Canvas canvas(WIDTH, HEIGHT);
    canvas.clear(255, 255, 255, 255);

    std::mt19937 rng(42);
    std::vector<Boid> boids;

    bool  running     = true;
    bool  drawing     = false;
    bool  showOverlay = true;
    float cursorX     = WIDTH / 2.0f;
    float cursorY     = HEIGHT / 2.0f;

    // Display buffer (canvas + overlay composited for upload)
    std::vector<uint8_t> displayBuf(WIDTH * HEIGHT * 4);

    fprintf(stderr,
            "Boid Brush — Phase 1 native prototype\n"
            "  Left-click / touch : draw\n"
            "  C                  : clear canvas\n"
            "  V                  : toggle boid overlay\n"
            "  ESC                : quit\n");

    // --- Main loop ---------------------------------------------------------
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            switch (ev.type) {
            case SDL_QUIT:
                running = false;
                break;

            case SDL_MOUSEBUTTONDOWN:
                if (ev.button.button == SDL_BUTTON_LEFT) {
                    drawing = true;
                    cursorX = static_cast<float>(ev.button.x);
                    cursorY = static_cast<float>(ev.button.y);
                    boids   = spawnCircle(cursorX, cursorY, params, rng);
                }
                break;

            case SDL_MOUSEMOTION:
                if (drawing) {
                    cursorX = static_cast<float>(ev.motion.x);
                    cursorY = static_cast<float>(ev.motion.y);
                }
                break;

            case SDL_MOUSEBUTTONUP:
                if (ev.button.button == SDL_BUTTON_LEFT)
                    drawing = false;
                break;

            case SDL_FINGERDOWN:
                drawing = true;
                cursorX = ev.tfinger.x * WIDTH;
                cursorY = ev.tfinger.y * HEIGHT;
                boids   = spawnCircle(cursorX, cursorY, params, rng);
                break;

            case SDL_FINGERMOTION:
                if (drawing) {
                    cursorX = ev.tfinger.x * WIDTH;
                    cursorY = ev.tfinger.y * HEIGHT;
                }
                break;

            case SDL_FINGERUP:
                drawing = false;
                break;

            case SDL_KEYDOWN:
                if (ev.key.keysym.sym == SDLK_ESCAPE)
                    running = false;
                if (ev.key.keysym.sym == SDLK_c)
                    canvas.clear(255, 255, 255, 255);
                if (ev.key.keysym.sym == SDLK_v)
                    showOverlay = !showOverlay;
                break;

            default:
                break;
            }
        }

        // --- Physics + stamping (only while drawing) -----------------------
        if (drawing) {
            for (auto& b : boids)
                b.update(boids, cursorX, cursorY, params, rng);
            for (auto& b : boids)
                stampBoid(canvas, b, params);
        }

        // --- Compose display buffer (canvas + optional overlay) ------------
        memcpy(displayBuf.data(), canvas.data(), canvas.sizeBytes());

        if (showOverlay) {
            // Cursor dot (red while drawing, grey otherwise)
            uint8_t cr = drawing ? 255 : 128;
            uint8_t cg = drawing ? 68  : 128;
            uint8_t cb = drawing ? 68  : 128;
            drawDot(displayBuf.data(), WIDTH, HEIGHT,
                    cursorX, cursorY, 4.0f, cr, cg, cb);

            // Boid dots (blue)
            if (drawing) {
                for (const auto& b : boids)
                    drawDot(displayBuf.data(), WIDTH, HEIGHT,
                            b.x, b.y, 2.0f, 68, 170, 255);
            }
        }

        // --- Upload + present ----------------------------------------------
        renderer.uploadCanvas(displayBuf.data(), WIDTH, HEIGHT);
        renderer.drawFrame();
    }

    renderer.waitIdle();
    renderer.cleanup();
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
