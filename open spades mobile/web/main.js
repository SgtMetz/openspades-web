import * as THREE from './vendor/three.module.js';
import createOpenSpades from './engine/openspades.js';
import {loadModel} from './models.js';
import {GameAudio} from './audio.js';
import * as H from './hud.js';
import {ViewWeapon} from './viewweapon.js';
import {detectTouch, TouchControls} from './touch.js';
import * as Native from './native.js';

const $ = id => document.getElementById(id), canvas = $('game');
const audio = new GameAudio();
let touchMode = 'auto';
try { touchMode = localStorage.getItem('openspades-touch-mode') || 'auto'; } catch {}
let touchEnabled = touchMode === 'on' || (touchMode !== 'off' && (Native.isNative || detectTouch()));
document.documentElement.classList.toggle('mobile', touchEnabled);
// Mobile-only preferences (stored separately from the shared web settings).
const mobile = {quality: 'medium', invertY: false, hudSize: 1, hudOpacity: .8, leftHanded: false, autoSprint: true, toggleCrouch: true, haptics: true};
try { Object.assign(mobile, JSON.parse(localStorage.getItem('openspades-mobile') || '{}')); } catch {}
function saveMobile() { try { localStorage.setItem('openspades-mobile', JSON.stringify(mobile)); } catch {} }
const QUALITY = {low: {ratio: .75, shadows: false, aa: false}, medium: {ratio: 1, shadows: false, aa: true}, high: {ratio: 1.5, shadows: true, aa: true}};
const quality = () => touchEnabled ? QUALITY[mobile.quality] || QUALITY.medium : {ratio: 1.5, shadows: true, aa: true};
const WEAPONS = ['Rifle', 'SMG', 'Shotgun'];
const CLIP = [10, 30, 6], MAX_STOCK = [50, 120, 48];
const STATUS = {idle: 0, connecting: 1, map: 2, game: 3, closed: 4};
const WHITE = [1, 1, 1];

// ---- Renderer ----
const renderer = new THREE.WebGLRenderer({canvas, antialias: quality().aa, powerPreference: 'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio, quality().ratio)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = quality().shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#1a1a1a'); scene.fog = new THREE.Fog('#1a1a1a', 20, 128);
const BASE_FOV = 68; // cg_fov
const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, .06, 420); camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xe4f0fa, 0x6b7450, 2.2));
const sun = new THREE.DirectionalLight(0xffedd1, 2.5); const sunOffset = new THREE.Vector3(-41, 80, -41);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, {left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 200});
sun.shadow.normalBias = .07; sun.shadow.bias = -.0001; scene.add(sun, sun.target);
const terrainMaterial = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1});
const modelMaterial = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1});
const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshStandardMaterial({color: 0x6f9fa9, roughness: .4, metalness: .15, transparent: true, opacity: .9}));
water.rotation.x = -Math.PI / 2; water.position.set(256, 1.05, 256); scene.add(water);
const viewScene = new THREE.Scene(); viewScene.add(new THREE.HemisphereLight(0xf1f5e5, 0x526044, 2.6));
const viewSun = new THREE.DirectionalLight(0xffefcd, 2); viewSun.position.set(-2, 5, 3); viewScene.add(viewSun);
const viewCamera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, .01, 10);
const viewWeapon = new ViewWeapon(viewScene, modelMaterial);
const cursor = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.015, 1.015, 1.015)), new THREE.LineBasicMaterial({color: 0xffffff, transparent: true, opacity: .6}));
scene.add(cursor); cursor.visible = false;
const spawnMarker = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, .08, 4), new THREE.MeshBasicMaterial({color: 0xc5df91, transparent: true, opacity: .7}));
spawnMarker.position.set(226.5, 16.04, 256.5); scene.add(spawnMarker);
const boxGeometry = new THREE.BoxGeometry(.08, .08, .08), particleMaterial = new THREE.MeshBasicMaterial({color: 0xc2af7e});
const objectives = new THREE.Group(); scene.add(objectives);
const hudCanvas = $('hud'), hctx = hudCanvas.getContext('2d');
const topMap = document.createElement('canvas'); topMap.width = topMap.height = 512; const topCtx = topMap.getContext('2d');

// ---- Game state ----
let engine, ready = false, mode = 'title', playing = false, dragLook = false, suppressMenuOnUnlock = false;
let yaw = 0, pitch = 0, buttons = 0, tool = 2, requestedTool = 2, sensitivity = 1, accumulator = 0, last = performance.now();
let state = new Float32Array(32), roster = new Float32Array(0), bounds = [0, 0, 512, 512], lastMapUpdate = -10, botCount = 6;
let limboOpen = false, chatOpen = false, chatTeam = false, scoresHeld = false, bigMap = false, mapZoom = 0, overlay = null;
let hitFeedback = 0, hitFriendly = false, hurtFlash = 0, lastHealth = 100, previousAlive = true, titleTime = 0, offlineWonAt = -1;
let lastEye = null, velocity = [0, 0, 0], frameCount = 0;
const keys = new Set(), chunkMeshes = new Map(), dirtyChunks = new Set(), effects = [], grenadeMeshes = [], avatars = [];
let chunkList = [], titleMap = null, geometries = {};
const net = {status: 0, ws: null, generation: -1, serverName: '', joined: false, team: 2, weapon: 0, info: new Float32Array(64), mapSize: 0, error: '', address: '', name: 'Deuce'};
const freeCam = new THREE.Vector3(256, 40, 256);
const killfeed = new H.ChatWindow(true), chat = new H.ChatWindow(false), centerMessages = new H.CenterMessages(), alert = new H.Alert(), limbo = new H.Limbo();
const chatLog = [];
const touch = new TouchControls($('touch-controls'), {
  look: (dx, dy) => {
    if (!playing || chatOpen || overlay || limboOpen) return;
    const zoom = viewWeapon.zoomScale(tool, state[21]);
    yaw += dx * .005 * sensitivity / zoom;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (mobile.invertY ? -dy : dy) * .005 * sensitivity / zoom));
  },
  tap: () => Native.haptic('tap'),
  action: code => {
    if (code === 'menu') { openGameMenu(); return; }
    if (code === 'fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      else if (parent !== window) parent.postMessage({type: 'openspades-expand'}, location.origin);
      return;
    }
    gameAction(code);
  },
});
const heldKey = code => keys.has(code) || touch.keys.has(code);
const heldButtons = () => buttons | touch.buttons;
let selectionSignature = '';
function syncTouch() {
  touch.setActive(touchEnabled && playing && !overlay && !limboOpen && !chatOpen && mode !== 'title');
  const selection = $('mobile-limbo'), visible = touchEnabled && limboOpen && !overlay;
  selection.hidden = !visible;
  const signature = [visible, limbo.teams, limbo.team, limbo.weapon, requestedTool, mode, visible ? teamName(0) : '', visible ? teamName(1) : ''].join('|');
  if (signature === selectionSignature) return;
  selectionSignature = signature;
  if (visible) {
    $('mobile-teams').hidden = !limbo.teams;
    document.querySelectorAll('[data-team]').forEach(b => {
      const t = Number(b.dataset.team); b.textContent = t < 2 ? teamName(t) : 'Spectator';
      b.setAttribute('aria-pressed', String(limbo.team === t));
    });
    $('mobile-weapons').hidden = limbo.team === 2;
    document.querySelectorAll('[data-weapon]').forEach(b => b.setAttribute('aria-pressed', String(limbo.weapon === Number(b.dataset.weapon))));
    $('mobile-spawn').textContent = limbo.team === 2 ? 'Spectate' : 'Spawn';
  }
  document.querySelectorAll('.touch-tools button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === requestedTool)));
  document.querySelector('[data-action="KeyE"]').hidden = mode !== 'offline';
  for (const b of document.querySelectorAll('[data-action="ArrowRight"],[data-action="ArrowLeft"]')) b.hidden = requestedTool !== 1;
  document.documentElement.classList.toggle('online', mode === 'online');
  const active = mode !== 'title';
  if (active !== gameActive) { gameActive = active; Native.setGameActive(active); }
}
let gameActive = false;

const settings = {sensitivity: 1, volume: .55, name: 'Deuce', nameChosen: false, address: '127.0.0.1', protocol: 3, bots: 6, filters: {}};
const api = {
  input: (...a) => mode === 'online' ? engine._os_net_input(...a) : engine._os_input(...a),
  step: dt => mode === 'online' ? engine._os_net_step(dt) : engine._os_step(dt),
  reload: () => mode === 'online' ? engine._os_net_reload() : engine._os_reload(),
  color: c => mode === 'online' ? engine._os_net_color(c) : engine._os_color(c),
};
function readState() { const p = engine._os_state() >>> 2; return engine.HEAPF32.slice(p, p + 32); }
function readPlayers() { const n = engine._os_player_slots(), p = engine._os_players() >>> 2; return engine.HEAPF32.slice(p, p + n * 16); }
function str(ptr) { return engine.UTF8ToString(ptr); }
function packed(c) { return ((c & 255) << 16) | (c & 0xff00) | ((c >>> 16) & 255); }
function worldPosition(x, y, z) { return new THREE.Vector3(x, 64 - z, y); }
function teamColor(t) { return t < 2 ? H.teamRGB(engine._os_team_color(t)) : [1, 1, 1]; }
function teamName(t) { return t < 2 ? str(engine._os_team_name(t)) || (t ? 'Green' : 'Blue') : 'Spectator'; }
function playerName(id) { return str(engine._os_player_name(id)); }
function myId() { return state[28] ? state[29] : -1; }
function joinedTeam() { return state[28] ? (state[30] < 2 ? state[30] : 2) : -1; }
function now() { return performance.now() / 1000; }
function addChat(parts) { chat.add(parts); chatLog.push(parts); if (chatLog.length > 400) chatLog.shift(); }

// ---- Terrain chunks ----
function resetChunks() {
  for (const m of chunkMeshes.values()) { scene.remove(m); m.geometry.dispose(); }
  chunkMeshes.clear(); dirtyChunks.clear();
  bounds = [0, 1, 2, 3].map(i => engine._os_bounds(i)); chunkList = [];
  for (let cy = bounds[1] >> 4; cy < bounds[3] >> 4; cy++) for (let cx = bounds[0] >> 4; cx < bounds[2] >> 4; cx++) {
    const i = cy * 32 + cx; engine._os_dirty(i); chunkList.push(i); dirtyChunks.add(i);
  }
  topCtx.fillStyle = '#000'; topCtx.fillRect(0, 0, 512, 512); lastMapUpdate = -10;
}
function rebuildChunk(i) {
  const n = engine._os_mesh(i), old = chunkMeshes.get(i);
  if (!n) { if (old) { scene.remove(old); old.geometry.dispose(); chunkMeshes.delete(i); } return; }
  const ni = engine._os_mesh_index_count(), pp = engine._os_mesh_positions(), np = engine._os_mesh_normals(), cp = engine._os_mesh_colors(), ip = engine._os_mesh_indices() >>> 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(engine.HEAPU8.slice(pp, pp + n * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(engine.HEAP8.slice(np, np + n * 3), 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(engine.HEAPU8.slice(cp, cp + n * 3), 3, true));
  g.setIndex(new THREE.BufferAttribute(engine.HEAPU32.slice(ip, ip + ni), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 32, 8), 36); g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 64, 16));
  if (old) { old.geometry.dispose(); old.geometry = g; }
  else { const m = new THREE.Mesh(g, terrainMaterial); m.castShadow = m.receiveShadow = true; m.position.set((i % 32) * 16, 0, Math.floor(i / 32) * 16); m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); chunkMeshes.set(i, m); }
}
function updateChunks(budget, maxDistance = Infinity) {
  for (const i of chunkList) if (engine._os_dirty(i)) dirtyChunks.add(i);
  if (!dirtyChunks.size) return;
  const cx = camera.position.x, cz = camera.position.z, d = i => ((i % 32) * 16 + 8 - cx) ** 2 + (Math.floor(i / 32) * 16 + 8 - cz) ** 2;
  const list = [...dirtyChunks].filter(i => d(i) < maxDistance * maxDistance);
  if (list.length > 1) list.sort((a, b) => d(a) - d(b));
  const t0 = performance.now();
  for (const i of list) { rebuildChunk(i); dirtyChunks.delete(i); if (performance.now() - t0 > budget) break; }
}
function refreshMap() {
  const w = bounds[2] - bounds[0], h = bounds[3] - bounds[1], p = engine._os_top_map(bounds[0], bounds[1], w, h) >>> 2;
  topCtx.putImageData(new ImageData(new Uint8ClampedArray(engine.HEAPU32.slice(p, p + w * h).buffer), w, h), bounds[0], bounds[1]);
}

