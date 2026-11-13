#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1
emcmake cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 4
mkdir -p dist/vendor
cp node_modules/three/build/three.module.js dist/vendor/three.module.js
cp node_modules/three/LICENSE dist/vendor/THREE-LICENSE.txt
cp ../openspades/LICENSE dist/OPENSPADES-LICENSE.txt
python3 extract_assets.py
