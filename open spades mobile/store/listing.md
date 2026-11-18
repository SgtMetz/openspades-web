# Google Play listing — OpenSpades Mobile

Everything needed for Play Console → **Main store listing**, **App content** and **Store settings**.
Graphics in this folder: `icon-512.png` (app icon, 512×512) and `feature-graphic-1024x500.png`.
Phone screenshots (at least 2, 16:9 landscape, 1080p recommended) still need capturing from a device or emulator — see README.

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
• Free to play, supported by an occasional ad after you die (at most one every few minutes)

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

- **Ads:** **Yes, the app contains ads** (Google AdMob full-screen interstitials, shown only after the player dies, at most one every 4 minutes and never in the first 3 minutes after launch; see `AdManager.java`).
- **App access:** All functionality available without special access (no login).
- **Content rating (IARC):** Violence — realistic weapons, players killed, no blood/gore shown as dismemberment; *Users can interact* — yes (unmoderated text chat on third-party servers); *Shares location* — no; *Digital purchases* — no. Expect roughly PEGI 12 / ESRB Teen.
- **Target audience:** 13+ (not designed for children; unmoderated chat).
- **News app:** No. **Government app:** No. **Financial features:** None. **Health:** None.
- **Data safety:**
  - The developer runs no servers that collect data, but the **Google Mobile Ads SDK** (AdMob) and **User Messaging Platform** in the app do. Google's own guidance for these SDKs (https://developers.google.com/admob/android/privacy/play-data-disclosure) says to declare, as **collected** and **shared**, for **Advertising or marketing**, **Analytics** and **Fraud prevention, security, and compliance**:
    - *Location → Approximate location* (derived from the IP address)
    - *Device or other IDs* (advertising ID, app set ID)
    - *App activity → Other app interactions* (ad taps, views)
    - *App info and performance → Crash logs* and *Diagnostics*
    Mark them **not optional / required** (the app has no ad-free mode), processed **not ephemerally**. Re-check that page when upgrading the SDK.
  - Data shared: when the player joins a server, the app sends the chosen **player name** and chat messages to that third-party game server, at the user's request; the server also sees the device's IP address. Declare under *App activity → Other user-generated content* as **shared, not collected**, required for the feature, user-initiated, not used for tracking.
  - Encrypted in transit: **No** (the Ace of Spades game protocol is plain UDP; the server list is fetched over HTTPS).
  - Users can request deletion: no developer-held data. Ad data is Google's; the privacy policy links Google's controls. Players can reset or delete the advertising ID in Android settings, and change consent in Settings → Game → Privacy & ad choices (shown where consent rules apply).
- **Advertising ID declaration:** **Yes**, the app uses the advertising ID, for **Advertising or marketing** (the ads SDK adds `com.google.android.gms.permission.AD_ID`).
- **Permissions used:** `INTERNET`, `ACCESS_NETWORK_STATE`; added by the ads SDK: `AD_ID`, `ACCESS_ADSERVICES_AD_ID`, `ACCESS_ADSERVICES_ATTRIBUTION`, `ACCESS_ADSERVICES_TOPICS`, `WAKE_LOCK`, `FOREGROUND_SERVICE` (none are runtime prompts).

## Release notes (1.0.0)

First Android release: online play on public servers over native UDP, offline practice, touch controls and a redesigned mobile interface. Free with occasional ads.
