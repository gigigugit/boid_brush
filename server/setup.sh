#!/usr/bin/env bash
set -e
echo "==================================="
echo " Boid Brush AI Server Setup"
echo "==================================="
echo

cd "$(dirname "$0")"

# Check Python 3
echo "[1/4] Checking Python..."
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] Python 3 not found. Install Python 3.10+."
    exit 1
fi
python3 --version
echo

# Create venv if needed
if [ ! -d ".venv" ]; then
    echo "[2/4] Creating virtual environment..."
    python3 -m venv .venv
    echo "       Done."
else
    echo "[2/4] Virtual environment already exists."
fi
echo

# Activate
echo "[3/4] Activating and installing dependencies..."
source .venv/bin/activate
echo "       This downloads ~2 GB on first run (PyTorch, diffusers, etc.)"
echo "       You will see download progress below."
echo
pip install -r requirements.txt
echo

# Launch server
echo "==================================="
echo "[4/4] Starting AI server..."
echo "       Model will download on first run (~4 GB)"
echo "==================================="
echo
python server.py "$@"
