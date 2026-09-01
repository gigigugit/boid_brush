#pragma once
// Boid Brush — Native Prototype (Phase 1)
// CPU-side pixel buffer with circle-stamp rendering.

#include <cstdint>
#include <vector>

class Canvas {
public:
    Canvas(int w, int h);

    void clear(uint8_t r, uint8_t g, uint8_t b, uint8_t a);

    // Draw an anti-aliased filled circle with alpha compositing.
    void stampCircle(float cx, float cy, float radius, float opacity,
                     uint8_t r, uint8_t g, uint8_t b);

    const uint8_t* data() const { return pixels_.data(); }
    uint8_t*       data()       { return pixels_.data(); }
    int width()  const { return w_; }
    int height() const { return h_; }
    size_t sizeBytes() const { return pixels_.size(); }

private:
    int w_, h_;
    std::vector<uint8_t> pixels_;   // RGBA, row-major, top-left origin
};
