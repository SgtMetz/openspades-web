# Original-client browser port: parity status and remaining gaps

Target: full feature parity with the desktop OpenSpades client, built from the upstream source in
`openspades/` (0.1.5-beta, master). Status as of 2026-11-12. **Not deployed.** No interactive
playtesting has been done; that is the user's job. "Verified" below means an automated check
passed. It does not mean the feature was played.

## How it is built and checked

| Command | What it proves |
| --- | --- |
| `wsl -- bash '/mnt/c/Open spades web/browser/full/build.sh' [--prepare]` | Regenerates `generated/` from upstream + `prepare.py` patches, builds `dist/full` (Emscripten, pthreads). |
| `node full-client.js --verify` (in `dist/full`, log `build/verify.log`) | Original AngelScript main menu + title map render on SWRenderer; all 12 original tool skins (view + third person) construct and render. |
| `wsl -- bash tools/validate_shaders.sh` | All 46 GLSL programs, across the renderer's setting combinations (1488 distinct variants), translates to GLSL ES 3.00 and links on Mesa GLES 3.2; negative controls rejected. |
| `node tools/headless-check.mjs` | Headless Edge + SwiftShader, no input. `gl`: SDLRunner + GLRenderer + scripted menu with 3D title map through WebGL 2 (23 programs, varying frames), and all 145 original sounds read through FileManager and decoded by Web Audio. `startup` (see below). `net-ip` / `net-int` / `net-name`: original NetClient connects through a WebSocket relay to a local ENet endpoint (`tools/enet_test_server.c`, WSL), receives its packet and disconnect reason; address as dotted IPv4, as integer (no dots) and as host name. |
| `node tools/headless-check.mjs startup launcher gl-low gl-medium gl-high gl-ultra` | `startup`: default start runs the device test and goes straight to the main menu (GL renderer). `launcher`: `?launcher` shows the original startup window. `gl-<preset>`: the scripted menu with its 3D title map renders through WebGL 2 with no GL errors under each preset the test can choose. |
| `node tools/headless-check.mjs touch` | `?touch=1`: touch mode detected, the client loop polls and drains the touch queue every frame, controls stay hidden in menus. `startup` also checks that a desktop page does not enable or poll touch input. |
| `npm test` (in `browser/`) | Existing playable port unaffected. |

All of the above passed on 2026-11-12.

## Fixed in this pass

- **Multiplayer transport (`enet_full.c`, `browser.js`)**:
  - Relay WebSockets now live on the main thread. Before, they lived on the client pthread, which never yields to its event loop, so they would never have delivered any data.
  - Host names map to placeholder addresses like getaddrinfo results.
  - Names without dots keep ServerAddress's integer meaning, and stale names are no longer reused.
  - One relay connection per ENet socket, closed by `enet_socket_destroy`, so disconnects and reconnects start clean.
  - A failed relay behaves like UDP to an unreachable server, so ENet's own timeouts apply.
- **Assets**:
  - The GPL paks (002/005/010/050/999) are now built from `openspades/Resources` exactly as `mkpak.sh` does.
  - Before, they were the 0.1.3 release paks, which predate the code; for example the client loads `Gfx/Spotlight.jpg` but the release has `Spotlight.png`, so joining a game failed.
  - `pak000-Nonfree` and `font-unifont` still come from the release, as upstream downloads them.
  - `PackageInfo.json` is the upstream one (0.1.5-beta).
- **Fatal error box**: SDL's message box called `alert()`, which the client worker does not have, so it crashed the page. It is now shown as a page dialog.
- **Fullscreen**: `r_fullscreen` and Alt+Enter now fullscreen the page. Before, they targeted the input canvas, which shows nothing because frames go to the overlay. Alt+Enter toggles from the real browser state, since Esc can also leave fullscreen.
- **Preference autosave**: the 2-second autosave no longer logs on every call, only when it writes.

## Implemented but not verified by any automated check (needs playtesting)

- Actual gameplay on a real server: map download, spawn, input, HUD, chat, scoreboard, and the rendering of a real map with water, shadows, dynamic lights and post-filters at the preference levels users pick.
- Pointer lock (`SDL_SetRelativeMouseMode` → Emscripten pointer lock on `#canvas`), keyboard capture (Tab, F-keys, Ctrl combos except C/V/X), and text input and IME.
- Fullscreen entry and exit, including deferral until the first click or key when `r_fullscreen=1` at startup.
- 3D audio during play: positional panning, listener-relative sounds, s_maxPolyphonics voice limit, reverb and obstruction.
- Clipboard (page paste/copy events feed the game clipboard), "open URL" link dialog, "show directory" saved-files dialog, and file import.
- Persistence of `/user` (IndexedDB) across reloads: settings, screenshots, demos and saved maps.
- Performance and frame pacing on real GPUs and on browsers other than Chromium.

