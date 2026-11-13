#!/usr/bin/env bash
# Builds and runs the offline GLSL ES 3.00 validator against the packaged original shaders.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../build
g++ -std=c++17 -O1 -o ../build/validate-shaders validate_shaders.cpp ../ShaderTranslator.cpp -lEGL -lGLESv2
EGL_PLATFORM=surfaceless ../build/validate-shaders ../resources "$@"
