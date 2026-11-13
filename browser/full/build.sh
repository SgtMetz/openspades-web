#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" == "--prepare" || ! -f generated/Client/Client.cpp ]]; then python3 prepare.py; fi
source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
emcmake cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
if ! cmake --build build -j 6 >build/compile.log 2>&1; then
  grep -B 2 -A 7 -E 'error:|FAILED:|undefined symbol' build/compile.log | head -n 120
  exit 1
fi
tail -n 4 build/compile.log
cp index.html ../dist/full/index.html
cp debug-log.js ../dist/full/debug-log.js
echo '{"type":"commonjs"}' > ../dist/full/package.json
