#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "Starting VideoReviewTool..."
echo

# Check Python
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: Python 3 was not found."
    echo
    echo "Install it with:"
    echo "  sudo apt install python3 python3-venv python3-tk"
    echo
    read -p "Press Enter to exit..."
    exit 1
fi

echo "Python version:"
python3 --version
echo

# Check/install required Linux packages
if ! dpkg -s python3-venv >/dev/null 2>&1 || ! dpkg -s python3-tk >/dev/null 2>&1; then
    echo "Installing required system packages..."
    sudo apt update
    sudo apt install -y python3-venv python3-tk
    echo
fi

# Create or repair virtual environment
if [ ! -f ".venv/bin/activate" ]; then
    echo "Python virtual environment is missing or incomplete."

    if [ -d ".venv" ]; then
        echo "Removing broken virtual environment..."
        rm -rf ".venv"
    fi

    echo "Creating virtual environment..."
    python3 -m venv .venv

    if [ ! -f ".venv/bin/activate" ]; then
        echo
        echo "ERROR: Failed to create the virtual environment."
        read -p "Press Enter to exit..."
        exit 1
    fi

    echo "Virtual environment created."
fi

# Activate virtual environment
echo "Activating virtual environment..."
source ".venv/bin/activate"

echo
echo "Checking dependencies..."

# Upgrade pip
python -m pip install --quiet --upgrade pip

# Install Python dependencies
python -m pip install --quiet -r requirements.txt

echo
echo "Starting VideoReviewTool..."
echo

python app.py

echo
echo "VideoReviewTool has exited."
read -p "Press Enter to exit..."
