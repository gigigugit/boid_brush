#pragma once
// Boid Brush — Native Prototype (Phase 1)
// Boid simulation: flocking physics ported from the browser version.
// Pure math — no rendering or platform dependencies.

#include <cmath>
#include <cstdint>
#include <random>
#include <vector>

struct BoidParams {
    int   count         = 20;
    float seek          = 0.3f;
    float cohesion      = 0.5f;
    float separation    = 1.0f;
    float alignment     = 0.3f;
    float maxSpeed      = 3.0f;
    float damping       = 0.95f;
    float jitter        = 0.1f;
    float wander        = 0.0f;
    float wanderSpeed   = 0.3f;
    float fov           = 270.0f;   // degrees
    float individuality = 0.3f;
    float spawnRadius   = 50.0f;
    float stampSize     = 8.0f;
    float stampOpacity  = 0.15f;
    float stampSeparation = 0.0f;   // 0 = auto (sz * 0.25)
    uint8_t colorR = 0, colorG = 0, colorB = 0;
};

struct Boid {
    float x, y;           // position
    float vx, vy;         // velocity
    float ax, ay;         // acceleration (reset each frame)
    float wa;             // wander angle

    // Per-boid personality multipliers (1 ± 0.5 * individuality)
    float ps;             // seek
    float pk;             // cohesion
    float pc;             // separation
    float pp;             // alignment
    float pn;             // neighbor distance

    float sm;             // stamp size multiplier   (0.7 – 1.3)
    float om;             // stamp opacity multiplier (0.6 – 1.4)

    // Stamp interpolation state
    float lsx, lsy;       // last stamp position
    bool  hasStamped;
    int   frame;          // frame counter

    // --- helpers ported from JS -----------------------------------------

    void applyForce(float fx, float fy) { ax += fx; ay += fy; }

    void seekTarget(float tx, float ty, float weight, float ms) {
        float dx = tx - x, dy = ty - y;
        float d = std::sqrt(dx * dx + dy * dy);
        if (d < 1.0f) return;
        applyForce((dx / d * ms - vx) * weight,
                    (dy / d * ms - vy) * weight);
    }

    void flee(float tx, float ty, float radius, float ms) {
        float dx = x - tx, dy = y - ty;
        float d = std::sqrt(dx * dx + dy * dy);
        if (d > radius || d < 1.0f) return;
        float s = (1.0f - d / radius) * ms;
        applyForce(dx / d * s, dy / d * s);
    }

    bool inFOV(const Boid& other, float fovRad) const {
        if (fovRad >= 3.14159265f) return true;
        float dx = other.x - x, dy = other.y - y;
        float spd = std::sqrt(vx * vx + vy * vy);
        if (spd < 0.1f) return true;
        float a = std::atan2(vy, vx);
        float b = std::atan2(dy, dx);
        float da = b - a;
        if (da >  3.14159265f) da -= 2.0f * 3.14159265f;
        if (da < -3.14159265f) da += 2.0f * 3.14159265f;
        return std::fabs(da) < fovRad / 2.0f;
    }

    void resetStamp() { lsx = x; lsy = y; hasStamped = true; }

    // --- main physics update --------------------------------------------

    void update(const std::vector<Boid>& boids,
                float leaderX, float leaderY,
                const BoidParams& p,
                std::mt19937& rng) {
        ax = 0.0f;
        ay = 0.0f;
        const float ms = p.maxSpeed * ps;

        // Seek toward cursor
        seekTarget(leaderX, leaderY, p.seek * pk, ms);

        // Flocking: iterate over all other boids (O(n²) — Phase 2 will add spatial hash)
        float cx = 0, cy = 0;  int cc = 0;   // cohesion accumulators
        float sx = 0, sy = 0;                 // separation accumulator
        float avx = 0, avy = 0; int ac = 0;  // alignment accumulators

        const float neighborDist = 80.0f * pn;
        const float separDist   = 25.0f * pn;
        const float fovRad = p.fov * 3.14159265f / 180.0f;

        for (const auto& o : boids) {
            if (&o == this) continue;
            if (!inFOV(o, fovRad)) continue;
            float dx = o.x - x, dy = o.y - y;
            float d = std::sqrt(dx * dx + dy * dy);
            if (d < neighborDist) {
                cx += o.x; cy += o.y; cc++;
                avx += o.vx; avy += o.vy; ac++;
            }
            if (d < separDist && d > 0.0f) {
                sx -= dx / d; sy -= dy / d;
            }
        }

        // Cohesion: steer toward average neighbor position
        if (cc > 0)
            seekTarget(cx / cc, cy / cc, p.cohesion * pc, ms);

        // Alignment: match average neighbor velocity
        if (ac > 0)
            applyForce((avx / ac - vx) * p.alignment,
                       (avy / ac - vy) * p.alignment);

        // Separation: repel from close neighbors
        applyForce(sx * p.separation * pp, sy * p.separation * pp);

        // Jitter: random acceleration
        if (p.jitter > 0.0f) {
            std::uniform_real_distribution<float> dist(-1.0f, 1.0f);
            applyForce(dist(rng) * p.jitter * ms * 2.0f,
                       dist(rng) * p.jitter * ms * 2.0f);
        }

        // Wander: random walk angle
        if (p.wander > 0.0f) {
            std::uniform_real_distribution<float> dist(-1.0f, 1.0f);
            wa += dist(rng) * p.wanderSpeed * 2.0f;
            applyForce(std::cos(wa) * p.wander * ms,
                       std::sin(wa) * p.wander * ms);
        }

        // Velocity integration
        vx += ax; vy += ay;
        float spd = std::sqrt(vx * vx + vy * vy);
        if (spd > ms) { vx = (vx / spd) * ms; vy = (vy / spd) * ms; }
        vx *= p.damping;
        vy *= p.damping;
        x += vx;
        y += vy;
        frame++;
    }
};

// Spawn boids in a circle around (cx, cy)
inline std::vector<Boid> spawnCircle(float cx, float cy,
                                     const BoidParams& p,
                                     std::mt19937& rng) {
    std::vector<Boid> boids;
    boids.reserve(p.count);
    std::uniform_real_distribution<float> angleDist(0.0f, 2.0f * 3.14159265f);
    std::uniform_real_distribution<float> radiusDist(0.0f, 1.0f);
    std::uniform_real_distribution<float> halfDist(-0.5f, 0.5f);
    std::uniform_real_distribution<float> unitDist(0.0f, 1.0f);

    for (int i = 0; i < p.count; i++) {
        float a = angleDist(rng);
        float r = std::sqrt(radiusDist(rng)) * p.spawnRadius;
        float bx = cx + std::cos(a) * r;
        float by = cy + std::sin(a) * r;

        Boid b{};
        b.x = bx;  b.y = by;
        b.vx = halfDist(rng) * 2.0f;
        b.vy = halfDist(rng) * 2.0f;
        b.ax = 0; b.ay = 0;
        b.wa = angleDist(rng);

        float ind = p.individuality;
        b.ps = 1.0f + halfDist(rng) * ind;
        b.pk = 1.0f + halfDist(rng) * ind;
        b.pc = 1.0f + halfDist(rng) * ind;
        b.pp = 1.0f + halfDist(rng) * ind;
        b.pn = 1.0f + halfDist(rng) * ind * 0.8f;
        b.sm = 0.7f + unitDist(rng) * 0.6f;
        b.om = 0.6f + unitDist(rng) * 0.8f;

        b.lsx = bx; b.lsy = by;
        b.hasStamped = false;
        b.frame = 0;

        boids.push_back(b);
    }
    return boids;
}