// ---- Player avatars ----
async function teamParts(color) {
  const [head, torso, leg, arms] = await Promise.all(['Player/Head', 'Player/Torso', 'Player/Leg', 'Player/Arms'].map(n => loadModel(n, color)));
  return [torso, head, arms, leg, leg];
}
function createAvatar() {
  const group = new THREE.Group(), upper = new THREE.Group(), parts = []; group.add(upper);
  for (const [x, y, z, inUpper] of [[0, -.2, 0, 0], [0, -.2, 0, 0], [0, -.3, 0, 1], [-.25, -1.1, 0, 0], [.25, -1.1, 0, 0]]) {
    const m = new THREE.Mesh(geometries.parts[parts.length], modelMaterial); m.scale.setScalar(.1); m.position.set(x, y, z); m.castShadow = true; (inUpper ? upper : group).add(m); parts.push(m);
  }
  const toolMeshes = [geometries.rifle, geometries.smg, geometries.shotgun, geometries.spade, geometries.block, geometries.grenade].map((g, i) => {
    const m = new THREE.Mesh(g, modelMaterial); m.scale.setScalar(i < 4 ? .027 : .05); m.position.set(.25, -.35, -.5); m.castShadow = true; m.visible = false; upper.add(m); return m;
  });
  group.visible = false; scene.add(group);
  return {group, upper, parts, toolMeshes, color: -1, pending: -1};
}
function avatar(i) { while (avatars.length <= i) avatars.push(createAvatar()); return avatars[i]; }
function applyTeamColor(a, color) {
  if (a.color === color || a.pending === color) return; a.pending = color;
  teamParts(color).then(parts => { if (a.pending !== color) return; a.color = color; parts.forEach((g, k) => a.parts[k].geometry = g); }).catch(() => {});
}
async function prepareModels() {
  const [rifle, smg, shotgun, spade, block, grenade, intel, checkpoint] = await Promise.all(['Weapons/Rifle/Weapon', 'Weapons/SMG/Weapon', 'Weapons/Shotgun/Weapon', 'Weapons/Spade/Spade', 'Weapons/Block/Block', 'Weapons/Grenade/Grenade', 'MapObjects/Intel', 'MapObjects/CheckPoint'].map(n => loadModel(n)));
  geometries = {rifle, smg, shotgun, spade, block, grenade, intel, checkpoint, parts: await teamParts(0x4678b6)};
  await viewWeapon.load();
  for (let i = 0; i < 12; i++) avatar(i);
}
function hideAvatars() { for (const a of avatars) a.group.visible = false; }
function updateAvatars() {
  const slots = Math.max(avatars.length, roster.length / 16);
  for (let i = 0; i < slots; i++) {
    const b = i * 16, exists = b < roster.length && roster[b + 11] && !roster[b + 14] && roster[b + 8] < 2;
    if (i >= avatars.length && !exists) continue;
    const a = avatar(i);
    a.group.visible = !!(exists && roster[b + 6]); if (!a.group.visible) continue;
    applyTeamColor(a, mode === 'online' ? packed(engine._os_team_color(roster[b + 8])) : 0x4678b6);
    a.group.position.set(roster[b], 64 - roster[b + 2], roster[b + 1]); a.group.rotation.y = -Math.atan2(roster[b + 4], roster[b + 3]) - Math.PI / 2;
    a.upper.rotation.x = -Math.asin(Math.max(-1, Math.min(1, roster[b + 5])));
    const walk = Math.sin(roster[b + 10] * Math.PI * 2) * .45; a.parts[3].rotation.x = walk; a.parts[4].rotation.x = -walk;
    const t = roster[b + 12], shown = t === 2 ? roster[b + 13] : t === 0 ? 3 : t === 1 ? 4 : 5; a.toolMeshes.forEach((m, k) => m.visible = k === shown);
  }
}
function updateObjectives() {
  for (const m of objectives.children) m.material.dispose(); objectives.clear();
  if (mode !== 'online' || net.status !== STATUS.game) return;
  const i = net.info;
  const marker = (geo, x, y, z, color, scale) => { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({color, roughness: .8})); m.scale.setScalar(scale); m.position.copy(worldPosition(x, y, z)); objectives.add(m); };
  if (i[4] === 0) for (let t = 0; t < 2; t++) { const color = packed(engine._os_team_color(t)); marker(geometries.checkpoint, i[18 + t * 3], i[19 + t * 3], i[20 + t * 3] - 1, color, .1); if (!i[9 - t]) marker(geometries.intel, i[12 + t * 3], i[13 + t * 3], i[14 + t * 3] - .5, color, .1); }
  else { const n = i[24], d = territories(n); for (let t = 0; t < n; t++) marker(geometries.checkpoint, d[t * 6], d[t * 6 + 1], d[t * 6 + 2] - 1, d[t * 6 + 3] < 2 ? packed(engine._os_team_color(d[t * 6 + 3])) : 0xcccccc, .1); }
}
function territories(n) { const p = engine._os_net_territories() >>> 2; return engine.HEAPF32.slice(p, p + n * 6); }

// ---- Title screen (MainScreenUI: Maps/Title.vxl, camera gliding along y = 256) ----
async function fetchTitleMap() { titleMap = new Uint8Array(await (await fetch('assets/Maps/Title.vxl')).arrayBuffer()); }
function enterTitle() {
  mode = 'title'; playing = false; limboOpen = false; closeChat(); hideAvatars(); clearEffects(); objectives.clear();
  const p = engine._malloc(titleMap.length); engine.HEAPU8.set(titleMap, p); engine._os_load_vxl(p, titleMap.length); engine._free(p);
  resetChunks(); state = readState(); roster = new Float32Array(0);
  scene.background.set('#1a1a1a'); scene.fog.color.set('#1a1a1a'); scene.fog.near = 16; scene.fog.far = 128;
  water.material.color.setRGB(.07, .07, .07); spawnMarker.visible = false; cursor.visible = false;
  titleTime = 0; killfeed.clear(); chat.clear(); centerMessages.entries = [];
  showMainMenu();
}
function titleCamera(dt) {
  titleTime += dt;
  // The original renderer wraps the map at its edges; this one does not, so the glide stays clear of them.
  let cx = titleTime; cx -= Math.floor(cx / 380) * 380; cx = 450 - cx;
  camera.fov = 30; camera.near = .1; camera.far = 222; camera.updateProjectionMatrix();
  camera.position.set(cx, 64 - 12, 256); camera.up.set(0, 1, 0); camera.lookAt(cx + .1, 64 - 12.5, 257);
}

