@echo off
title Boid Brush AI Server Setup
echo ===================================
echo  Boid Brush AI Server Setup
echo ===================================
echo.

:: Check Python
echo [1/4] Checking Python...
python --version 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)
echo.

:: Create venv if needed
if not exist ".venv" (
    echo [2/4] Creating virtual environment...
    python -m venv .venv
    echo       Done.
) else (
    echo [2/4] Virtual environment already exists.
)
echo.

:: Activate
echo [3/4] Activating virtual environment...
call .venv\Scripts\activate.bat

:: Install dependencies
echo.
echo [3/4] Installing dependencies...
echo       This downloads ~2 GB on first run (PyTorch, diffusers, etc.)
echo       You will see download progress below.
echo.
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] pip install failed. Check the output above for details.
    pause
    exit /b 1
)

:: Launch server
echo.
echo ===================================
echo [4/4] Starting AI server...
echo       Model will download on first run (~4 GB)
echo ===================================
echo.
python server.py %*
pause
