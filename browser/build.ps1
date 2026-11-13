$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path 'node_modules/three/build/three.module.js')) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }
    $linuxProject = (wsl -- wslpath -u $PSScriptRoot).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'WSL is required for this build script' }
    wsl -- bash "$linuxProject/build.sh"
    if ($LASTEXITCODE -ne 0) { throw 'WebAssembly build failed' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Gameplay tests failed' }
} finally { Pop-Location }