// ---- Main menu (MainMenu.as) ----
let servers = [], sortKey = 'players', sortDesc = true, flagTable = {};
let screen = 'home', selectedServer = null;
function showScreen(name) {
  screen = name;
  for (const s of ['home', 'servers', 'quick']) $('screen-' + s).hidden = s !== name;
  if (name === 'servers') { if (!servers.length) loadServers(); else renderServerList(); }
  if (name === 'home') $('home-name').textContent = settings.nameChosen ? settings.name : 'Deuce (tap to change)';
}
function showMainMenu() {
  $('menu').hidden = false; document.body.classList.add('in-menu'); hudCanvas.classList.remove('interactive');
  if (document.pointerLockElement) { suppressMenuOnUnlock = true; document.exitPointerLock(); }
  setOverlay(null); showScreen(screen === 'quick' ? 'quick' : screen === 'servers' ? 'servers' : 'home');
}
function hideMainMenu() { $('menu').hidden = true; document.body.classList.remove('in-menu'); }
function setProtocol(v) { settings.protocol = v; $('proto-3').classList.toggle('on', v === 3); $('proto-4').classList.toggle('on', v === 4); saveSettings(); }
async function loadServers() {
  $('list-status').textContent = 'Loading...'; $('server-list').replaceChildren();
  try {
    const r = await fetch('https://services.buildandshoot.com/serverlist.json', {cache: 'no-store'}); if (!r.ok) throw Error(r.status);
    servers = (await r.json()).filter(s => s && s.identifier && s.name);
    $('list-status').textContent = '';
    const again = selectedServer && servers.find(s => s.identifier === selectedServer.identifier);
    if (again) selectServer(again); else selectedServer = null;
  } catch { servers = []; $('list-status').textContent = 'Failed to fetch the server list.'; }
  renderServerList();
}
function renderServerList() {
  const f = settings.filters, text = $('filter-text').value.trim().toLowerCase();
  let list = servers.filter(s => {
    if (f.p3 && !f.p4 && s.game_version !== '0.75') return false;
    if (f.p4 && !f.p3 && s.game_version !== '0.76') return false;
    if (f.empty && s.players_current === 0) return false;
    if (f.full && s.players_current >= s.players_max) return false;
    if (text && !`${s.name} ${s.map} ${s.game_mode}`.toLowerCase().includes(text)) return false;
    return true;
  });
  const key = {name: s => s.name.toLowerCase(), players: s => s.players_current, map: s => String(s.map).toLowerCase(), mode: s => String(s.game_mode), version: s => s.game_version, country: s => s.country}[sortKey];
  list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (sortDesc ? -1 : 1); });
  const box = $('server-list'); box.replaceChildren();
  $('server-count').textContent = servers.length ? `${list.length}` : '';
  let lastTap = {id: '', at: 0};
  for (const s of list) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'server'; row.setAttribute('role', 'option');
    const n = s.players_current, max = s.players_max;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = s.name;
    const players = document.createElement('span');
    players.className = 'players' + (n >= max ? ' full' : n >= max * 3 / 4 ? ' busy' : n === 0 ? ' empty' : '');
    players.textContent = `${n}/${max}`; const pl = document.createElement('small'); pl.textContent = 'players'; players.append(pl);
    const meta = document.createElement('span'); meta.className = 'meta';
    const flag = flagTable[s.country];
    if (flag) { const e = document.createElement('i'); e.className = 'flag'; e.style.backgroundPosition = `${-flag[0] * 16}px ${-flag[1] * 16}px`; e.title = s.country; meta.append(e); }
    for (const [cls, text] of [['tag', s.game_mode], ['tag', s.game_version], ['', s.map]]) { const e = document.createElement('span'); if (cls) e.className = cls; e.textContent = text; meta.append(e); }
    row.append(name, players, meta);
    if (selectedServer?.identifier === s.identifier) row.classList.add('selected');
    row.onclick = () => {
      selectServer(s);
      document.querySelectorAll('.server').forEach(x => x.classList.toggle('selected', x === row));
      const t = performance.now(); if (lastTap.id === s.identifier && t - lastTap.at < 400) connect(s.name); lastTap = {id: s.identifier, at: t};
    };
    box.append(row);
  }
  if (servers.length && !list.length) $('list-status').textContent = 'No servers match the filter.';
  else if (servers.length) $('list-status').textContent = '';
  $('join-bar').hidden = !selectedServer || !list.includes(selectedServer);
}
function selectServer(s) {
  selectedServer = s; Native.haptic('tap');
  $('server-address').value = s.identifier; setProtocol(s.game_version === '0.76' ? 4 : 3); settings.address = s.identifier; saveSettings();
  $('join-name').textContent = s.name;
  $('join-detail').textContent = `${s.map} · ${s.game_mode} · ${s.players_current}/${s.players_max} players · ${s.game_version}`;
  $('join-bar').hidden = false;
  $('join-selected').disabled = !ready || s.players_current >= s.players_max;
  $('join-selected').textContent = s.players_current >= s.players_max ? 'Full' : 'Join';
}

// ---- Dialogs ----
function setOverlay(name) {
  overlay = name;
  if (name) touch.reset();
  $('dialog-layer').hidden = !name;
  for (const id of ['setup-dialog', 'game-menu', 'chat-log', 'message-box', 'name-dialog', 'credits-dialog']) $(id).hidden = true;
  if (name) $({setup: 'setup-dialog', menu: 'game-menu', chatlog: 'chat-log', message: 'message-box', name: 'name-dialog', credits: 'credits-dialog'}[name]).hidden = false;
  $('menu-disconnect').textContent = mode === 'online' ? 'Disconnect' : 'Quit to Menu';
  $('menu-chatlog').hidden = mode !== 'online';
  $('menu-loadout').hidden = mode === 'title';
  $('menu-note').textContent = mode === 'online' ? 'The match keeps running while this menu is open.' : 'Practice is paused.';
}
function showMessage(title, text) { $('message-title').textContent = title; $('message-text').textContent = text; setOverlay('message'); }
function openGameMenu() { releasePointer(); setOverlay('menu'); }
function showChatLog() {
  const box = $('chat-log-lines'); box.replaceChildren();
  for (const parts of chatLog) { const line = document.createElement('div'); for (const [t, c] of parts) { const s = document.createElement('span'); s.textContent = t; s.style.color = H.rgb(c); line.append(s); } box.append(line); }
  setOverlay('chatlog'); box.scrollTop = box.scrollHeight;
}

// ---- Practice (offline host) ----
function setupOffline(weapon) {
  mode = 'offline'; engine._os_init(weapon, botCount); tool = requestedTool = 2; yaw = 0; pitch = 0; buttons = 0; keys.clear(); accumulator = 0; lastHealth = 100; previousAlive = true; offlineWonAt = -1;
  scene.background.set('#b7cbd0'); scene.fog.color.set('#b7cbd0'); scene.fog.near = 65; scene.fog.far = 175; water.material.color.set(0x6f9fa9); spawnMarker.visible = true;
  resetChunks(); updateChunks(1e9); refreshMap(); clearEffects(); objectives.clear();
  for (let i = 0; i < 20; i++) engine._os_step(1 / 60);
  engine._os_clear_events(); state = readState(); roster = readPlayers();
}
function startPractice() {
  botCount = Number($('bots').value); killfeed.clear(); chat.clear();
  hideMainMenu(); setupOffline(limbo.weapon);
  limbo.teams = false; limbo.team = 0; openLimbo();
}

// ---- Limbo (team / weapon selection) ----
function openLimbo() {
  if (mode === 'online') { limbo.teams = true; const t = joinedTeam(); limbo.team = t >= 0 ? t : 2; if (state[28] && state[30] < 2) limbo.weapon = state[21]; }
  limboOpen = true; releasePointer(); hudCanvas.classList.add('interactive');
}
function closeLimbo() { limboOpen = false; hudCanvas.classList.remove('interactive'); }
function limboSpawn() {
  audio.unlock().catch(() => {});
  if (mode === 'offline') {
    if (limbo.weapon !== state[21] || state[19]) setupOffline(limbo.weapon);
    closeLimbo(); lock(); return;
  }
  const team = limbo.team === 2 ? 255 : limbo.team, weapon = limbo.weapon;
  if (!state[28]) { const p = engine.stringToNewUTF8(settings.name || 'Deuce'); engine._os_net_join(team, weapon, p); engine._free(p); }
  else {
    const current = state[30] < 2 ? state[30] : 255;
    if (team !== current) engine._os_net_change_team(team);
    if (team !== 255 && weapon !== state[21]) engine._os_net_change_weapon(weapon);
  }
  net.joined = true; net.team = team; net.weapon = weapon;
  closeLimbo(); lock();
}

// ---- Name prompt (multiplayer) ----
let pendingServer = null; // connect() call waiting on the name prompt
const cleanName = text => text.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 15);
function openNameDialog() {
  const input = $('name-input');
  input.value = settings.nameChosen ? settings.name : ''; $('name-error').hidden = true;
  setOverlay('name'); input.focus();
}
$('name-dialog').onsubmit = e => {
  e.preventDefault();
  const name = cleanName($('name-input').value);
  if (!name) { $('name-error').hidden = false; $('name-input').focus(); return; }
  settings.name = name; settings.nameChosen = true; $('player-name').value = name; saveSettings();
  setOverlay(null);
  const server = pendingServer; pendingServer = null;
  if (server !== null) connect(server);
};
$('name-cancel').onclick = () => { pendingServer = null; setOverlay(null); };