## Known gaps and approximations

| Area | Desktop | Browser port | Impact |
| --- | --- | --- | --- |
| Command-line connect errors | `openspades aos://…` failure shows the fatal error box and exits. | Same, as a page dialog; the client stops until reload. | Matches desktop. Connecting from the main menu returns to the menu instead, as on desktop. |
| Message box | Modal; the call blocks until dismissed. | Non-blocking dialog. | Cosmetic. |
| Reverb (s_eax) | OpenAL EFX reverb, parameters from map raycasts. | Same parameter math drives a generated-impulse convolver. | Approximate sound. |
| Obstruction | Re-evaluated while a source plays. | Evaluated once when the sound starts. | Long sounds do not re-muffle as you move. |
| Opus decoding | libopus via OpenAL path. | Browser `decodeAudioData`. | Verified on Chromium only. Safari support for Ogg Opus decoding depends on the version: a risk to check. |
| Conditional rendering (occlusion queries) | Skips draws hidden last frame. | Draws while the query result is unavailable; WebGL never has it within the frame. | Possibly slower; never wrong output. |
| `GL_FRAMEBUFFER_SRGB` enable | Toggles sRGB encoding. | Ignored; WebGL always encodes sRGB attachments. | Verify the gamma of the post-process chain in playtesting. |
| `glMapBuffer` | Available. | Stub returning null. | No renderer calls `MapBuffer`, so no effect today. |
| Update check (`cl_checkForUpdates`, off by default) | Fetches `http://openspades.yvt.jp/api/version.json`. | Blocked: plain HTTP from an https page, and no CORS. | Leave off; it fails quietly. |
| Networking | Direct UDP. | Needs the WebSocket→UDP relay (`relay.mjs`), which refuses private and loopback addresses. | LAN or localhost servers cannot be joined through the production relay. |
| Window or video mode | Resolution list, windowed or fullscreen. | The overlay letterboxes the rendered frame into the page. | The mode list is not meaningful. How `r_videoWidth/Height` interact with page resizing has not been checked. |
| Touch devices | n/a | Detected like the existing port: mobile user agent, iPadOS, or a touch screen with a coarse primary pointer. Override with `?touch=1` / `?touch=0`; the existing port's saved Touch Controls choice is also honoured. Desktop pages are unchanged and never poll. On touch devices, menus are used by tapping the game (SDL turns taps into clicks). While playing, on-screen controls appear: stick, swipe to look, fire/aim/jump/crouch/sprint, tools, reload, chat, map, scores, menu and palette. A Keyboard button opens the soft keyboard for text fields. The controls send desktop key names, so bindings apply. | Not a desktop feature. Automated check covers only detection and the client loop draining queued input. Feel, layout, sensitivity, IME and performance on phones are untested. Fixed 1024×640 frame is letterboxed, so portrait leaves most of the screen black. |
| Safari / Firefox | n/a | Needs SharedArrayBuffer (COOP/COEP), OffscreenCanvas and WebGL 2. Only Chromium tested. | Untested. |
| Startup window (launcher) | Shown before the main menu (always, for this 0.1.5-beta package). | Skipped by request; the game starts at the main menu. `?launcher` still opens it. | Graphics options are only in the launcher. Without it they are set by the device test below, by `?quality=`, or by console commands. |
| Graphics settings | The user picks presets in the launcher. | Before start, the page runs a 250 ms WebGL fill-rate test (an RX 6700 scores ~185) and picks the launcher's Low/Medium/High/Ultra presets: Ultra ≥ 100, High ≥ 25, Medium ≥ 6. Software rasterisers get Low. Phones, tablets and devices with ≤ 4 GB of memory are capped at Medium; ≤ 2 GB gets Low. The result is remembered per GPU, so presets are written once. `?quality=low\|medium\|high\|ultra` forces a preset and `?quality=auto` re-tests. The window size follows the page at every start, at up to 1× / 1× / 1.5× / 2× device pixels and 0.9 / 2.1 / 3.7 / 8.3 megapixels per preset. | Thresholds are estimates from one real GPU plus published throughput figures, not measured on other devices. Ultra (HDR, global illumination, SSAO, volumetric fog) is checked only on SwiftShader. Resizing the page after start letterboxes, because the window is fixed, as on desktop. |
| Startup-window GL probe | Real driver capabilities. | WebGL 2 plus a reported desktop extension list. | The startup window may offer options that WebGL implements approximately (above). |

## Not done (decisions for the user)

- Deployment or publication of `dist/full`: not approved, so not done.
- Whether the production relay should ever allow private addresses (LAN play): left unchanged.
