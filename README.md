# OpenSpades — browser port

The OpenSpades client compiled to WebAssembly, playable at https://openspadesweb.app/. Licensed GPL-3.0-or-later, like upstream OpenSpades.

Double-click **Start OpenSpades.cmd** to open the game in your default browser. Node.js is required and is already installed on this machine. The launcher starts a hidden local HTTP server bound only to `127.0.0.1:8080`. If an older copy of the server (one without the multiplayer relay) still holds port 8080, the launcher uses the next free port up to 8089; end the old `node.exe server.mjs` process in Task Manager to get 8080 back.

Alternatively, run `npm start` from `browser` and visit http://127.0.0.1:8080/. Keep that terminal open while playing; Ctrl+C stops the server. Open the HTTP URL, not `index.html` directly.

The interface follows the original OpenSpades client: the main menu (logo over the `Title.vxl` fly-by, Quick Connect field with 0.75/0.76 toggles, sortable server list with flags, filter row), the team/weapon selection screen, scoreboard, kill feed, chat, minimap, block palette and health/ammo HUD are drawn with the original fonts and textures from the release's `.pak` files. **Setup** holds your player name, mouse sensitivity, volume and practice bot count.

**Practice** starts an offline match: pick Rifle, SMG or Shotgun and press **Spawn**. Eliminate 15 blue practice bots (or set Practice Opponents to *None* in Setup for a sandbox). Return to the light green spawn marker and press E to resupply.

## Multiplayer

Click a server in the list (from buildandshoot.com) or type an `aos://…` or `host:port` address, choose 0.75 or 0.76, and press **Connect** (or double-click a server). After the map downloads, pick a team and weapon (or Spectator) and press **Spawn**; keys 1–3 work as in the original. Comma / period reopen team / weapon selection (changing respawns you). ESC opens the in-game menu (Back to Game, Chat Log, Setup, Disconnect). The match keeps running while menus are open.

Browsers cannot send UDP, so the game uses a relay. The original ENet library and a port of OpenSpades' `NetClient` protocol code run in WebAssembly. The local server's `/relay` WebSocket endpoint (`browser/relay.mjs`) forwards each ENet datagram unchanged over UDP. The relay only accepts connections from the game's own page origin. Multiplayer therefore needs the local server; it does not work from a static file host.

Supported: AoS 0.75 and 0.76 handshake, version and extension queries, map download, CTF and TC objectives, team and weapon selection, spectating, movement, shooting and hit reports, digging and building, block lines, grenades, reloads, restocks, kill feed, chat (T / Y) and a scoreboard (Tab). Not supported: the 128-player extension, map caching, and player-model animation beyond walking.

## Controls

| Action | Control |
| --- | --- |
| Move / look | WASD / mouse |
| Jump / sprint / crouch | Space / Shift / Ctrl |
| Spade / block / gun / grenade | 1 / 2 / 3 / 4, or mouse wheel |
| Use selected tool | Left mouse |
| Aim down sights / dig 3 blocks / draw block line | Right mouse |
| Throw grenade | Hold left mouse, then release |
| Reload / resupply near spawn | R / E |
| Block color palette (block tool) | Arrow keys |
| Large map | M |
| Change team / weapon | , / . |
| Chat / team chat (multiplayer) | T / Y |
| Scoreboard | Tab |
| Menu / release mouse | Escape |

If pointer capture is denied, the game falls back to holding a mouse button and dragging to look. Escape still pauses. Settings are stored locally; map edits and match progress reset with a new match or page reload.

Phones and tablets automatically get touch controls and responsive menus. Move with the left joystick, swipe the view to look, and hold Fire / Use and Aim / Alt independently. Buttons cover jumping, crouching, sprinting, reloading, all four tools, block color, resupply, map, scores, chat and loadout selection. Hold Fire then release to throw a grenade. Landscape gives you more room. Touch Controls in Setup can override detection; `?touch=1` and `?touch=0` provide one-visit overrides. Input releases on cancellation, menu transitions, rotation and backgrounding. Mobile rendering uses a lower pixel ratio and disables shadow maps.

## Port scope

