#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v python3 &> /dev/null; then
    echo "Python 3 was not found. Install it with your package manager, e.g.:"
    echo "  sudo apt install python3 python3-venv python3-tk"
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

source .venv/bin/activate

echo "Checking dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo "Starting VideoReviewTool..."
python app.py
