#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

choose_python() {
  for candidate in python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 12) else 1)
PY
      then
        echo "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON="$(choose_python || true)"

if [[ -z "$PYTHON" ]]; then
  cat >&2 <<'EOF'
Python 3.12+ is required.

On macOS with Homebrew:
  brew install python@3.12

Then rerun:
  npm run setup:browser
EOF
  exit 1
fi

if [[ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  cat >&2 <<'EOF'
Google Chrome was not found in /Applications.

Install Google Chrome, then rerun:
  npm run setup:browser
EOF
  exit 1
fi

echo "Using $("$PYTHON" --version)"

rm -rf .venv
"$PYTHON" -m venv .venv

.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install \
  "playwright==1.55.0" \
  "beautifulsoup4==4.13.5"

echo
echo "Browser importer installed."
echo
echo "Important:"
echo "  - Imports launch normal Google Chrome directly."
echo "  - If Cloudflare asks for verification, complete it manually."
echo "  - The importer resumes automatically after Peakbagger loads."
echo "  - No Playwright browser download is required."
