#include "canvas.h"
#include <algorithm>
#include <cmath>
#include <cstring>

Canvas::Canvas(int w, int h) : w_(w), h_(h), pixels_(w * h * 4, 255) {}

void Canvas::clear(uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    for (int i = 0; i < w_ * h_; i++) {
        pixels_[i * 4 + 0] = r;
        pixels_[i * 4 + 1] = g;
        pixels_[i * 4 + 2] = b;
        pixels_[i * 4 + 3] = a;
    }
}

void Canvas::stampCircle(float cx, float cy, float radius, float opacity,
                         uint8_t sr, uint8_t sg, uint8_t sb) {
    if (radius < 0.25f || opacity < 0.002f) return;

    int ir = static_cast<int>(std::ceil(radius)) + 1;
    int x0 = std::max(0, static_cast<int>(cx) - ir);
    int y0 = std::max(0, static_cast<int>(cy) - ir);
    int x1 = std::min(w_ - 1, static_cast<int>(cx) + ir);
    int y1 = std::min(h_ - 1, static_cast<int>(cy) + ir);

    for (int py = y0; py <= y1; py++) {
        for (int px = x0; px <= x1; px++) {
            float dx = px - cx, dy = py - cy;
            float dist = std::sqrt(dx * dx + dy * dy);
            if (dist > radius) continue;

            // 1-pixel soft edge for anti-aliasing
            float coverage = std::min(1.0f, radius - dist + 0.5f);
            float alpha = opacity * coverage;
            if (alpha < 0.002f) continue;

            uint8_t* pixel = &pixels_[(py * w_ + px) * 4];
            // Source-over alpha compositing (assumes dst alpha ≈ 1)
            float inv = 1.0f - alpha;
            pixel[0] = static_cast<uint8_t>(sr * alpha + pixel[0] * inv);
            pixel[1] = static_cast<uint8_t>(sg * alpha + pixel[1] * inv);
            pixel[2] = static_cast<uint8_t>(sb * alpha + pixel[2] * inv);
            pixel[3] = 255;
        }
    }
}