// ---- Multiplayer connection ----
function parseAddress(text) {
  const m = /^\s*(?:aos:\/\/)?([a-z0-9.-]+)(?::(\d{1,5}))?\s*$/i.exec(text); if (!m) return null;
  let host = m[1]; if (/^\d+$/.test(host)) { const n = Number(host); if (n > 0xffffffff) return null; host = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.'); }
  const port = Number(m[2] || 32887); return port > 0 && port < 65536 ? {host, port} : null;
}
function connect(serverName = '') {
  if (!ready) return;
  const address = $('server-address').value.trim(), target = parseAddress(address);
  if (!target) { showMessage('Error', 'Invalid server address. Use aos://1234567890:32887 or host:port.'); return; }
  if (!Native.isNative && location.protocol === 'file:') { showMessage('Error', 'Multiplayer needs the local OpenSpades server.'); return; }
  if (Native.isNative && navigator.onLine === false) { showMessage('No Connection', 'Connect to Wi-Fi or mobile data to play online.'); return; }
  // Players must pick their own name before joining a server.
  if (!settings.nameChosen) { pendingServer = serverName; openNameDialog(); return; }
  audio.unlock().catch(() => {});
  settings.address = address; saveSettings();
  disconnectSocket();
  net.address = address; net.error = ''; net.joined = false; net.generation = -1; net.mapSize = 0; net.serverName = serverName || address;
  // In the app, ENet datagrams go straight out over the phone's UDP stack; elsewhere through the WebSocket relay.
  const ws = Native.openDatagramSocket(target.host, target.port);
  const queue = [], outbox = []; net.ws = ws;
  ws.onopen = () => { for (const d of outbox.splice(0)) ws.send(d); };
  ws.onmessage = e => queue.push(new Uint8Array(e.data));
  ws.onclose = e => {
    if (net.ws !== ws) return; net.ws = null;
    if (net.status !== STATUS.idle && net.status !== STATUS.closed) {
      engine._os_net_disconnect();
      const why = e?.reason || (Native.isNative ? (net.status === STATUS.connecting ? 'Could not reach that server. Check the address and your connection.' : 'The network connection was lost.')
        : (net.status === STATUS.connecting ? 'The local relay could not reach that server.' : 'The relay connection closed.'));
      netClosed(why);
    }
  };
  engine.osNet = {queue, send(d) { if (ws.readyState === 1) ws.send(d); else if (ws.readyState === 0 && outbox.length < 64) outbox.push(d); return d.length; }};
  mode = 'online'; hideMainMenu(); killfeed.clear(); chat.clear(); chatLog.length = 0;
  if (engine._os_net_connect(settings.protocol === 4 ? 4 : 3) !== 0) { netClosed('Could not start the network client.'); return; }
  net.status = STATUS.connecting; state = readState(); roster = new Float32Array(0); clearEffects(); resetChunks(); hideAvatars();
}
function disconnectSocket() {
  if (net.ws) { const ws = net.ws; net.ws = null; try { ws.close(); } catch {} }
  if (mode === 'online' && net.status !== STATUS.idle) engine._os_net_disconnect();
  net.status = STATUS.idle;
}
function leaveGame() { disconnectSocket(); enterTitle(); }
function netClosed(message) {
  net.error = message; net.status = STATUS.closed;
  if (net.ws) { const ws = net.ws; net.ws = null; try { ws.close(); } catch {} }
  enterTitle(); showMessage('Disconnected', message);
}
function onWorldLoaded() {
  resetChunks(); state = readState(); roster = readPlayers();
  const sky = new THREE.Color(H.rgb(H.teamRGB(engine._os_fog_color())));
  scene.background = sky; scene.fog.color.copy(sky); scene.fog.near = 40; scene.fog.far = 128;
  water.material.color.copy(sky).multiplyScalar(.7); spawnMarker.visible = false;
  freeCam.set(256, 30, 256); yaw = 0; pitch = .3;
  if (net.joined) { const p = engine.stringToNewUTF8(settings.name || 'Deuce'); engine._os_net_join(net.team, net.weapon, p); engine._free(p); }
  else openLimbo();
}
let lastDisconnect = '';
function pollNet() {
  if (mode !== 'online' || net.status === STATUS.idle || net.status === STATUS.closed) return;
  const s = engine._os_net_poll(); net.info = (() => { const p = engine._os_net_info() >>> 2; return engine.HEAPF32.slice(p, p + 64); })();
  handleMessages();
  if (s === STATUS.closed && net.status !== STATUS.closed) { netClosed(lastDisconnect || 'Disconnected from the server.'); return; }
  if (s === STATUS.game && net.info[26] !== net.generation) { net.status = s; net.generation = net.info[26]; onWorldLoaded(); }
  net.status = s;
}
const CAUSES = ['', 'Headshot', 'Melee', 'Grenade', 'Fall', 'Team Change', 'Weapon Change'];
function killFeedLine(killer, victim, killerTeam, victimTeam, type, weapon, killerId, victimId) {
  const cause = type === 0 ? WEAPONS[weapon] || 'Rifle' : CAUSES[type] || '???';
  const self = killerId === victimId, me = myId();
  const causeColor = killerTeam === victimTeam && !self ? H.COLOR.red : killerId === me || victimId === me ? H.COLOR.gray : WHITE;
  const parts = [[killer, teamColor(killerTeam)], [' [', WHITE], [cause, causeColor], ['] ', WHITE]];
  if (!self) parts.push([victim, teamColor(victimTeam)]);
  killfeed.add(parts);
}
function handleMessages() {
  const text = str(engine._os_net_messages()); if (!text) return; engine._os_net_clear_messages();
  for (const rec of text.split('\x1e')) {
    if (!rec) continue; const [k, a, b, c] = rec.split('\x1f');
    if (k === 'D') lastDisconnect = a;
    else if (k === 'L') net.mapSize = Number(a) || 0;
    else if (k === 'S') net.joined = true;
    else if (k === 'K') { const [type, kt, vt, weapon, kid, vid] = c.split(',').map(Number); killFeedLine(a, b, kt, vt, type, weapon, kid, vid); }
    else if (k === 'C' || k === 'G') { const t = Number(c); addChat(k === 'C' ? [['[Global] ', WHITE], [a, teamColor(t)], [': ' + b, WHITE]] : [[a, teamColor(t)], [': ' + b, WHITE]]); audio.play('Feedback/Chat', .4); }
    else if (k === 'M') {
      const prefix = a.slice(0, 3), body = a.slice(3);
      if (prefix === 'N% ') alert.show(body, 0, now());
      else if (prefix === '!% ') { alert.show(body, 2, now()); audio.play('Feedback/Alert', .5); }
      else if (prefix === '%% ') { alert.show(body, 1, now()); audio.play('Feedback/Alert', .5); }
      else if (prefix === 'C% ') centerMessages.add(body);
      else addChat([[a, WHITE]]);
    }
    else if (k === 'T') { const t = Number(c), tc = teamColor(t); addChat([[a, tc], [' joined ', WHITE], [b, tc], [' team', WHITE]]); }
    else if (k === 'Q') addChat([[`Player ${a} has left`, WHITE]]);
    else if (k === 'I') {
      const t = Number(c), other = teamName(1 - t), verb = b === 'captured' ? 'captured' : b === 'picked up' ? 'picked up' : 'dropped';
      addChat([[a, teamColor(t)], [` ${verb} `, WHITE], [other, teamColor(1 - t)], ["'s intel", WHITE]]);
      centerMessages.add(`${a} ${verb} ${other}'s Intel${verb === 'dropped' ? '' : '.'}`);
      if (b === 'captured') audio.play(t === state[30] ? 'Feedback/CTF/YourTeamCaptured' : 'Feedback/CTF/EnemyCaptured', .6);
      else if (b === 'picked up') audio.play(t === state[30] ? 'Feedback/CTF/YourTeamPickedUp' : 'Feedback/CTF/EnemyPickedUp', .5);
      else audio.play(t === state[30] ? 'Feedback/CTF/YourTeamDropped' : 'Feedback/CTF/EnemyDropped', .5);
    }
    else if (k === 'A') { const t = Number(c); addChat([[a, teamColor(t)], [' captured a territory', WHITE]]); centerMessages.add(`${a} captured a Territory`); audio.play(t === state[30] ? 'Feedback/TC/YourTeamCaptured' : 'Feedback/TC/EnemyCaptured', .6); }
    else if (k === 'W') { centerMessages.add(`${a} Wins!`); audio.play(Number(b) === state[30] ? 'Feedback/Win' : 'Feedback/Lose', .7); }
  }
}

// ---- Chat (ChatSayWindow) ----
function openChat(team) {
  if (mode !== 'online' || net.status !== STATUS.game || !state[28]) return;
  touch.reset();
  chatOpen = true; chatTeam = team; keys.clear(); buttons = 0; chat.expanded = true;
  $('chat-global').classList.toggle('on', !team); $('chat-team').classList.toggle('on', team);
  $('chat-form').hidden = false; $('chat-input').value = '';
  if (touchEnabled) $('chat-input').focus(); else setTimeout(() => $('chat-input').focus(), 0);
}
function closeChat() { chatOpen = false; chat.expanded = false; $('chat-form').hidden = true; $('chat-input').blur(); }
$('chat-form').onsubmit = e => { e.preventDefault(); const text = $('chat-input').value.trim(); if (text) { const p = engine.stringToNewUTF8(text); engine._os_net_chat(p, chatTeam ? 0 : 1); engine._free(p); } closeChat(); };
$('chat-input').addEventListener('keydown', e => { e.stopPropagation(); if (e.code === 'Escape') { e.preventDefault(); closeChat(); } });
$('chat-cancel').onclick = closeChat;
$('chat-global').onclick = () => { chatTeam = false; $('chat-global').classList.add('on'); $('chat-team').classList.remove('on'); $('chat-input').focus(); };
$('chat-team').onclick = () => { chatTeam = true; $('chat-team').classList.add('on'); $('chat-global').classList.remove('on'); $('chat-input').focus(); };

// ---- Pointer lock and input ----
function beginPlay(fallback) { dragLook = fallback; playing = true; keys.clear(); buttons = 0; last = performance.now(); accumulator = 0; setOverlay(null); audio.context?.resume(); }
async function lock() {
  audio.unlock().catch(() => {});
  if (touchEnabled) { beginPlay(true); return; }
  try { await canvas.requestPointerLock(); } catch { beginPlay(true); }
}
function releasePointer() {
  touch.reset(); playing = false; keys.clear(); buttons = 0; scoresHeld = false;
  if (document.pointerLockElement) { suppressMenuOnUnlock = true; document.exitPointerLock(); }
}
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { beginPlay(false); return; }
  const suppressed = suppressMenuOnUnlock; suppressMenuOnUnlock = false;
  if (mode === 'title' || suppressed || dragLook) return;
  touch.reset(); playing = false; keys.clear(); buttons = 0; scoresHeld = false;
  if (chatOpen) closeChat();
  if (!limboOpen) setOverlay('menu');
});
document.addEventListener('pointerlockerror', () => { if (mode !== 'title') beginPlay(true); });
function resume() { setOverlay(null); if (mode !== 'title' && !limboOpen) lock(); }
$('menu-back').onclick = resume;
$('menu-chatlog').onclick = showChatLog;
$('menu-setup').onclick = () => openSettings();
$('menu-loadout').onclick = () => {
  setOverlay(null);
  if (mode === 'offline') { limbo.teams = false; limbo.weapon = state[21]; }
  openLimbo();
};
function download(blob, name) { Native.saveFile(blob, name).catch(() => alert.show('Could not save the file', 2, now())); }
$('menu-save-map').onclick = () => {
  const n = engine._os_save_vxl();
  if (!n) { alert.show('No map is loaded', 2, now()); return; }
  const p = engine._os_saved_vxl();
  download(new Blob([engine.HEAPU8.slice(p, p + n)], {type: 'application/octet-stream'}), 'OpenSpades-map.vxl');
};
$('menu-screenshot').onclick = () => {
  // Explicitly render immediately before copying; WebGL's drawing buffer need not be preserved.
  renderer.autoClear = true; renderer.render(scene, camera);
  if (mode !== 'title' && firstPerson() && viewWeapon.render()) {
    renderer.autoClear = false; renderer.clearDepth(); renderer.render(viewScene, viewCamera); renderer.autoClear = true;
  }
  const shot = document.createElement('canvas'); shot.width = canvas.width; shot.height = canvas.height;
  const ctx = shot.getContext('2d'); ctx.drawImage(canvas, 0, 0); ctx.drawImage(hudCanvas, 0, 0, shot.width, shot.height);
  shot.toBlob(blob => { if (blob) download(blob, 'OpenSpades-screenshot.png'); }, 'image/png');
};
$('menu-disconnect').onclick = () => { setOverlay(null); leaveGame(); };
$('chat-log-close').onclick = () => setOverlay(mode === 'title' ? null : 'menu');
let settingsReturn = null;
function openSettings(tab = 'player') { settingsReturn = overlay === 'menu' || mode !== 'title' ? 'menu' : null; selectSettingsTab(tab); setOverlay('setup'); }
function closeSettings() { saveSettings(); saveMobile(); setOverlay(settingsReturn); if (mode === 'title') showScreen(screen); }
function selectSettingsTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => selectSettingsTab(b.dataset.tab));
$('setup-close').onclick = closeSettings;
$('message-ok').onclick = () => setOverlay(null);
$('quick-form').onsubmit = e => { e.preventDefault(); $('server-address').blur(); connect(); };
$('join-selected').onclick = () => { if (selectedServer) connect(selectedServer.name); };
$('practice').onclick = () => { if (ready) startPractice(); };
$('nav-servers').onclick = () => showScreen('servers');
$('nav-quick').onclick = () => showScreen('quick');
document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => showScreen(b.dataset.nav));
$('home-name').onclick = () => openSettings('player');
$('setup').onclick = () => openSettings();
$('credits').onclick = () => { closeCreditsDoc(); setOverlay('credits'); };
function closeCreditsDoc() { $('credits-doc').hidden = true; $('credits-main').hidden = false; }
$('credits-close').onclick = () => { if (!$('credits-doc').hidden) closeCreditsDoc(); else setOverlay(null); };
// Web links open in the browser; bundled license files are shown in place so the game page is never unloaded.
$('credits-dialog').addEventListener('click', async e => {
  const a = e.target.closest('a'); if (!a) return;
  e.preventDefault();
  if (/^https?:/.test(a.getAttribute('href'))) { Native.openExternal(a.href); return; }
  try {
    const text = await (await fetch(a.getAttribute('href'))).text();
    $('credits-doc').textContent = text; $('credits-main').hidden = true; $('credits-doc').hidden = false; $('credits-doc').scrollTop = 0;
  } catch { alert.show('Could not open that file', 2, now()); }
});
$('refresh').onclick = loadServers;
$('proto-3').onclick = () => setProtocol(3); $('proto-4').onclick = () => setProtocol(4);
for (const [id, key] of [['filter-3', 'p3'], ['filter-4', 'p4'], ['filter-empty', 'empty'], ['filter-full', 'full']]) {
  $(id).onclick = () => { settings.filters[key] = !settings.filters[key]; $(id).classList.toggle('on', settings.filters[key]); saveSettings(); renderServerList(); };
}
$('filter-text').oninput = renderServerList;
$('filter-text').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('sort-select').onchange = e => { sortKey = e.target.value; sortDesc = sortKey === 'players'; renderServerList(); };
$('server-address').addEventListener('input', e => { settings.address = e.target.value.trim(); saveSettings(); });
$('sensitivity').oninput = e => { sensitivity = settings.sensitivity = Number(e.target.value); $('sensitivity-value').textContent = `${sensitivity.toFixed(1)}×`; };
$('volume').oninput = e => { audio.volume = settings.volume = Number(e.target.value); $('volume-value').textContent = `${Math.round(settings.volume * 100)}%`; };
$('player-name').oninput = e => { const n = cleanName(e.target.value); settings.name = n || 'Deuce'; settings.nameChosen = !!n; };
$('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('touch-mode').value = touchMode;
function applyGraphics() {
  const q = quality(); renderer.setPixelRatio(Math.min(devicePixelRatio, q.ratio)); renderer.shadowMap.enabled = q.shadows;
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); resize();
}
$('touch-mode').onchange = e => {
  touchMode = e.target.value;
  try { localStorage.setItem('openspades-touch-mode', touchMode); } catch {}
  touchEnabled = touchMode === 'on' || (touchMode !== 'off' && (Native.isNative || detectTouch()));
  document.documentElement.classList.toggle('mobile', touchEnabled);
  touch.reset(); applyGraphics();
};
function applyMobile() {
  const root = document.documentElement;
  root.style.setProperty('--hud-scale', String(mobile.hudSize));
  root.style.setProperty('--hud-alpha', String(mobile.hudOpacity));
  root.classList.toggle('left-handed', !!mobile.leftHanded);
  touch.autoSprint = !!mobile.autoSprint;
  touch.setToggleKeys(mobile.toggleCrouch ? ['ControlLeft'] : []);
  Native.setHaptics(!!mobile.haptics);
  $('hud-opacity-value').textContent = `${Math.round(mobile.hudOpacity * 100)}%`;
}
for (const [id, key, kind] of [['quality', 'quality', 'select'], ['invert-y', 'invertY', 'check'], ['hud-size', 'hudSize', 'number'], ['hud-opacity', 'hudOpacity', 'number'],
  ['left-handed', 'leftHanded', 'check'], ['auto-sprint', 'autoSprint', 'check'], ['toggle-crouch', 'toggleCrouch', 'check'], ['haptics', 'haptics', 'check']]) {
  const el = $(id);
  if (kind === 'check') el.checked = !!mobile[key]; else el.value = String(mobile[key]);
  el.addEventListener(kind === 'number' && el.type === 'range' ? 'input' : 'change', () => {
    mobile[key] = kind === 'check' ? el.checked : kind === 'number' ? Number(el.value) : el.value;
    if (key === 'quality') applyGraphics();
    if (key === 'haptics' && el.checked) { Native.setHaptics(true); Native.haptic('hit'); }
    applyMobile(); saveMobile();
  });
}
applyMobile();
$('mobile-limbo-menu').onclick = openGameMenu;
$('mobile-spawn').onclick = limboSpawn;
document.querySelectorAll('[data-team]').forEach(b => b.onclick = () => { limbo.team = Number(b.dataset.team); });
document.querySelectorAll('[data-weapon]').forEach(b => b.onclick = () => { limbo.weapon = Number(b.dataset.weapon); });
$('bots').onchange = e => { settings.bots = Number(e.target.value); };
function saveSettings() { try { localStorage.setItem('openspades-settings', JSON.stringify(settings)); } catch {} }
try {
  const s = JSON.parse(localStorage.getItem('openspades-settings') || 'null');
  if (s) {
    settings.sensitivity = Math.max(.3, Math.min(2.5, Number(s.sensitivity) || 1)); settings.volume = Math.max(0, Math.min(1, Number(s.volume ?? .55)));
    if (s.name) settings.name = String(s.name).slice(0, 15);
    settings.nameChosen = !!s.nameChosen && !!s.name;
    if (s.address) settings.address = String(s.address);
    settings.protocol = s.protocol === 4 || s.version === '0.76' ? 4 : 3;
    if ([0, 3, 6, 10].includes(Number(s.bots))) settings.bots = Number(s.bots);
    if (s.filters && typeof s.filters === 'object') settings.filters = {p3: !!s.filters.p3, p4: !!s.filters.p4, empty: !!s.filters.empty, full: !!s.filters.full};
  }
} catch {}
sensitivity = settings.sensitivity; audio.volume = settings.volume;
$('sensitivity').value = settings.sensitivity; $('volume').value = settings.volume; $('player-name').value = settings.name; $('bots').value = String(settings.bots);
$('server-address').value = settings.address; setProtocol(settings.protocol);
$('sensitivity-value').textContent = `${Number(settings.sensitivity).toFixed(1)}×`; $('volume-value').textContent = `${Math.round(settings.volume * 100)}%`;
for (const [id, key] of [['filter-3', 'p3'], ['filter-4', 'p4'], ['filter-empty', 'empty'], ['filter-full', 'full']]) $(id).classList.toggle('on', !!settings.filters[key]);