This is the first **offline playable port**, not a complete desktop-client port. The original OpenSpades C++ `Player`, `Weapon`, `World`, `GameMap`, `GameMapWrapper`, `Grenade`, math and reference-counting code is compiled into WebAssembly. Movement, collision, recoil, hitscan, weapon timings, ammunition, reloading, grenade physics, voxel editing and structural collapse execute in that native core.

New code supplies a local authoritative host, practice AI, a 128×128 arena within the native 512×512 map, a Three.js/WebGL renderer, KV6 model loader, Web Audio playback, browser input, HUD and menus. Bot weapon damage is reduced for practice. Original models and sounds are read from the supplied Windows release.

The first-person weapons port the original view skins (`Scripts/Skin/*/View.as`): models, iron sights, aim-down-sight alignment and zoom (rifle 1.4, SMG 0.8, shotgun 0.4 on a 68° base FOV), reload animations and two-bone arms.

Not yet ported: original OpenGL/software renderers, the AngelScript UI runtime (its layouts are reimplemented in HTML/canvas), spade dig and shotgun pump animations, CTF/TC modes, arbitrary VXL map import, full effects and positional audio, faithful fall damage, saved worlds. Bot steering is intentionally simple and can get stuck on edited terrain.

## Build

Play it online at https://openspadesweb.app/.

Clone with the upstream source and apply the browser patch:

```sh
git clone --recurse-submodules https://github.com/SgtMetz/openspades-web.git
cd openspades-web
git -C openspades apply ../patches/openspades-browser.patch
```

`openspades` is a submodule pinned to upstream commit `ff9b3e71b9ad26dda940923515de8b46f4bba5a5` from https://github.com/yvt/openspades. `patches/openspades-browser.patch` adds small `__EMSCRIPTEN__` guards that disable the desktop hit-test debugger and unused AngelScript include; gameplay implementations remain upstream. The build also needs the official OpenSpades 0.1.3 Windows release unpacked as `OpenSpades-0.1.3-Windows` in the repository root, for the game's models, sounds and `.pak` files (these are not in this repository).

The browser project is in `browser`. Build using:

```powershell
cd 'C:\Open spades web\browser'
.\build.ps1
```

The script uses WSL Ubuntu, CMake/Ninja and Emscripten at `~/emsdk` (verified with Emscripten 7.0.0). `EMSDK` may override that SDK path. The pinned Three.js dependency installs with `npm ci`. The build extracts media from `OpenSpades-0.1.3-Windows/Resources` and writes the runnable static files to `browser/dist`.

To build directly under WSL:

```sh
cd '/mnt/c/Open spades web/browser'
bash build.sh
```

Run `npm test` in `browser` for the native WebAssembly simulation tests. No browser or game server is needed for those tests.

`node tests/live.mjs [aos://address] [--via-relay]` is a live multiplayer test that needs internet access. It connects the WebAssembly client to a real public server (by default the lowest-latency one with free slots), downloads and decodes the map, joins, spawns, moves, fires and disconnects. With `--via-relay` (and `RELAY=ws://127.0.0.1:<port>`) the traffic goes through a running `server.mjs`.

## Verification

The WebAssembly build and automated gameplay tests pass. Tests cover movement/jump/crouch/collision; all three weapons and reloads; digging/building and inventory; grenade destruction; all 64 terrain meshes; bot hit detection, damage, elimination and respawn; and match reset. The menu and 3D arena were visually verified in the in-app browser.

Full interactive playtesting remains unverified: the in-app browser rejected pointer capture, and the native Firefox automation tool stopped because URL policy enforcement is unsupported. A drag-to-look fallback was added afterward and syntax-checked; it has not been interactively tested.

## Licensing and distribution

OpenSpades and this derived port use GPL-3.0-or-later. The upstream GPL is in `openspades/LICENSE`; the browser credits page and asset manifest preserve attribution. Three.js is MIT licensed.

The local official release contains nonfree sound assets whose credits prohibit separate redistribution. The extraction script preserves those credits. **This local build has not been deployed or published.** Replace restricted media or obtain the appropriate redistribution permission before publishing it. Supply corresponding source when distributing GPL binaries.
