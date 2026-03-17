"""
Boid Brush — AI Diffusion Inpainting Server

FastAPI server that runs a Stable Diffusion inpainting pipeline locally.
Accepts image + mask + prompt, returns AI-generated inpainted result.

Usage:
    python server.py                         # default: sd-turbo on auto device
    python server.py --model sd-inpaint      # use SD 1.5 inpainting model
    python server.py --port 7861             # custom port
"""

import argparse
import asyncio
import base64
import io
import logging
import time
from contextlib import asynccontextmanager

import torch
from diffusers import AutoPipelineForInpainting, StableDiffusionInpaintPipeline
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("boid-ai")

# ── CLI args ─────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Boid Brush AI Server")
parser.add_argument("--model", choices=["sd-turbo", "sd-inpaint"], default="sd-turbo",
                    help="Model to use (default: sd-turbo)")
parser.add_argument("--port", type=int, default=7860, help="Port (default: 7860)")
parser.add_argument("--host", default="127.0.0.1", help="Host (default: 127.0.0.1)")
ARGS = parser.parse_args()

# ── Model config ─────────────────────────────────────────────
MODEL_MAP = {
    "sd-turbo": "stabilityai/sd-turbo",
    "sd-inpaint": "runwayml/stable-diffusion-inpainting",
}

# ── Globals ──────────────────────────────────────────────────
pipeline = None
device = None
request_queue: asyncio.Queue | None = None
stats = {"requests": 0, "total_time_ms": 0, "errors": 0}


def _detect_device():
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_pipeline(model_key: str):
    global pipeline, device
    device = _detect_device()
    model_id = MODEL_MAP[model_key]
    log.info(f"Loading {model_id} on {device}...")
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32

    if model_key == "sd-turbo":
        pipeline = AutoPipelineForInpainting.from_pretrained(
            model_id, torch_dtype=dtype, variant="fp16" if dtype == torch.float16 else None,
        )
    else:
        pipeline = StableDiffusionInpaintPipeline.from_pretrained(
            model_id, torch_dtype=dtype, variant="fp16" if dtype == torch.float16 else None,
            safety_checker=None,
        )

    pipeline.to(device)
    if device == "cuda":
        try:
            pipeline.enable_xformers_memory_efficient_attention()
        except Exception:
            pass

    log.info(f"Model ready: {model_id} on {device}")


# ── Lifespan ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global request_queue
    request_queue = asyncio.Queue(maxsize=8)
    _load_pipeline(ARGS.model)
    yield


app = FastAPI(title="Boid Brush AI Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Schemas ──────────────────────────────────────────────────
class InpaintRequest(BaseModel):
    image: str = Field(..., description="Base64-encoded input image (512×512 PNG)")
    mask: str = Field(..., description="Base64-encoded mask (512×512 PNG, white = inpaint)")
    prompt: str = Field(default="", description="Generation prompt")
    negative_prompt: str = Field(default="", description="Negative prompt")
    steps: int = Field(default=2, ge=1, le=50)
    strength: float = Field(default=0.8, ge=0.0, le=1.0)
    guidance_scale: float = Field(default=7.5, ge=1.0, le=30.0)
    seed: int = Field(default=-1, description="-1 for random")


class InpaintResponse(BaseModel):
    image: str = Field(..., description="Base64-encoded result PNG")
    seed: int
    time_ms: int


# ── Helpers ──────────────────────────────────────────────────
def _b64_to_pil(b64: str) -> Image.Image:
    """Decode a base64 string to a PIL Image, stripping any data-URI prefix."""
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def _b64_to_mask(b64: str) -> Image.Image:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("L")


def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _run_inpaint(req: InpaintRequest) -> InpaintResponse:
    """Run the pipeline synchronously (called from a thread)."""
    t0 = time.perf_counter()

    image = _b64_to_pil(req.image).resize((512, 512))
    mask = _b64_to_mask(req.mask).resize((512, 512))

    seed = int(req.seed if req.seed >= 0 else torch.randint(0, 2**32 - 1, (1,)).item())
    generator = torch.Generator(device=device).manual_seed(seed)

    if pipeline is None:
        raise RuntimeError("Pipeline not loaded")

    result = pipeline(
        prompt=req.prompt or "high quality, detailed",
        negative_prompt=req.negative_prompt or "blurry, low quality",
        image=image,
        mask_image=mask,
        num_inference_steps=req.steps,
        strength=req.strength,
        guidance_scale=req.guidance_scale,
        generator=generator,
        width=512,
        height=512,
    ).images[0]

    elapsed = int((time.perf_counter() - t0) * 1000)
    return InpaintResponse(image=_pil_to_b64(result), seed=seed, time_ms=elapsed)


# ── Routes ───────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {
        "status": "ready" if pipeline is not None else "loading",
        "model": ARGS.model,
        "model_id": MODEL_MAP[ARGS.model],
        "device": device or "unknown",
        "stats": stats,
    }


@app.post("/api/inpaint", response_model=InpaintResponse)
async def inpaint(req: InpaintRequest):
    if pipeline is None:
        return JSONResponse(status_code=503, content={"error": "Model still loading"})

    stats["requests"] += 1
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _run_inpaint, req)
        stats["total_time_ms"] += result.time_ms
        return result
    except Exception as e:
        stats["errors"] += 1
        log.exception("Inpaint error")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/stats")
async def get_stats():
    avg = stats["total_time_ms"] / max(1, stats["requests"])
    return {**stats, "avg_time_ms": round(avg)}


# ── Main ─────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    log.info(f"Starting server on {ARGS.host}:{ARGS.port} with model={ARGS.model}")
    uvicorn.run(app, host=ARGS.host, port=ARGS.port)