hudCanvas.addEventListener('mousemove', e => { limbo.mouse = {x: e.clientX, y: e.clientY}; const hit = limboHit(e.clientX, e.clientY); if (hit && hit !== limbo.lastHover) audio.play('Feedback/Limbo/Hover', .5); limbo.lastHover = hit; });
hudCanvas.addEventListener('mousedown', e => {
  if (touchEnabled || !limboOpen || e.button !== 0) return;
  const hit = limboHit(e.clientX, e.clientY); if (!hit) return;
  audio.play('Feedback/Limbo/Select', .5);
  if (hit.type <= 2) limbo.team = hit.type; else if (hit.type <= 5) limbo.weapon = hit.type - 3; else limboSpawn();
});
function limboHit(x, y) { return limboOpen ? limbo.hit(innerWidth, innerHeight, [teamName(0), teamName(1)], x, y) : null; }
document.addEventListener('mousemove', e => {
  if (touchEnabled || !playing || chatOpen || (dragLook && !e.buttons)) return;
  const zoom = viewWeapon.zoomScale(tool, state[21]);
  yaw += e.movementX * .002 * sensitivity / zoom; pitch = Math.max(-1.5, Math.min(1.5, pitch + e.movementY * .002 * sensitivity / zoom));
});
canvas.addEventListener('mousedown', e => {
  if (touchEnabled) return;
  if (!playing && dragLook && mode !== 'title' && !limboOpen && !overlay) { playing = true; }
  if (!playing || chatOpen) return; if (e.button === 0) buttons |= 1; if (e.button === 2) buttons |= 2;
});
document.addEventListener('mouseup', e => { if (e.button === 0) buttons &= ~1; if (e.button === 2) buttons &= ~2; });
canvas.addEventListener('contextmenu', e => e.preventDefault()); hudCanvas.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (limboOpen) {
    if (e.code === 'Escape') { e.preventDefault(); if (mode === 'offline' || (state[28] && net.joined)) { closeLimbo(); lock(); } else setOverlay(overlay ? null : 'menu'); return; }
    if (overlay) return;
    // LimboView::KeyEvent
    if (e.key === '1') { if (limbo.teams && limbo.team === 2) limbo.team = 0; else { limbo.weapon = 0; limboSpawn(); } }
    if (e.key === '2') { if (limbo.teams && limbo.team === 2) limbo.team = 1; else { limbo.weapon = 1; limboSpawn(); } }
    if (e.key === '3') { if (limbo.team !== 2) limbo.weapon = 2; limboSpawn(); }
    return;
  }
  if (e.code === 'Escape' && dragLook && playing) { playing = false; setOverlay('menu'); return; }
  if (!playing || chatOpen) return;
  if (['Space', 'Tab', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Tab') scoresHeld = true;
  if (e.repeat) return;
  gameAction(e.code);
});
function gameAction(code) {
  if (!playing || chatOpen || overlay || limboOpen) return;
  if (code === 'KeyT' || code === 'Enter') { openChat(false); return; }
  if (code === 'KeyY') { openChat(true); return; }
  if (code === 'Comma' || code === 'Period') { if (mode === 'online' || code === 'Period') { if (mode === 'offline') { limbo.teams = false; limbo.weapon = state[21]; } openLimbo(); } return; }
  if (/^Digit[1-4]$/.test(code)) requestedTool = Number(code.slice(-1)) - 1;
  if (code === 'KeyR') api.reload();
  if (code === 'KeyE' && mode === 'offline') { if (Math.hypot(state[0] - 226.5, state[1] - 256.5) < 8) { engine._os_restock(); alert.show('Resupplied', 0, now()); } else alert.show('Return to the green spawn to resupply', 1, now()); }
  if (code === 'KeyM') { bigMap = !bigMap; }
  if (tool === 1 && code.startsWith('Arrow')) {
    let c = H.paletteIndex(state[31]); if (c < 0) c = 3;
    const n = H.PALETTE.length;
    if (code === 'ArrowLeft') c = (c + n - 1) % n; if (code === 'ArrowRight') c = (c + 1) % n;
    if (code === 'ArrowUp') c = c < 8 ? c + n - 8 : c - 8; if (code === 'ArrowDown') c = c >= n - 8 ? c - (n - 8) : c + 8;
    const col = H.PALETTE[c]; api.color(col[0] | (col[1] << 8) | (col[2] << 16));
  }
}
document.addEventListener('keyup', e => { keys.delete(e.code); if (e.code === 'Tab') scoresHeld = false; });
canvas.addEventListener('wheel', e => { if (playing && !chatOpen) { requestedTool = (requestedTool + (e.deltaY > 0 ? 1 : 3)) % 4; e.preventDefault(); } }, {passive: false});
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); buttons = 0; scoresHeld = false; } });
addEventListener('blur', () => { keys.clear(); buttons = 0; scoresHeld = false; });
addEventListener('resize', resize);
const safeArea = {top: 0, right: 0, bottom: 0, left: 0};
function readSafeArea() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['top', 'right', 'bottom', 'left']) safeArea[k] = parseFloat(cs.getPropertyValue('--native-' + k)) || 0;
}
Native.onNative('insets', m => {
  for (const k of ['top', 'right', 'bottom', 'left']) document.documentElement.style.setProperty(`--native-${k}`, `${Math.max(0, Number(m[k]) || 0)}px`);
  readSafeArea();
});
function resize() {
  readSafeArea();
  renderer.setSize(innerWidth, innerHeight); camera.aspect = viewCamera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); viewCamera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 2); hudCanvas.width = Math.round(innerWidth * dpr); hudCanvas.height = Math.round(innerHeight * dpr); hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
