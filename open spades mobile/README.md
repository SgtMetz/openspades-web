# OpenSpades Mobile (Android)

An Android port of the OpenSpades web client, packaged for Google Play. Licensed GPL-3.0-or-later.

The game runs in a full-screen WebView. The WebAssembly gameplay core and Three.js renderer are the same as in `../browser`. Android-specific code adds:

- **Native UDP multiplayer.** The ENet client's datagrams go straight to game servers through Android `DatagramSocket`s (`UdpBridge.java`). On phones there is no WebSocket relay, so `relay.openspadesweb.app` is not involved.
- **Mobile interface.** The interface was redesigned for touch:
  - Home screen with large tiles.
  - Card-based server browser with search, filter chips, a sort menu and a Join bar.
  - Quick Connect screen.
  - Full-screen tabbed Settings.
  - Pause sheet.
  - Loadout picker.
  - Docked chat bar.
  - In-app credits and license viewer.
- **Touch controls.**
  - Joystick with auto-sprint at the rim.
  - Tap-to-toggle crouch.
  - You can keep dragging on Fire and Aim to look around.
  - Second Fire button for the left thumb.
  - Adjustable button size and opacity.
  - Left-handed layout.
  - Invert-Y.
  - Haptic feedback.
  - Graphics quality presets.
- **System integration.**
  - Immersive full screen, landscape, and display-cutout and gesture-bar safe areas.
  - The Back button closes the current screen or dialog, or pauses the game.
  - The game pauses when you leave the app.
  - The screen stays on during play.
  - Screenshots and `.vxl` maps save through the system "Save to…" picker, so no storage permission is needed.
  - Recovers if the WebView renderer crashes.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The game as packaged into the APK. `index.html`, `mobile.css`, `main.js` (a mobile fork of `browser/dist/main.js`), `touch.js` and `native.js` are maintained here. `engine/`, `vendor/`, `assets/` and the shared modules are copied from the web build. |
| `app/src/main/java/app/openspadesweb/mobile/MainActivity.java` | WebView host: serves `web/` from APK assets at `https://appassets.androidplatform.net`, handles the JS⇄native message channel, insets, Back, lifecycle, haptics and file saving |
| `app/src/main/java/app/openspadesweb/mobile/UdpBridge.java` | WebSocket-shaped UDP sockets for the ENet client |
| `scripts/sync-web.mjs` | Refreshes `web/` from `../browser/dist` after the web port is rebuilt |
| `scripts/serve.mjs` | Desktop preview of the mobile UI: `node scripts/serve.mjs`, then open http://127.0.0.1:8095/?touch=1 |
| `scripts/store-art.py` | Regenerates the Play Store icon and feature graphic |
| `store/` | Play Store graphics, listing text, questionnaire answers and privacy policy |
| `tests/` | `node tests/native.test.mjs` and `node tests/touch.test.mjs` |

## Toolchain

The project was built and verified on Windows with:

- **JDK:** Microsoft OpenJDK 17, in `%USERPROFILE%\.jdks\jdk-17.0.21.0.2+1`.
- **Android SDK:** in `%LOCALAPPDATA%\Android\Sdk`, with platforms 36 and 37.2, build-tools 36.0.0 and platform-tools.
- **Build tools:** Gradle 9.9.1 through the wrapper, and Android Gradle Plugin 9.5.1.
- **SDK levels:** compileSdk 37.2, targetSdk 36, minSdk 26 (Android 8.0).

Android Studio works too: open this folder.

## Build

```powershell
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jdk-17.0.21.0.2+1"
cd 'C:\Open spades web\open spades mobile'
node scripts/sync-web.mjs          # only needed when web/engine, web/vendor or web/assets are missing or stale
.\gradlew.bat bundleRelease        # Play Store upload → app\build\outputs\bundle\release\app-release.aab
.\gradlew.bat assembleDebug        # sideload test build → app\build\outputs\apk\debug\app-debug.apk
```

The debug build installs next to the release build as `app.openspadesweb.mobile.debug`. To install it on a phone with USB debugging enabled, run:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

Debug builds allow `chrome://inspect` WebView debugging from desktop Chrome.

## Signing

`keystore/upload.jks` is the **upload key**. The build reads it through `keystore.properties`, which holds the store path, alias and passwords. Both files are gitignored.

**Back up both files somewhere safe now**, for example in a password manager. Losing them means requesting an upload-key reset from Google.

Enroll the app in **Play App Signing** when you create it in Play Console, which is the default for new apps. Google then holds the app signing key and this file is only the upload key.

If `keystore.properties` is missing, the release build is produced unsigned.

## Publishing checklist

1. Create the app in Play Console. The package name is `app.openspadesweb.mobile`.
2. Upload `app-release.aab` to **Internal testing** first and test it on real phones:
   - Practice.
   - Joining a public server.
   - Rotating and leaving the app.
   - Saving a screenshot.
3. Fill in the store listing from `store/listing.md`.
   - Use `store/icon-512.png` and `store/feature-graphic-1024x500.png`.
   - Capture at least two landscape phone screenshots. In the app, use Pause → Screenshot, or run `adb exec-out screencap -p > shot.png`.
4. Host `store/privacy-policy.md` publicly, add a contact email, and paste its URL into Play Console.
5. Answer **Ads: No**, and complete these sections using the answers in `store/listing.md`:
   - Content rating.
   - Target audience (13+).
   - Data safety.
6. For each new release, increase `versionCode` (and `versionName`) in `app/build.gradle.kts`.

## Before publishing: asset licensing

The game media in `web/assets` comes from the official OpenSpades 0.1.3 release. The **nonfree sound pack (`pak000`) credits prohibit redistributing those sounds separately from official OpenSpades releases** (see `web/assets/License/Credits-pak000-Nonfree.md`). Publishing this APK on Google Play redistributes them.

Before a public release, do one of the following:

- Replace the restricted sounds with freely licensed ones.
- Get permission from the rights holders.

As a GPL-3.0 program, the published app must also offer its corresponding source. The Credits screen links to the repository; push this folder there before release.

## Not verified yet

The app has not been run on a phone or emulator. This PC has no Android device attached, and hardware virtualization is disabled in its firmware, so the emulator cannot run.

What was verified:

- The AAB and APK build, and the release bundle is signed. Android lint reports 0 errors.
- The mobile UI was exercised in a desktop browser at phone size: home, server browser and Join bar, quick connect, settings, pause menu, loadout, in-game touch HUD, and Back navigation.
- Unit tests cover the JS side of the UDP bridge and the touch controls.

The Java UDP path and the WebView integration need a test on a real device. That covers Back, insets, haptics, file saving and lifecycle.
