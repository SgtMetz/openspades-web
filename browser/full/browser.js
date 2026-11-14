// Platform services for the original desktop client (pre-js). No gameplay or UI is implemented
// here: everything visible is drawn by the original renderers and AngelScript UI.
if (typeof window !== 'undefined') {
  const canvas = document.getElementById('canvas');           // input + WebGL (transferred)
  const view = document.getElementById('native-view');         // displays frames
  const view2d = view.getContext('2d', {alpha: false});
  const status = document.getElementById('native-status');
  Module['canvas'] = canvas;
  Module['setStatus'] = text => { status.textContent = text; status.hidden = !text; };
  Module['printErr'] = text => { console.error(text); };
  Module['onAbort'] = reason => { status.hidden = false; status.textContent = 'OpenSpades stopped: ' + reason; };
  Module['onExit'] = code => { status.hidden = false; status.textContent = code ? 'OpenSpades exited with an error. Reload the page to start again.' : 'OpenSpades has quit. Reload the page to start again.'; };

  // Desktop command-line arguments: an aos:// address and protocol version, from the URL,
  // e.g. ?aos://1234567890:32887&v=76 or #aos://1234567890:32887
  const args = [];
  const query = decodeURIComponent(location.search.slice(1) + '&' + location.hash.slice(1));
  for (const part of query.split('&')) {
    if (/^aos:\/\/[^\s'"]+$/.test(part)) args.push(part);
    else if (/^(v=)?0?\.?7[56]$/.test(part)) args.push(part);
    else if (part === 'verify-gl') args.push('--verify-gl'); // automated headless check only
  }
  Module['arguments'] = args;

  // ---- Presentation -------------------------------------------------------------------
  // Letterbox both canvases to the client's window size, like a desktop window scaled to fit.
  let frameW = canvas.width, frameH = canvas.height;
  // WebGL frames go to their own canvas through an ImageBitmapRenderingContext: the bitmap is
  // handed over without a copy, unlike drawImage into the 2D canvas (which the software renderer
  // keeps using). Much cheaper per frame, especially in Firefox.
  const glView = document.createElement('canvas');
  glView.id = 'native-gl-view'; glView.setAttribute('aria-hidden', 'true'); glView.hidden = true;
  view.after(glView);
  // ?present=2d restores the old drawImage path (A/B testing).
  const glCtx = /(^|[?&])present=2d(&|$)/.test(location.search) ? null : glView.getContext('bitmaprenderer');
  console.log('[present] ' + (glCtx ? 'bitmaprenderer' : '2d drawImage'));
  const showGL = on => { glView.hidden = !on; view.hidden = on; };
  function layout() {
    const scale = Math.min(innerWidth / frameW, innerHeight / frameH);
    const w = Math.floor(frameW * scale), h = Math.floor(frameH * scale);
    for (const c of [canvas, view, glView]) {
      c.style.width = w + 'px'; c.style.height = h + 'px';
      c.style.left = Math.floor((innerWidth - w) / 2) + 'px'; c.style.top = Math.floor((innerHeight - h) / 2) + 'px';
    }
  }
  function resizeView(w, h) {
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
    if (frameW !== w || frameH !== h) { frameW = w; frameH = h; layout(); }
    status.hidden = true;
  }
  addEventListener('resize', layout); layout();

  // Software renderer (SDL window surface): SDL's Emscripten port draws ImageData into
  // Module.SDL2.ctx on the main thread; point it at the display canvas.
  Module['SDL2'] = {
    ctxCanvas: canvas,
    ctx: {
      createImageData: (w, h) => view2d.createImageData(w, h),
      putImageData: (image, x, y) => { showGL(false); resizeView(image.width, image.height); view2d.putImageData(image, x, y); Module['osPresentedFrames'] = (Module['osPresentedFrames'] || 0) + 1; },
    },
  };

  // OpenGL renderer: the client thread posts each finished WebGL frame as an ImageBitmap
  // (WebGLCompat.cpp: osweb_present). Show the newest one per display refresh.
  let pending = [], drawing = false;
  function present() {
    drawing = false;
    if (!pending.length) return;
    const frames = pending; pending = [];
    const latest = frames[frames.length - 1];
    const w = latest.bitmap.width, h = latest.bitmap.height;
    if (glCtx) {
      if (glView.width !== w || glView.height !== h) { glView.width = w; glView.height = h; }
      if (frameW !== w || frameH !== h) { frameW = w; frameH = h; layout(); }
      status.hidden = true;
      glCtx.transferFromImageBitmap(latest.bitmap); // consumes the bitmap
      showGL(true);
    } else {
      resizeView(w, h);
      view2d.drawImage(latest.bitmap, 0, 0);
      view.hidden = false;
    }
    Module['osPresentedFrames'] = (Module['osPresentedFrames'] || 0) + 1;
    const heap = new Int32Array(wasmMemory.buffer);
    for (const f of frames) { if (f !== latest || !glCtx) f.bitmap.close(); Atomics.sub(heap, f.counter >> 2, 1); }
  }
  function onWorkerMessage(e) {
    const d = e.data;
    if (d && d.osHideView) { view.hidden = true; glView.hidden = true; return; }
    if (d && typeof d.osAlert === 'string') {
      // SDL_ShowSimpleMessageBox (for example the desktop's fatal error box) from the client thread
      const p = document.createElement('pre'); p.textContent = d.osAlert; p.style.whiteSpace = 'pre-wrap';
      dialog('OpenSpades', p); return;
    }
    if (d && d.osFrame) {
      pending.push({bitmap: d.osFrame, counter: d.osCounter});
      if (!drawing) { drawing = true; requestAnimationFrame(present); }
    }
  }
  const watched = new WeakSet();
  const watch = worker => { if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener('message', onWorkerMessage); } };

  // ---- Audio --------------------------------------------------------------------------
  // BrowserAudio.cpp sends sound bytes read through the original FileManager (paks, .weak
  // fallbacks, user overrides) and plays them here like Audio/ALDevice.cpp does with OpenAL.
  const buffers = new Map();                     // chunk id -> Promise<AudioBuffer>
  let context, voices = 0, reverbBus, reverbOut, reverbState;
  let listener = {p: [0, 0, 0], f: [0, 1, 0], u: [0, 0, -1]};
  const audio = () => {
    if (!context) {
      context = new AudioContext();
      // Reverb send (desktop: EFX EAX reverb slot), wet gain driven by the reverb parameters.
      reverbBus = context.createConvolver(); reverbBus.normalize = false;
      reverbOut = context.createGain(); reverbOut.gain.value = 0;
      reverbBus.connect(reverbOut).connect(context.destination);
    }
    return context;
  };
  const unlock = () => { audio().resume().catch(console.warn); };
  addEventListener('pointerdown', unlock, {capture: true});
  addEventListener('keydown', unlock, {capture: true});
  const setVector = (node, prefix, v) => { if (node[prefix + 'X']) for (let i = 0; i < 3; i++) node[prefix + 'XYZ'[i]].value = v[i]; };
  function impulse(decay, reflGain, lateGain, reflDelay, lateDelay) {
    const rate = context.sampleRate, length = Math.ceil(Math.min(reflDelay + lateDelay + decay, 4) * rate);
    const ir = context.createBuffer(2, Math.max(length, 1), rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      const early = Math.floor(reflDelay * rate), late = Math.floor((reflDelay + lateDelay) * rate);
      for (let i = early; i < Math.min(early + Math.floor(.02 * rate), length); i++) d[i] += (Math.random() * 2 - 1) * reflGain;
      for (let i = late; i < length; i++) d[i] += (Math.random() * 2 - 1) * lateGain * Math.exp(-6.91 * (i - late) / (decay * rate));
    }
    return ir;
  }
  Module['fullAudio'] = {
    reset() { voices = 0; },
    clear() { buffers.clear(); },
    stats: {decoded: 0, failed: 0},
    load(id, name, bytes) {
      const promise = audio().decodeAudioData(bytes.buffer);
      buffers.set(id, promise);
      promise.then(() => this.stats.decoded++, e => { this.stats.failed++; console.warn(`OpenSpades audio: cannot decode ${name}:`, e?.message ?? e); });
    },
    listener(p, f, u) {
      listener = {p, f, u};
      if (!context) return;
      const l = context.listener;
      if (l.positionX) { setVector(l, 'position', p); setVector(l, 'forward', f); setVector(l, 'up', u); }
      else { l.setPosition(...p); l.setOrientation(...f, ...u); }
    },
    reverb(decay, gain, reflGain, lateGain, reflDelay, lateDelay) {
      if (!context) return;
      const s = reverbState, now = context.currentTime;
      reverbOut.gain.setTargetAtTime(gain, now, .1);
      // Rebuild the impulse response only when the room changes noticeably (at most twice a second).
      if (!s || (now - s.time > .5 && (Math.abs(decay - s.decay) > .1 * s.decay || Math.abs(lateGain - s.lateGain) > .02 || Math.abs(reflGain - s.reflGain) > .02))) {
        reverbState = {decay, reflGain, lateGain, time: now};
        reverbBus.buffer = impulse(decay, reflGain, lateGain, reflDelay, lateDelay);
      }
    },
    async play(id, volume, pitch, reference, position, mode, obstructed, reverb, maxVoices) {
      if (!context || context.state !== 'running' || voices >= maxVoices || !buffers.has(id)) return;
      voices++;
      const nodes = [];
      let started = false;
      const release = () => { voices--; for (const n of nodes) n.disconnect(); };
      try {
        const buffer = await buffers.get(id);
        if (context.state !== 'running') return;
        const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = pitch;
        const gain = context.createGain(); gain.gain.value = volume;
        nodes.push(source, gain);
        let tail = source;
        if (obstructed) {
          // Desktop obstruction filter: AL low-pass, GAINHF 0.1.
          const lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 1500;
          nodes.push(lowpass); tail.connect(lowpass); tail = lowpass;
        }
        tail.connect(gain);
        if (mode !== 2) {
          // 0: world position; 1: relative to the listener (AL_SOURCE_RELATIVE, no rolloff).
          let p = position;
          if (mode === 1) {
            const {p: e, f, u} = listener, r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
            p = [0, 1, 2].map(i => e[i] + position[0] * r[i] + position[1] * u[i] - position[2] * f[i]);
          }
          const panner = context.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
          panner.refDistance = Math.max(.01, reference); panner.rolloffFactor = mode === 1 ? 0 : 1; panner.maxDistance = 1e4;
          if (panner.positionX) setVector(panner, 'position', p); else panner.setPosition(...p);
          nodes.push(panner); gain.connect(panner).connect(context.destination);
          if (reverb) panner.connect(reverbBus);
        } else gain.connect(context.destination);
        source.onended = release; source.start(); started = true;
      } catch (error) { console.warn('OpenSpades audio:', error?.message ?? error); }
      finally { if (!started) release(); }
    }
  };

  // ---- Input defaults -----------------------------------------------------------------
  // Input reaches the client thread asynchronously, so its handlers cannot cancel browser
  // shortcuts. Cancel the ones that would leave or disturb the game; keep text input
  // (keypress) and clipboard shortcuts working.
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());
  const textField = document.getElementById('touch-text');
  addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || e.target === textField) return;
    const fn = /^F([1-9]|10)$/.test(e.key);
    if (e.key === 'Tab' || fn || e.key.startsWith('Arrow') || e.key === 'Backspace' ||
        e.altKey || (e.ctrlKey && !/^[cvx]$/i.test(e.key))) e.preventDefault();
  }, {capture: true});
  addEventListener('keypress', e => { if (!document.querySelector('dialog[open]') && e.target !== textField) e.preventDefault(); }, {capture: true});

  // ---- Desktop or touch device --------------------------------------------------------
  // Desktop input is unchanged. Phones and tablets get on-screen controls while the game takes
  // relative mouse input (playing); menus are used by tapping the game directly (SDL turns taps
  // into mouse clicks). The controls send the key names, text and mouse motion that desktop
  // input produces (SDLRunner patch, osweb_touch_poll), so key bindings and sensitivity apply.
  // ?touch=1 or ?touch=0 overrides detection; the existing port's saved choice is honoured.
  function detectTouch() {
    const override = new URLSearchParams(location.search).get('touch');
    if (override === '1' || override === '0') return override === '1';
    let saved = 'auto'; try { saved = localStorage.getItem('openspades-touch-mode') || 'auto'; } catch {}
    if (saved === 'on' || saved === 'off') return saved === 'on';
    return !!navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
      (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches);
  }
  const touch = {enabled: detectTouch(), active: false, queue: [], held: new Map(), pointers: new Map(), dx: 0, dy: 0};
  Module['osTouchEnabled'] = touch.enabled;
  Module['osTouch'] = touch;
  document.documentElement.classList.toggle('touch', touch.enabled);
  const pad = document.getElementById('touch-controls'), stick = document.getElementById('touch-stick');
  const knob = document.getElementById('touch-knob'), textBar = document.getElementById('touch-text-bar');
  const press = name => { const n = (touch.held.get(name) || 0) + 1; touch.held.set(name, n); if (n === 1) touch.queue.push('+' + name); };
  const release = name => {
    const n = (touch.held.get(name) || 0) - 1;
    if (n > 0) touch.held.set(name, n); else if (touch.held.delete(name)) touch.queue.push('-' + name);
  };
  const tap = name => { if (!touch.held.has(name)) touch.queue.push('+' + name, '-' + name); };
  const keyName = el => el.dataset.key === 'Space' ? ' ' : el.dataset.key;
  function releaseAll() {
    for (const [id, p] of touch.pointers) { try { p.el.releasePointerCapture(id); } catch {} p.el.classList.remove('held'); }
    touch.pointers.clear();
    for (const name of touch.held.keys()) touch.queue.push('-' + name);
    touch.held.clear(); knob.style.transform = '';
  }
  function stickKeys(p, x, y) {
    const r = stick.getBoundingClientRect(), radius = r.width * .34;
    const dx = x - r.left - r.width / 2, dy = y - r.top - r.height / 2;
    const scale = Math.min(1, radius / (Math.hypot(dx, dy) || 1));
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    const keys = new Set();
    if (dy * scale < -.25 * radius) keys.add('W'); if (dy * scale > .25 * radius) keys.add('S');
    if (dx * scale < -.25 * radius) keys.add('A'); if (dx * scale > .25 * radius) keys.add('D');
    for (const k of p.keys) if (!keys.has(k)) release(k);
    for (const k of keys) if (!p.keys.has(k)) press(k);
    p.keys = keys;
  }
  pad.addEventListener('pointerdown', e => {
    if (!touch.active || e.button > 0) return;
    e.preventDefault();
    const button = e.target.closest('button'), onStick = e.target.closest('#touch-stick');
    const kind = button ? 'button' : onStick ? 'stick' : 'look';
    if (kind !== 'button' && [...touch.pointers.values()].some(p => p.kind === kind)) return;
    const p = {kind, el: button || (onStick ? stick : pad), x: e.clientX, y: e.clientY, keys: new Set()};
    touch.pointers.set(e.pointerId, p);
    try { p.el.setPointerCapture(e.pointerId); } catch {}
    if (button) {
      button.classList.add('held');
      if (button.dataset.tap) tap(button.dataset.tap); else press(keyName(button));
    } else if (onStick) stickKeys(p, e.clientX, e.clientY);
  });
  pad.addEventListener('pointermove', e => {
    const p = touch.pointers.get(e.pointerId); if (!p) return;
    e.preventDefault();
    if (p.kind === 'look') {
      // Like SDL's pointer-lock motion: CSS pixels scaled to the game window's pixels.
      const scale = frameW / (canvas.getBoundingClientRect().width || frameW);
      touch.dx += (e.clientX - p.x) * scale; touch.dy += (e.clientY - p.y) * scale;
    } else if (p.kind === 'stick') stickKeys(p, e.clientX, e.clientY);
    p.x = e.clientX; p.y = e.clientY;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(type, e => {
    const p = touch.pointers.get(e.pointerId); if (!p) return;
    touch.pointers.delete(e.pointerId);
    if (p.kind === 'button') {
      if (![...touch.pointers.values()].some(o => o.el === p.el)) p.el.classList.remove('held');
      if (!p.el.dataset.tap) release(keyName(p.el));
    } else if (p.kind === 'stick') { for (const k of p.keys) release(k); knob.style.transform = ''; }
  });
  pad.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  if (touch.enabled) {
    // Taps on the game (menus): SDL handles the touch events; stop the browser from also
    // sending emulated mouse events, scrolling or zooming.
    canvas.style.touchAction = 'none';
    for (const type of ['touchstart', 'touchmove', 'touchend']) canvas.addEventListener(type, e => e.preventDefault(), {passive: false});
  }
  // Text entry (chat, player name, server address): the soft keyboard needs a real text field.
  // It keeps one placeholder character so a backspace on an otherwise empty field is still seen.
  const placeholder = '​';
  textField.value = placeholder;
  document.getElementById('touch-keyboard').addEventListener('click', () => { textField.value = placeholder; textField.focus(); });
  document.getElementById('touch-escape').addEventListener('click', () => tap('Escape'));
  const takeText = () => {
    const value = textField.value;
    if (!value.startsWith(placeholder)) tap('BackSpace');
    const text = value.replaceAll(placeholder, '').replace(/\n/g, '');
    if (text) touch.queue.push('t' + text);
    textField.value = placeholder;
  };
  textField.addEventListener('input', e => { if (!e.isComposing) takeText(); });
  textField.addEventListener('compositionend', takeText);
  textField.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tap('Enter'); }
    else if (e.key === 'Escape') { e.preventDefault(); tap('Escape'); textField.blur(); }
    else if (e.key === 'Tab') { e.preventDefault(); tap('Tab'); }
    e.stopPropagation(); // the game receives this field's input above, not as window key events
  });
  for (const type of ['keyup', 'keypress']) textField.addEventListener(type, e => e.stopPropagation());
  // Called by the client loop every frame on touch devices.
  Module['osTouchPoll'] = (relative, textInput) => {
    const active = !!relative && !document.querySelector('dialog[open]');
    if (active !== touch.active) {
      touch.active = active; pad.hidden = !active;
      document.documentElement.classList.toggle('touch-playing', active);
      if (!active) releaseAll();
    }
    if (textBar.hidden === !!textInput) textBar.hidden = !textInput;
    if (!textInput && document.activeElement === textField) textField.blur();
    if (touch.dx || touch.dy) {
      if (active) touch.queue.push('m' + touch.dx.toFixed(2) + ' ' + touch.dy.toFixed(2));
      touch.dx = touch.dy = 0;
    }
    if (!touch.queue.length) return '';
    const out = touch.queue.join('\n'); touch.queue = []; return out;
  };

  // ---- Clipboard (BrowserPlatform.cpp) ------------------------------------------------
  Module['osClipboard'] = '';
  addEventListener('paste', e => { Module['osClipboard'] = e.clipboardData?.getData('text/plain') ?? ''; });
  addEventListener('copy', e => { if (Module['osClipboard']) { e.clipboardData.setData('text/plain', Module['osClipboard']); e.preventDefault(); } });

  // ---- Shell services: open URL / show user directory ---------------------------------
  function dialog(title, body) {
    const d = document.createElement('dialog');
    const h = document.createElement('h2'); h.textContent = title;
    const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => d.close();
    d.append(h, body, close); d.onclose = () => d.remove(); document.body.append(d); d.showModal();
  }
  Module['osOpenURL'] = url => {
    const p = document.createElement('p'); const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url; a.style.color = '#9cf';
    p.append('OpenSpades wants to open: ', a); dialog('Open link', p);
  };

  // ---- ENet datagrams over the WebSocket relay (enet_full.c) ---------------------------
  // Owned by the main thread: the client pthread never returns to its event loop, so its own
  // WebSockets would never deliver events. One relay connection per ENet socket id.
  // Received datagrams go straight into the socket's ring in shared wasm memory, which ENet on
  // the client pthread reads without waiting for this thread (layout in enet_full.c).
  const nets = Module['osFullNet'] = {};
  const rings = {};
  Module['osNetOpen'] = (id, ptr, slots, mtu) => { rings[id] = {ptr, slots, mtu, stride: 4 + mtu}; };
  const heap = () => {
    if (HEAPU8.buffer !== wasmMemory.buffer) updateMemoryViews(); // after memory growth
    return [HEAPU8, HEAPU32];
  };
  function deliver(id, data) {
    const ring = rings[id];
    if (!ring) return;
    const [u8, u32] = heap(), h = ring.ptr >> 2;
    const head = Atomics.load(u32, h), tail = Atomics.load(u32, h + 1);
    if (data.length > ring.mtu || ((head - tail) >>> 0) >= ring.slots) { u32[h + 2]++; return; } // full: dropped, like UDP
    const slot = ring.ptr + 12 + (head % ring.slots) * ring.stride;
    u32[slot >> 2] = data.length;
    u8.set(data, slot + 4);
    Atomics.store(u32, h, (head + 1) >>> 0);
  }
  Module['osNetSend'] = (id, host, port, bytes) => {
    const key = host + ':' + port;
    let net = nets[id];
    if (!net || net.key !== key) {
      closeNet(id);
      net = nets[id] = {key, pending: [], closed: false};
      const origin = location.origin.replace(/^http/, 'ws');
      const ws = net.ws = new WebSocket((Module['relayUrl'] || self.osRelayUrl || origin) + '/relay?host=' + encodeURIComponent(host) + '&port=' + port);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { for (const d of net.pending.splice(0)) ws.send(d); };
      ws.onmessage = e => { if (!net.closed && nets[id] === net) deliver(id, new Uint8Array(e.data)); };
      const fail = why => {
        if (net.closed) return;
        net.closed = true; net.pending.length = 0;
        console.warn('[net] relay to ' + key + ' ' + why);
      };
      ws.onerror = () => fail('failed');
      ws.onclose = e => fail('closed (' + e.code + (e.reason ? ' ' + e.reason : '') + ')');
    }
    // Datagram semantics: buffered while connecting, dropped after a failure; ENet's own
    // retransmission and timeouts decide the outcome as with an unreachable UDP server.
    if (net.closed) return;
    if (net.ws.readyState === 1) net.ws.send(bytes);
    else if (net.pending.length < 256) net.pending.push(bytes);
  };
  function closeNet(id) {
    const net = nets[id];
    if (!net) return;
    delete nets[id];
    net.closed = true;
    try { net.ws.close(); } catch (e) {}
  }
  Module['osNetClose'] = id => { closeNet(id); delete rings[id]; };

  // ---- Graphics quality (replaces the desktop startup window) --------------------------
  // The game starts at the main menu. Before it starts, a short GPU test picks one of the original
  // launcher's quality presets (StartupScreen/ConfigViewTabs.as). The result is remembered per GPU,
  // so presets are written once and later changes (console) are kept until the GPU changes.
  // The Graphics menu on the page (top right) picks Auto (the tested tier) or a fixed preset; the
  // tested tier is labelled "(recommended)". ?quality=low|medium|high|ultra forces a preset for one
  // visit, ?quality=auto re-tests, ?launcher shows the original startup window instead. The window
  // size follows the page on every start.
  const post = (blur, lens, bloom, flare, flareDyn, color, dof, ssao) =>
    ({r_cameraBlur: blur, r_lens: lens, r_bloom: bloom, r_lensFlare: flare, r_lensFlareDynamic: flareDyn, r_colorCorrection: color, r_depthOfField: dof, r_ssao: ssao});
  const lights = (dl, shadows, physical) => ({r_dlights: dl, r_modelShadows: shadows, r_physicalLighting: physical});
  const presets = {
    low: {r_fxaa: 0, r_radiosity: 0, r_hdr: 0, ...post(0, 0, 0, 0, 0, 0, 0, 0), r_softParticles: 0, r_fogShadow: 0, ...lights(1, 0, 0), r_water: 0, r_shadowMapSize: 512, r_maxAnisotropy: 2},
    medium: {r_fxaa: 1, r_radiosity: 0, r_hdr: 0, ...post(1, 0, 0, 1, 0, 1, 0, 0), r_softParticles: 1, r_fogShadow: 0, ...lights(1, 1, 0), r_water: 1, r_shadowMapSize: 1024, r_maxAnisotropy: 4},
    high: {r_fxaa: 1, r_radiosity: 0, r_hdr: 0, ...post(1, 1, 1, 1, 1, 1, 1, 0), r_softParticles: 1, r_fogShadow: 0, ...lights(1, 1, 1), r_water: 2, r_shadowMapSize: 2048, r_maxAnisotropy: 8},
    ultra: {r_fxaa: 1, r_radiosity: 1, r_hdr: 1, ...post(1, 1, 1, 1, 1, 1, 1, 1), r_softParticles: 2, r_fogShadow: 1, ...lights(1, 1, 1), r_water: 3, r_shadowMapSize: 2048, r_maxAnisotropy: 16},
  };
  // Rendering resolution per preset: device pixels up to this pixel ratio and pixel count.
  const resolution = {low: [1, 1280 * 720], medium: [1, 1920 * 1080], high: [1.5, 2560 * 1440], ultra: [2, 3840 * 2160]};
  const tiers = ['low', 'medium', 'high', 'ultra'];
  // Fill-rate test: a fixed ALU-heavy fragment shader drawn for ~250 ms, synchronised by 1-pixel
  // reads. Score = billions of shader iterations per second (an AMD RX 6700 scores ~185).
  function benchmarkGPU(measure = true) {
    const size = 512, iterations = 96;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const gl = c.getContext('webgl2', {antialias: false, depth: false, stencil: false, powerPreference: 'high-performance'});
    if (!gl) return {renderer: '', score: 0, webgl2: false};
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; uniform float seed; out vec4 o;
void main(){ vec2 uv=gl_FragCoord.xy*0.003+seed; vec3 v=vec3(uv,seed);
  for(int i=0;i<${iterations};i++){ v=fract(v.yzx*vec3(1.37,1.71,1.13)+vec3(dot(v,v.zxy),uv)); v+=sin(v*6.2831)*0.1; }
  o=vec4(v,1.0); }`));
    gl.linkProgram(program);
    let score = 0;
    if (measure && gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.useProgram(program); gl.viewport(0, 0, size, size);
      const seed = gl.getUniformLocation(program, 'seed'), pixel = new Uint8Array(4);
      const draw = () => { gl.uniform1f(seed, Math.random()); gl.drawArrays(gl.TRIANGLES, 0, 3); };
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      draw(); sync(); // compile and warm up
      let draws = 0, batch = 1; const start = performance.now(); let now = start;
      while (now - start < 250 && draws < 4000) {
        for (let i = 0; i < batch; i++) draw();
        sync(); draws += batch; now = performance.now();
        if (now - start < 20) batch = Math.min(batch * 2, 64);
      }
      score = size * size * iterations * draws / ((now - start) / 1000) / 1e9;
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return {renderer, score, webgl2: true};
  }
  function chooseTier({renderer, score}) {
    // Software rasterisers (no GPU) and very weak GPUs get Low regardless of the score.
    if (/SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(renderer)) return 'low';
    // An RX 6700 (score ~180) ran a real match on Ultra at only ~42 fps (Chrome) / ~29 (Firefox),
    // so Ultra needs a clearly faster GPU.
    let tier = score >= 350 ? 'ultra' : score >= 25 ? 'high' : score >= 6 ? 'medium' : 'low';
    // Phones and tablets: battery and heat; low-memory devices: smaller render targets.
    const cap = touch.enabled || navigator.deviceMemory <= 4 ? 'medium' : 'ultra';
    if (navigator.deviceMemory && navigator.deviceMemory <= 2) tier = 'low';
    return tiers[Math.min(tiers.indexOf(tier), tiers.indexOf(cap))];
  }
  function videoSize(tier) {
    const [ratioCap, pixelCap] = resolution[tier];
    // A page loaded in a hidden or zero-size frame reports 0x0; use the desktop default then.
    let w = innerWidth || 1024, h = innerHeight || 640;
    if (touch.enabled && h > w) [w, h] = [h, w]; // phones play sideways
    const ratio = Math.min(devicePixelRatio || 1, ratioCap);
    w *= ratio; h *= ratio;
    // Keep the page's shape: shrink to the preset's pixel budget, or grow evenly to a usable minimum
    // (the original UI needs about 640x360 in landscape).
    const minimum = w >= h ? Math.max(640 / w, 360 / h) : Math.max(360 / w, 640 / h);
    const fit = Math.max(Math.min(1, Math.sqrt(pixelCap / (w * h))), minimum);
    return [Math.round(w * fit), Math.round(h * fit)];
  }
  Module['preRun'] ||= [];
  const QUALITY_KEY = 'openspades-full-quality', CHOICE_KEY = 'openspades-full-quality-choice', QUALITY_VERSION = 2;
  const tierName = t => t[0].toUpperCase() + t.slice(1);
  const loadJSON = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const savedChoice = () => { const c = localStorage.getItem(CHOICE_KEY); return tiers.includes(c) ? c : 'auto'; };
  // Graphics menu: changing it restarts the client (presets apply at startup, as with the desktop launcher).
  const picker = document.getElementById('native-quality');
  function fillPicker(recommended, current) {
    if (!picker) return;
    const choice = savedChoice();
    picker.replaceChildren(...['auto', ...tiers].map(t => {
      const label = t === 'auto' ? `Auto${recommended ? ' (' + tierName(recommended) + ')' : ''}` : tierName(t) + (t === recommended ? ' (recommended)' : '');
      return new Option(label, t, false, t === choice);
    }));
    picker.title = `Graphics quality. Running: ${tierName(current || recommended || 'auto')}. Changing it restarts the game.`;
  }
  const SKIP_MENU_KEY = 'openspades-full-skip-quality-menu';
  if (picker) {
    fillPicker(loadJSON(QUALITY_KEY)?.recommended, null);
    picker.addEventListener('change', () => {
      const v = picker.value;
      if (!confirm(`Switch graphics to ${tierName(v)}? The game restarts (you will be disconnected from any server).`)) { picker.value = savedChoice(); return; }
      try { localStorage.setItem(CHOICE_KEY, v); sessionStorage.setItem(SKIP_MENU_KEY, '1'); } catch {}
      const url = new URL(location.href); url.searchParams.delete('quality');
      location.replace(url.href);
    });
  }
  // Startup menu: after the device test and before the client starts, the player picks the quality
  // (pre-selected: the saved choice, else Auto). Not shown for ?quality=, ?launcher, automated
  // browsers (navigator.webdriver), or right after a restart from the Graphics menu above.
  function askQuality(recommended) {
    return new Promise(resolve => {
      const panel = document.createElement('div');
      panel.id = 'native-start';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Graphics quality');
      const choice = savedChoice();
      const describe = {auto: 'Uses the tier the device test picked.', low: 'Fastest. No effects, smaller shadows and resolution.',
        medium: 'Basic effects and water.', high: 'Most effects, sharper resolution.', ultra: 'Every effect, full resolution. Needs a fast GPU.'};
      panel.innerHTML = '<h2>Graphics quality</h2><div class="native-start-options"></div>' +
        '<p class="native-start-note">To change this later, reload the page.</p><button type="button">Start</button>';
      const list = panel.querySelector('.native-start-options');
      for (const t of ['auto', ...tiers]) {
        const label = document.createElement('label');
        const input = Object.assign(document.createElement('input'), {type: 'radio', name: 'native-start-quality', value: t, checked: t === choice});
        const name = t === 'auto' ? `Auto (${tierName(recommended)})` : tierName(t) + (t === recommended ? ' (recommended)' : '');
        const strong = document.createElement('strong'); strong.textContent = name;
        const small = document.createElement('small'); small.textContent = describe[t];
        label.append(input, strong, small);
        label.addEventListener('dblclick', () => start());
        list.append(label);
      }
      const button = panel.querySelector('button');
      const start = () => {
        const v = panel.querySelector('input:checked')?.value || 'auto';
        try { localStorage.setItem(CHOICE_KEY, v); } catch {}
        removeEventListener('keydown', onKey, true);
        panel.remove();
        resolve(v);
      };
      const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); start(); } };
      button.addEventListener('click', start);
      addEventListener('keydown', onKey, true);
      document.body.append(panel);
      (panel.querySelector('input:checked') || button).focus();
    });
  }
  Module['preRun'].push(() => {
    if (args.includes('--verify-gl') && !/[?&]quality=/.test(location.search)) return; // automated check: upstream defaults
    addRunDependency('quality');
    status.textContent = 'Testing your device for the best graphics settings…';
    setTimeout(async () => {
      const requested = new URLSearchParams(location.search).get('quality');
      let saved = loadJSON(QUALITY_KEY), tier, source, apply = false, test = null;
      try {
        // Recommendation: tested once per GPU (re-tested on ?quality=auto or a new test version).
        const gpu = benchmarkGPU(false);
        if (!(saved?.version === QUALITY_VERSION && saved.renderer === gpu.renderer && gpu.webgl2 && requested !== 'auto' && tiers.includes(saved.recommended))) {
          test = gpu.webgl2 ? benchmarkGPU() : gpu;
          saved = {renderer: test.renderer, score: test.score, software: !test.webgl2, recommended: test.webgl2 ? chooseTier(test) : 'low', applied: saved?.applied, version: QUALITY_VERSION, date: new Date().toISOString()};
        }
        let skipMenu = false;
        try { skipMenu = sessionStorage.getItem(SKIP_MENU_KEY) === '1'; sessionStorage.removeItem(SKIP_MENU_KEY); } catch {}
        if (!tiers.includes(requested) && !Module['osShowLauncher'] && !navigator.webdriver && !skipMenu) {
          status.hidden = true;
          await askQuality(saved.recommended);
          status.hidden = false;
          status.textContent = 'Starting OpenSpades…';
        }
        const choice = savedChoice();
        tier = tiers.includes(requested) ? requested : choice !== 'auto' ? choice : saved.recommended;
        source = tiers.includes(requested) ? 'forced by URL' : choice !== 'auto' ? 'chosen' : test ? 'tested' : 'remembered';
        // Write the preset only when the tier changes, so console tweaks survive restarts.
        apply = saved.applied !== tier || !!test;
        saved.applied = tier;
        try { localStorage.setItem(QUALITY_KEY, JSON.stringify(saved)); } catch {}
      } catch (e) { console.warn('[quality] test failed', e); tier = 'medium'; source = 'fallback'; apply = true; saved = saved || {}; }
      const settings = apply ? {...presets[tier]} : {};
      if (apply) settings.r_renderer = saved.software ? 'sw' : 'gl';
      [settings.r_videoWidth, settings.r_videoHeight] = videoSize(tier);
      // Debug: ?set=r_water:1,r_ssao:0 overrides individual settings for this start (A/B testing).
      for (const pair of (new URLSearchParams(location.search).get('set') || '').split(',')) {
        const m = /^(\w+):([\w.-]+)$/.exec(pair);
        if (m) settings[m[1]] = m[2];
      }
      Module['osQuality'] = {tier, recommended: saved.recommended, score: saved.score, renderer: saved.renderer, apply, settings};
      fillPicker(saved.recommended, tier);
      console.log(`[quality] ${source}: ${tier} (recommended ${saved.recommended}` +
        (saved.score !== undefined ? `, score ${Number(saved.score).toFixed(1)}, ${saved.renderer || 'unknown GPU'}` : '') +
        `)${apply ? ', preset applied' : ''}, ${settings.r_videoWidth}x${settings.r_videoHeight}`);
      document.querySelector('nav')?.remove(); // top toolbar (Graphics, Saved files, Import, Fullscreen) hidden once quality is chosen
      removeRunDependency('quality');
    }, 30);
  });
  Module['osShowLauncher'] = /(^|[?&])launcher(=1)?($|&)/.test(location.search);

  // ---- Persistent user directory (desktop: ~/.local/share/openspades or Documents) -----
  Module['preRun'] ||= [];
  Module['preRun'].push(() => {
    for (const w of PThread.unusedWorkers) watch(w);
    const allocate = PThread.allocateUnusedWorker;
    PThread.allocateUnusedWorker = function () { const r = allocate.apply(this, arguments); for (const w of PThread.unusedWorkers) watch(w); return r; };
    FS.mkdirTree('/user'); FS.mount(IDBFS, {}, '/user');
    addRunDependency('user-data');
    FS.syncfs(true, error => { if (error) console.warn('Could not restore saved files', error); removeRunDependency('user-data'); });
    let saving = false;
    const save = () => { if (!saving) { saving = true; FS.syncfs(false, error => { saving = false; if (error) console.warn('Could not save files', error); }); } };
    setInterval(save, 3000);
    addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    Module['osSaveUserFiles'] = save;
  });
  Module['showUserFiles'] = (start = '/user') => {
    const panel = document.getElementById('native-files'), list = document.getElementById('native-file-list'); list.replaceChildren();
    const root = String(start).startsWith('/user') ? start : '/user';
    function visit(path) {
      let names; try { names = FS.readdir(path); } catch { return; }
      for (const name of names.sort()) {
        if (name === '.' || name === '..') continue;
        const file = path + '/' + name, stat = FS.stat(file);
        if (FS.isDir(stat.mode)) visit(file);
        else {
          const button = document.createElement('button'); button.textContent = file.slice(6) + ' (' + stat.size + ' bytes)';
          button.onclick = () => { const blob = new Blob([FS.readFile(file)]), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
          list.append(button);
        }
      }
    }
    visit(root);
    if (!list.children.length) list.textContent = 'No files yet.';
    panel.showModal();
  };
  document.getElementById('native-files-close').onclick = () => document.getElementById('native-files').close();
  // r_fullscreen / Alt+Enter (BrowserPlatform.cpp). Entering needs a recent user gesture: Alt+Enter
  // provides one; a startup request with r_fullscreen=1 waits for the first click or key.
  let wantFullscreen = false;
  const applyFullscreen = () => {
    if (wantFullscreen && !document.fullscreenElement)
      document.documentElement.requestFullscreen().then(layout, () => {});
    else if (!wantFullscreen && document.fullscreenElement)
      document.exitFullscreen().catch(() => {});
  };
  Module['osSetFullscreen'] = on => { wantFullscreen = on; applyFullscreen(); };
  for (const type of ['pointerdown', 'keydown'])
    addEventListener(type, () => { if (wantFullscreen && !document.fullscreenElement) applyFullscreen(); }, {capture: true});
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) wantFullscreen = false; layout(); });
}
else if (typeof process === 'object') {
  // Node (automated --verify run): no DOM. A placeholder id lets the PROXY_TO_PTHREAD startup
  // skip the canvas transfer (OFFSCREEN_FRAMEBUFFER fallback) instead of failing.
  Module['canvas'] = {id: 'canvas'};
}
else if (typeof WorkerGlobalScope !== 'undefined') {
  // Client pthread: SDL's Emscripten message box calls alert(), which workers lack. The page shows
  // it as a dialog instead (onWorkerMessage); unlike desktop, the call does not wait for it to be closed.
  self.alert = text => postMessage({osAlert: String(text)});
}