addEventListener('beforeunload', () => { if (mode === 'online' && net.status !== STATUS.idle) disconnectSocket(); });
// Keep the ENet connection alive whenever animation frames stall (hidden tab, occluded window).
let lastFrameAt = performance.now();
setInterval(() => { if (performance.now() - lastFrameAt > 300 && mode === 'online' && ready) { pollNet(); if (net.status === STATUS.game) { engine._os_net_input(0, 0, yaw, pitch, requestedTool); engine._os_net_step(1 / 30); engine._os_clear_events(); engine._os_net_poll(); } } }, 250);
function inputBits() {
  if (!playing || chatOpen) return 0; let b = 0;
  if (heldKey('KeyW')) b |= 1; if (heldKey('KeyS')) b |= 2; if (heldKey('KeyA')) b |= 4; if (heldKey('KeyD')) b |= 8;
  if (heldKey('Space')) b |= 16; if (heldKey('ControlLeft') || heldKey('ControlRight')) b |= 32; if (heldKey('ShiftLeft') || heldKey('ShiftRight')) b |= 64; if (heldKey('KeyV')) b |= 128;
  return b;
}
function input() { api.input(inputBits(), playing && !chatOpen ? heldButtons() : 0, yaw, pitch, requestedTool); }

// ---- World events: sounds and effects ----
function clearEffects() { audio.reset(); for (const e of effects) { scene.remove(e.mesh); if (e.unique) { e.mesh.geometry.dispose(); e.mesh.material.dispose(); } } effects.length = 0; }
function particles(pos, count = 5, explosion = false) {
  for (let i = 0; i < count; i++) { const mesh = new THREE.Mesh(boxGeometry, particleMaterial); mesh.position.copy(pos); if (explosion) mesh.scale.setScalar(2); scene.add(mesh); effects.push({mesh, life: explosion ? .8 : .35, velocity: new THREE.Vector3((Math.random() - .5) * 8, Math.random() * 7, (Math.random() - .5) * 8)}); }
}
const mapTracers = [];
function processEvents() {
  const n = engine._os_event_count(), p = engine._os_events() >>> 2, data = engine.HEAPF32.slice(p, p + n * 8); engine._os_clear_events();
  const me = state[28] ? state[29] : -2;
  for (let i = 0; i < n; i++) {
    const b = i * 8, type = data[b], id = data[b + 1], pos = worldPosition(data[b + 2], data[b + 3], data[b + 4]);
    const local = id === me, distance = camera.position.distanceTo(pos), far = Math.max(0, 1 - distance / 90), vol = local ? 1 : far * .55;
    const sound = (path, volume = 1) => audio.play(path, volume, 1, local ? null : pos);
    if (type === 1) { const w = WEAPONS[data[b + 5]] || 'Rifle'; if (local) { audio.play('Weapons/' + w + '/' + (w === 'SMG' ? 'V2Local' + (1 + Math.floor(Math.random() * 4)) : 'FireLocal'), 1); viewWeapon.fired(); } else if (distance < 180) sound('Weapons/' + w + '/' + (w === 'SMG' ? 'V2Third' + (1 + Math.floor(Math.random() * 4)) : distance > 45 ? 'FireFar' : 'Fire'), 1); }
    if (type === 2) { particles(pos, 3); if (distance < 60) audio.play('Weapons/Impacts/Block', .4, 1, pos); }
    if (type === 3) {
      const end = worldPosition(data[b + 5], data[b + 6], data[b + 7]), start = pos.clone();
      if (local) start.add(new THREE.Vector3(.2, -.25, 0).applyQuaternion(camera.quaternion));
      const g = new THREE.BufferGeometry().setFromPoints([start, end]), m = new THREE.Line(g, new THREE.LineBasicMaterial({color: local ? 0xffefb1 : 0xffce91, transparent: true, opacity: .55}));
      scene.add(m); effects.push({mesh: m, life: .065, unique: true});
      mapTracers.push({line: [data[b + 2], data[b + 3], data[b + 5], data[b + 6]], life: .3});
    }
    if (type === 4) { const water = data[b + 4] > 62; particles(pos, 35, true); audio.play('Weapons/Grenade/' + (water ? distance > 50 ? 'WaterExplodeFar' : 'WaterExplode' : distance > 50 ? 'ExplodeFar' : 'Explode1'), 2, 1, pos); const light = new THREE.PointLight(0xffd78c, 25, 12); light.position.copy(pos); scene.add(light); effects.push({mesh: light, life: .18}); }
    if (type === 5 && local) {
      const victim = data[b + 6], vb = victim * 16;
      hitFeedback = 1; hitFriendly = vb < roster.length && roster[vb + 8] === state[30] && mode === 'online';
      if (!hitFriendly) Native.haptic('hit');
      if (data[b + 7]) audio.play('Feedback/HeadshotFeedback', .5);
    }
    if (type === 6 && (local || distance < 60)) {
      sound('Player/' + (data[b + 5] ? 'Wade' : 'Footstep') + (1 + Math.floor(Math.random() * 8)), .25);
      if (data[b + 6] && !data[b + 5]) sound('Player/Run' + (1 + Math.floor(Math.random() * 12)), .25);
    }
    if (type === 7 && local) audio.play('Weapons/DryFire', .6);
    if (type === 8 && (local || distance < 60)) sound('Weapons/' + WEAPONS[data[b + 5]] + '/' + (local ? 'ReloadLocal' : 'Reload'), .7);
    if (type === 9 && (local || id === -1 || distance < 40)) {
      const bounce = id === -1 && (data[b + 2] || data[b + 3] || data[b + 4]);
      audio.play(id === -1 ? bounce ? 'Weapons/Grenade/Bounce' : 'Weapons/Grenade/Fire' : 'Weapons/Spade/Miss', .3, 1, id === -1 ? bounce ? pos : null : local ? null : pos);
    }
    if (type === 10 && mode === 'offline') {
      const killer = data[b + 5], kt = data[b + 6], kb = killer * 16, vb = id * 16;
      const kTeam = kb < roster.length ? roster[kb + 8] : 0, vTeam = vb < roster.length ? roster[vb + 8] : 0, weapon = kb < roster.length ? roster[kb + 13] : 0;
      killFeedLine(playerName(killer), playerName(id), kTeam, vTeam, kt, weapon, killer, id);
    }
    if (type === 11) { particles(pos, Math.min(12, data[b + 5])); audio.play('Misc/BlockFall', .5, 1, pos); }
    if (type === 12 && (local || distance < 60)) sound('Weapons/Block/Build', .5);
    if (type === 14) alert.show('Cannot place a block here', 2, now(), 1.5);
    if (type === 15 && (local || distance < 60)) sound('Weapons/Grenade/Throw', .5);
    if (type === 16 && local) audio.play('Weapons/RestockLocal', .6);
    if (type === 17) sound('Player/' + (data[b + 5] ? 'WaterJump' : 'Jump'), .4);
    if (type === 18) sound('Player/' + (data[b + 6] ? 'FallHurt' : data[b + 5] ? 'WaterLand' : 'Land'), .5);
    if (type === 19 && data[b + 5] === 2) sound('Weapons/Shotgun/' + (local ? 'CockLocal' : 'Cock'), .5);
    if (type === 20) audio.play('Weapons/Grenade/DropWater', .7, 1, pos);
  }
}

