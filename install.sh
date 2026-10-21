#!/usr/bin/env bash
# CrewBus CLI & Web Installer for macOS & Linux
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/eamonpluto/crewbus/master/install.sh | bash

set -euo pipefail

echo ""
echo "  ========================================"
echo "    CrewBus Installer                     "
echo "  ========================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 18) is required. Please install Node.js from https://nodejs.org first." >&2
  exit 1
fi

echo "==> Installing crewbus globally via npm..."
npm install -g crewbus

echo "==> Successfully installed crewbus."
echo ""
echo "Run 'crewbus web --open' to start the web dashboard."
echo "Run 'crewbus --help' for the CLI reference."
