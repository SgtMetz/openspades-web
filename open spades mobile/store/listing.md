# Google Play listing — OpenSpades Mobile

Everything needed for Play Console → **Main store listing**, **App content** and **Store settings**.
Graphics in this folder: `icon-512.png` (app icon, 512×512) and `feature-graphic-1024x500.png`.
Phone screenshots (1920×1080, landscape): `screenshots/` — home screen, server browser, gameplay. Captured from the desktop preview (`scripts/serve.mjs`, touch mode, 1280×720 at 1.5× scale); the server list is filtered so no offensive community server names appear.

## App details

| Field | Value |
| --- | --- |
| App name (≤30) | OpenSpades |
| Package name | `app.openspadesweb.mobile` (permanent once uploaded) |
| Category | Game → Action |
| Tags | Shooter, Sandbox, Multiplayer, Building |
| Contact email | *(your support address — required)* |
| Website | https://openspadesweb.app/ |
| Privacy policy URL | https://openspadesweb.app/privacy/ (served by the hosting repo from `os-site/page/privacy/`, made from `store/privacy-policy.md`) |

### Short description (≤80)

Voxel shooter: dig, build and fight on classic Ace of Spades community servers.

### Full description (≤4000)

OpenSpades is a free, open-source voxel first-person shooter. Two teams battle across fully destructible block worlds: dig tunnels with your spade, build walls and bridges one block at a time, and fight it out with rifles, SMGs, shotguns and grenades.

PLAY ONLINE
• Join public community servers from the Build and Shoot server list
• Capture the Flag, Territorial Control, zombies, arena and more server modes
• Protocol 0.75 and 0.76 supported, with team and weapon selection, chat and scoreboard
• Connects directly to game servers — no relay, no account, no sign-up

PRACTICE OFFLINE
• Train against bots in a practice arena, or turn bots off for a sandbox
• Works with no internet connection

BUILT FOR TOUCH
• Virtual joystick, swipe to aim, and drag-to-aim on the Fire button
• Auto-sprint, toggle crouch, adjustable button size and opacity
• Left-handed layout, haptic feedback and adjustable look sensitivity
• Graphics quality presets for battery life or visuals

The same game core as the OpenSpades desktop client: movement, collision, weapons, grenades and structural collapse run from the original C++ code compiled to WebAssembly.

OpenSpades is free software licensed under the GNU GPL v3 or later. Source code: https://github.com/SgtMetz/openspades-web

Online play happens on community-run servers that are not operated by the developer. Chat with other players is not moderated by the app.

## App content (questionnaires)

- **Ads:** No ads.
- **App access:** All functionality available without special access (no login).
- **Content rating (IARC):** Violence — realistic weapons, players killed, no blood/gore shown as dismemberment; *Users can interact* — yes (unmoderated text chat on third-party servers); *Shares location* — no; *Digital purchases* — no. Expect roughly PEGI 12 / ESRB Teen.
- **Target audience:** 13+ (not designed for children; unmoderated chat).
- **News app:** No. **Government app:** No. **Financial features:** None. **Health:** None.
- **Data safety:**
  - Data collected by the developer: **none** (no analytics, crash SDKs, ads or accounts).
  - Data shared: when the player joins a server, the app sends the chosen **player name** and chat messages to that third-party game server, at the user's request; the server also sees the device's IP address. Declare under *App activity → Other user-generated content* as **shared, not collected**, required for the feature, user-initiated, not used for tracking.
  - Encrypted in transit: **No** (the Ace of Spades game protocol is plain UDP; the server list is fetched over HTTPS).
  - Users can request deletion: not applicable (no data stored by the developer).
- **Advertising ID declaration:** **No**, the app does not use the advertising ID.
- **Permissions used:** `INTERNET`, `ACCESS_NETWORK_STATE` only.

## Release notes (1.0.0)

First Android release: online play on public servers over native UDP, offline practice, touch controls and a redesigned mobile interface.