// ---- Per-frame world update ----
function firstPerson() { return state[28] && state[30] < 2; }
function updateCamera(dt) {
  if (firstPerson()) {
    camera.position.set(state[0], 64 - state[2], state[1]);
    camera.up.set(0, 1, 0); camera.lookAt(camera.position.x + state[3], camera.position.y - state[5], camera.position.z + state[4]);
    return;
  }
  const f = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)), r = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  if (playing && !chatOpen) {
    const speed = (heldKey('ShiftLeft') || heldKey('ShiftRight') ? 45 : 16) * dt;
    if (heldKey('KeyW')) freeCam.addScaledVector(f, speed); if (heldKey('KeyS')) freeCam.addScaledVector(f, -speed);
    if (heldKey('KeyD')) freeCam.addScaledVector(r, speed); if (heldKey('KeyA')) freeCam.addScaledVector(r, -speed);
    if (heldKey('Space')) freeCam.y += speed; if (heldKey('ControlLeft') || heldKey('ControlRight')) freeCam.y -= speed;
  }
  freeCam.x = Math.max(0, Math.min(512, freeCam.x)); freeCam.z = Math.max(0, Math.min(512, freeCam.z)); freeCam.y = Math.max(2, Math.min(90, freeCam.y));
  camera.position.copy(freeCam); camera.up.set(0, 1, 0); camera.lookAt(freeCam.x + f.x, freeCam.y + f.y, freeCam.z + f.z);
}
function updateVisuals(dt) {
  state = readState(); roster = readPlayers(); tool = state[11];
  if (state[6] < lastHealth && state[17]) { hurtFlash = 1; Native.haptic(lastHealth - state[6] >= 40 ? 'heavy' : 'hurt'); }
  if (previousAlive && state[28] && !state[17] && state[30] < 2) Native.haptic('heavy');
  lastHealth = state[6];
  if (state[28] && state[17] && !previousAlive && mode === 'offline') { yaw = 0; pitch = 0; }
  previousAlive = !!(state[28] && state[17]);
  updateAvatars();
  const count = engine._os_grenades(), gp = engine._os_grenade_data() >>> 2, gd = engine.HEAPF32.slice(gp, gp + count * 4);
  while (grenadeMeshes.length < count) { const m = new THREE.Mesh(geometries.grenade, modelMaterial); m.scale.setScalar(.033); scene.add(m); grenadeMeshes.push(m); }
  grenadeMeshes.forEach((m, i) => { m.visible = i < count; if (m.visible) { m.position.set(gd[i * 4], 64 - gd[i * 4 + 2], gd[i * 4 + 1]); m.rotation.x += dt * 4; m.rotation.z += dt * 3; } });
  updateCamera(dt);
  audio.listener(camera.position, camera.getWorldDirection(new THREE.Vector3()), camera.up);
  sun.target.position.set(Math.round(camera.position.x / 8) * 8, 10, Math.round(camera.position.z / 8) * 8); sun.position.copy(sun.target.position).add(sunOffset);
  updateChunks(6);
  // View weapon (ClientPlayer) and the aim-down-sight zoom (Client::GetAimDownZoomScale).
  const eye = [state[0], state[1], state[2]];
  if (lastEye && dt > 0) velocity = eye.map((v, i) => (v - lastEye[i]) / dt / 32);
  lastEye = eye;
  const me = state[29] * 16, moving = heldKey('KeyW') || heldKey('KeyA') || heldKey('KeyS') || heldKey('KeyD');
  if (firstPerson()) {
    const sp = engine._os_skin_states() >>> 2, skin = engine.HEAPF32.slice(sp + state[29] * 8, sp + state[29] * 8 + 8);
    viewWeapon.setArmColor(mode === 'online' ? packed(engine._os_team_color(state[30])) : 0x4678b6);
    viewWeapon.setBlockColor(packed(state[31]));
    viewWeapon.update(dt, {
      alive: !!state[17], tool, weapon: state[21], aiming: !!(heldButtons() & 2) && playing, sprinting: moving && (heldKey('ShiftLeft') || heldKey('ShiftRight')) && playing,
      velocity: [skin[3], skin[4], skin[5]], front: [state[3], state[4], state[5]], walk: me >= 0 && me < roster.length ? roster[me + 10] : 0, time: state[16],
      spadeAction: skin[0], spadeProgress: skin[1], readyState: skin[2],
      reloading: !!state[12], reloadProgress: state[13], cooking: !!state[26], cookTime: state[27], ammo: state[7], clipSize: CLIP[state[21]],
    });
  }
  const zoom = firstPerson() && state[17] ? viewWeapon.zoomScale(tool, state[21]) : 1;
  camera.fov = 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) / zoom) * 180 / Math.PI; camera.near = .06; camera.far = 420; camera.updateProjectionMatrix();
  viewCamera.fov = camera.fov; viewCamera.updateProjectionMatrix();
  cursor.visible = playing && tool === 1 && !!state[22] && !!state[17]; if (cursor.visible) cursor.position.set(state[23] + .5, 63.5 - state[25], state[24] + .5);
  for (let i = effects.length - 1; i >= 0; i--) { const e = effects[i]; e.life -= dt; if (e.velocity) { e.velocity.y -= dt * 18; e.mesh.position.addScaledVector(e.velocity, dt); } if (e.life <= 0) { scene.remove(e.mesh); if (e.unique) { e.mesh.geometry.dispose(); e.mesh.material.dispose(); } effects.splice(i, 1); } }
  for (let i = mapTracers.length - 1; i >= 0; i--) if ((mapTracers[i].life -= dt) <= 0) mapTracers.splice(i, 1);
  if (state[16] - lastMapUpdate > 3 || state[16] < lastMapUpdate) { refreshMap(); lastMapUpdate = state[16]; if (mode === 'online') updateObjectives(); }
  if (mode === 'offline' && state[19] && offlineWonAt < 0) { offlineWonAt = now(); centerMessages.add('Practice complete!'); audio.play('Feedback/Win', .7); }
  if (mode === 'offline' && offlineWonAt > 0 && now() - offlineWonAt > 6) setupOffline(state[21]);
}

// ---- 2D interface (Client::Draw2D) ----
function mapData() {
  const players = [], objects = [], spectator = !(state[28] && state[30] < 2), myTeam = state[30], me = myId();
  for (let s = 0; s * 16 < roster.length; s++) {
    const b = s * 16;
    if (!roster[b + 11] || !roster[b + 6] || roster[b + 8] >= 2) continue;
    if (!spectator && roster[b + 8] !== myTeam) continue;
    players.push({x: roster[b], y: roster[b + 1], angle: Math.atan2(roster[b + 3], -roster[b + 4]), weapon: roster[b + 13], id: s, focus: s === me});
  }
  let center = {x: state[0], y: state[1]};
  if (spectator) {
    center = {x: freeCam.x, y: freeCam.z};
    if (mode === 'online' && state[28]) players.push({x: freeCam.x, y: freeCam.z, angle: Math.atan2(Math.cos(yaw), -Math.sin(yaw)), weapon: 0, id: me, focus: true, spectator: true});
  }
  if (mode === 'online' && net.status === STATUS.game) {
    const i = net.info, t2 = performance.now() / 1000;
    if (i[4] === 0) for (let t = 0; t < 2; t++) {
      const color = teamColor(t);
      objects.push({x: i[18 + t * 3], y: i[19 + t * 3], icon: 'Map/CommandPost', color});
      if (!i[9 - t]) objects.push({x: i[12 + t * 3], y: i[13 + t * 3], icon: 'Map/Intel', color});
      else if (myTeam === 1 - t) { const c = i[10 + (1 - t)] * 16; if (c >= 0 && c < roster.length && roster[c + 8] === myTeam) objects.push({x: roster[c], y: roster[c + 1], icon: 'Map/Intel', color, alpha: Math.abs(Math.sin(t2 * 4))}); }
    }
    else { const n = i[24], d = territories(n); for (let t = 0; t < n; t++) objects.push({x: d[t * 6], y: d[t * 6 + 1], icon: 'Map/CommandPost', color: d[t * 6 + 3] < 2 ? teamColor(d[t * 6 + 3]) : [128 / 255, 128 / 255, 128 / 255]}); }
  }
  return {map: topMap, bounds, large: false, zoom: 0, center, players, objects, tracers: mapTracers.map(t => t.line)};
}
function scoreboardData() {
  const i = net.info, online = mode === 'online';
  const teams = [0, 1].map(t => ({name: teamName(t), color: teamColor(t), score: 0}));
  let capLimit = -1;
  if (online && i[4] === 0) { teams[0].score = i[5]; teams[1].score = i[6]; capLimit = i[7]; }
  else if (online) { const n = i[24], d = territories(n); for (let t = 0; t < n; t++) if (d[t * 6 + 3] < 2) teams[d[t * 6 + 3]].score++; capLimit = n; }
  const players = [];
  for (let s = 0; s * 16 < roster.length; s++) { const b = s * 16; if (!roster[b + 11]) continue; players.push({id: s, name: playerName(s), team: roster[b + 8] < 2 ? roster[b + 8] : 2, kills: roster[b + 15], alive: !!roster[b + 6], local: !!roster[b + 14]}); }
  return {teams, capLimit, players};
}
function hottrackedName(W, H) {
  if (!firstPerson() || !state[17]) return;
  const f = new THREE.Vector3(); camera.getWorldDirection(f);
  let best = null, bestDot = Math.cos(.04);
  for (let s = 0; s * 16 < roster.length; s++) {
    const b = s * 16; if (!roster[b + 11] || !roster[b + 6] || roster[b + 14] || roster[b + 8] !== state[30]) continue;
    const p = worldPosition(roster[b], roster[b + 1], roster[b + 2]), d = p.clone().sub(camera.position), len = d.length();
    if (len > 128) continue; const dot = d.normalize().dot(f); if (dot > bestDot) { bestDot = dot; best = {s, p}; }
  }
  if (!best) return;
  const v = best.p.clone().add(new THREE.Vector3(0, .6, 0)).project(camera); if (v.z > 1) return;
  const name = playerName(best.s), x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
  H.drawText(hctx, name, x - H.measure(hctx, name) / 2, y - 20, WHITE, 1, H.fonts.gui, .5);
}
function drawHud(dt) {
  const W = innerWidth, Ht = innerHeight, ctx = hctx, t = now();
  ctx.clearRect(0, 0, W, Ht);
  killfeed.update(dt, Ht); chat.update(dt, Ht); centerMessages.update(dt);
  if (mode === 'title') { const fade = Math.max(0, Math.min(1, (titleTime - 1) / 2.2)); if (fade < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - fade})`; ctx.fillRect(0, 0, W, Ht); } return; }
  if (mode === 'online' && net.status !== STATUS.game) {
    const progress = net.status === STATUS.map && net.mapSize ? Math.min(1, net.info[1] / net.mapSize) : null;
    H.drawLoading(ctx, W, Ht, net.status === STATUS.map ? `Loading snapshot (${Math.round(net.info[1] / 1024)} KB)` : 'Connecting to the server', progress, t);
    alert.draw(ctx, W, Ht, t); return;
  }
  hitFeedback = Math.max(0, hitFeedback - dt * 4); hurtFlash = Math.max(0, hurtFlash - dt * 3);
  mapZoom = bigMap ? Math.min(1, mapZoom + dt * 5) : Math.max(0, mapZoom - dt * 5);
  const hasPlayer = !!state[28];
  if (hasPlayer) {
    if (hurtFlash > 0) { ctx.fillStyle = `rgba(160,0,0,${hurtFlash * .35})`; ctx.fillRect(0, 0, W, Ht); }
    hottrackedName(W, Ht);
    const joined = state[30] < 2, alive = !!state[17];
    if (joined && alive) {
      if (!(tool === 2 && viewWeapon.aimDownState > .6)) H.drawSight(ctx, W, Ht);
      H.drawHitFeedback(ctx, W, Ht, hitFeedback, hitFriendly);
      const i = net.info;
      if (mode === 'online' && i[4] === 0 && i[8 + state[30]] && i[10 + state[30]] === state[29]) H.drawIntelCarried(ctx, W, Ht, t);
      if (mode === 'online' && i[4] === 1) drawTerritoryProgress(ctx, W, Ht);
      if (touchEnabled) {
        const stock = tool === 2 ? `${state[7]} / ${state[8]}${state[12] ? ' · Reloading' : ''}` : tool === 1 ? `${state[9]} blocks` : tool === 3 ? `${state[10]} grenades` : 'Spade';
        const hp = `HP ${state[6]}`, line = `${hp}    ${stock}`, f = H.fonts.heading;
        const x = (W - H.measure(ctx, line, f)) / 2, y = Ht - safeArea.bottom - (Ht < 420 ? 82 : 92);
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x - 12, y - 4, H.measure(ctx, line, f) + 24, 32);
        H.drawText(ctx, hp, x, y, state[6] <= 25 ? [1, .45, .4] : [1, 1, 1], 1, f, .6);
        H.drawText(ctx, stock, x + H.measure(ctx, hp + '    ', f), y, tool === 2 && state[7] === 0 ? [1, .8, .4] : [1, 1, 1], 1, f, .6);
        if (tool === 1) H.drawPalette(ctx, W / 2 + 60, y + 58, H.paletteIndex(state[31])); // 8×8 swatches centred above the readout
      } else {
        H.drawAliveHud(ctx, W, Ht, {tool, weapon: state[21], ammo: state[7], clipSize: CLIP[state[21]], stock: state[8], maxStock: MAX_STOCK[state[21]], blocks: state[9], grenades: state[10], reloading: !!state[12], hp: state[6]});
        if (tool === 1) H.drawPalette(ctx, W, Ht, H.paletteIndex(state[31]));
      }
      H.drawMap(ctx, W, Ht, {...mapData(), size: touchEnabled ? (Ht < 380 ? 88 : 112) : 128});
    } else {
      if (joined) H.drawRespawn(ctx, W, Ht, state[18]);
      H.drawSpectateHelp(ctx, W, joined ? [] : ['[Space/Ctrl] Go up/down']);
      H.drawMap(ctx, W, Ht, {...mapData(), size: touchEnabled ? (Ht < 380 ? 88 : 112) : 128});
    }
    alert.draw(ctx, W, Ht, t); chat.draw(ctx, W, Ht); killfeed.draw(ctx, W, Ht);
    if (mapZoom > 0) H.drawMap(ctx, W, Ht, {...mapData(), large: true, zoom: mapZoom});
  } else alert.draw(ctx, W, Ht, t);
  centerMessages.draw(ctx, W);
  if (scoresHeld || heldKey('Tab') || (!hasPlayer && mode === 'online')) {
    const scale = touchEnabled ? Math.min(1, W / 820, Ht / 600) : 1;
    ctx.save(); ctx.scale(scale, scale); H.drawScoreboard(ctx, W / scale, scoreboardData()); ctx.restore();
  }
  if (limboOpen && !touchEnabled) limbo.draw(ctx, W, Ht, [teamName(0), teamName(1)]);
}
let territoryFade = {id: -1, time: -10};
function drawTerritoryProgress(ctx, W, Ht) {
  const n = net.info[24], d = territories(n);
  let best = -1, dist = 0;
  for (let k = 0; k < n; k++) { const dx = d[k * 6] - state[0], dy = d[k * 6 + 1] - state[1], dz = d[k * 6 + 2] - state[2]; if (Math.abs(dx) < 18 && Math.abs(dy) < 18 && Math.abs(dz) < 18) { const l = dx * dx + dy * dy + dz * dz; if (best < 0 || l < dist) { best = k; dist = l; } } }
  let fade = 1; const t = now();
  if (best >= 0) territoryFade = {id: best, time: t}; else if (territoryFade.id >= 0 && t < territoryFade.time + 2 && territoryFade.id < n) { best = territoryFade.id; fade = 1 - (t - territoryFade.time) / 2; }
  if (best < 0) return;
  const owner = d[best * 6 + 3], capturing = d[best * 6 + 4], progress = d[best * 6 + 5];
  const bg = owner < 2 ? teamColor(owner) : WHITE;
  const bar = capturing >= 0 && capturing < 2 ? {color: teamColor(capturing), value: owner === 2 ? progress : 1 - progress} : null;
  H.drawTcProgress(ctx, W, Ht, bg, bar ? {color: bar.color, value: Math.max(0, Math.min(1, capturing === 1 ? progress : 1 - progress))} : null, fade, '');
}

// ---- Main loop ----
function frame(time) {
  requestAnimationFrame(frame); const dt = Math.max(0, Math.min((time - last) / 1000, .1)); last = Math.max(last, time); lastFrameAt = performance.now();
  syncTouch();
  if (!ready) return;
  let drawView = false;
  if (mode === 'title') { titleCamera(dt); updateChunks(6, 180); }
  else if (mode === 'online') {
    pollNet();
    if (mode === 'online' && net.status === STATUS.game) {
      accumulator += dt; let stepped = false;
      while (accumulator >= 1 / 60) {
        input(); engine._os_net_step(1 / 60); accumulator -= 1 / 60; stepped = true;
        const s = readState(); if (s[28] && s[17] && s[30] < 2 && playing) { yaw = Math.atan2(s[4], s[3]); pitch = Math.asin(Math.max(-1, Math.min(1, s[5]))); }
      }
      if (stepped) engine._os_net_poll();
      processEvents(); updateVisuals(dt); drawView = true;
    }
  } else {
    if (playing) { accumulator += dt; while (accumulator >= 1 / 60) { input(); engine._os_step(1 / 60); accumulator -= 1 / 60; const s = readState(); yaw = Math.atan2(s[4], s[3]); pitch = Math.asin(Math.max(-1, Math.min(1, s[5]))); } }
    processEvents(); updateVisuals(playing ? dt : 0); drawView = true;
  }
  if (mode === 'online' && net.status !== STATUS.game) { renderer.setClearColor(0x000000); renderer.clear(); }
  else { renderer.autoClear = true; renderer.render(scene, camera); }
  if (drawView && firstPerson() && viewWeapon.render()) { renderer.autoClear = false; renderer.clearDepth(); renderer.render(viewScene, viewCamera); renderer.autoClear = true; }
  drawHud(dt); frameCount++;
}
async function boot() {
  try {
    $('boot-status').textContent = 'Loading OpenSpades...';
    const flags = fetch('assets/Gfx/UI/Flags.json').then(r => r.json()).then(f => { flagTable = f; }).catch(() => {});
    engine = await createOpenSpades();
    await Promise.all([prepareModels(), H.loadHud(), fetchTitleMap(), flags]);
    enterTitle(); ready = true;
    $('boot-status').textContent = ''; $('connect').disabled = false; $('practice').disabled = false; if (selectedServer) selectServer(selectedServer);
    showScreen(screen);
    loadServers();
  } catch (error) { console.error(error); $('boot-status').textContent = 'Could not start: ' + error.message; }
}
// ---- Android system integration: back button and app lifecycle ----
/** Handles the system Back gesture. Returns false when there is nothing left to close (the app then exits). */
function handleBack() {
  if (chatOpen) { closeChat(); return true; }
  if (overlay === 'setup') { closeSettings(); return true; }
  if (overlay === 'chatlog') { setOverlay(mode === 'title' ? null : 'menu'); return true; }
  if (overlay === 'credits' && !$('credits-doc').hidden) { closeCreditsDoc(); return true; }
  if (overlay === 'credits' || overlay === 'message') { setOverlay(null); return true; }
  if (overlay === 'name') { pendingServer = null; setOverlay(null); return true; }
  if (overlay === 'menu') { resume(); return true; }
  if (mode === 'title') { if (screen !== 'home') { showScreen('home'); return true; } return false; }
  if (limboOpen) { if (mode === 'offline' || (state[28] && net.joined)) { closeLimbo(); lock(); } else openGameMenu(); return true; }
  openGameMenu(); return true;
}
Native.onNative('back', () => { if (!handleBack()) Native.exitApp(); });
Native.onNative('lifecycle', m => {
  if (m.state === 'pause') {
    if (playing && mode !== 'title' && !overlay && !limboOpen) openGameMenu();
    if (chatOpen) closeChat();
    touch.reset(); audio.context?.suspend?.().catch(() => {});
  } else audio.context?.resume?.().catch(() => {});
});
addEventListener('keydown', e => { if (e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); handleBack(); } });
window.openspadesMobile = {back: handleBack, showScreen};
// Read-only handle for debugging in the browser console.
window.openspades = {camera, scene, chunkMeshes, get mode() { return mode; }, get state() { return state; }, get net() { return net; }, get frames() { return frameCount; }, get ready() { return ready; }, frame};
requestAnimationFrame(frame); boot();
