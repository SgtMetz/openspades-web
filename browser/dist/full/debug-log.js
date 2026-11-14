// Crash/debug logger for playtesting (local only). Streams everything to the local server's
// /__log endpoint, which appends it to browser/logs/. Loaded before full-client.js.
(() => {
  const session = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
  const t0 = performance.now();
  let queue = [], seq = 0;
  const stamp = () => ((performance.now() - t0) / 1000).toFixed(3).padStart(9);
  const fmt = a => {
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  };
  function log(kind, ...args) {
    const line = `${stamp()} [${kind}] ${args.map(fmt).join(' ')}`;
    queue.push(line);
    if (queue.length > 5000) queue.splice(0, queue.length - 4000, '... (log queue overflow, dropped lines)');
    if (kind === 'FATAL' || kind === 'ERROR' || kind === 'ABORT') flush(true);
  }
  function flush(urgent) {
    if (!queue.length) return;
    const body = JSON.stringify({session, seq: seq++, lines: queue}); queue = [];
    if (urgent && navigator.sendBeacon && navigator.sendBeacon('/__log', new Blob([body], {type: 'text/plain'}))) return;
    fetch('/__log', {method: 'POST', body, keepalive: body.length < 60000, headers: {'Content-Type': 'text/plain'}}).catch(() => {});
  }
  setInterval(flush, 1000);
  self.osDebugLog = log;

  // ---- Console (main thread; worker print/printErr are proxied here by Emscripten) ----
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { log(level === 'log' ? 'console' : level, ...args); orig(...args); };
  }
  addEventListener('error', e => log('FATAL', 'window.onerror:', e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error || ''), true);
  addEventListener('unhandledrejection', e => log('FATAL', 'unhandledrejection:', e.reason));

  // Workers (Emscripten pthreads): uncaught errors inside them.
  const NativeWorker = self.Worker;
  let workers = 0;
  self.Worker = function (url, opts) {
    const w = new NativeWorker(url, opts), id = ++workers;
    log('worker', `created #${id}`, String(url));
    w.addEventListener('error', e => log('FATAL', `worker #${id} error:`, e.message, `${e.filename}:${e.lineno}`));
    w.addEventListener('messageerror', () => log('ERROR', `worker #${id} messageerror`));
    return w;
  };
  self.Worker.prototype = NativeWorker.prototype;

  // Relay WebSockets (multiplayer).
  const NativeWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    const short = String(url).replace(/^.*\/relay\?/, 'relay?');
    let rx = 0, tx = 0;
    log('net', 'ws open requested', short);
    ws.addEventListener('open', () => log('net', 'ws opened', short));
    ws.addEventListener('message', () => rx++);
    const send = ws.send.bind(ws); ws.send = d => { tx++; return send(d); };
    ws.addEventListener('error', () => log('ERROR', 'ws error', short));
    ws.addEventListener('close', e => log('net', `ws closed ${short} code=${e.code} reason=${e.reason || '-'} clean=${e.wasClean} rx=${rx} tx=${tx}`));
    return ws;
  };
  Object.assign(self.WebSocket, {CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3});
  self.WebSocket.prototype = NativeWS.prototype;

  // ---- Module hooks (browser.js, compiled into full-client.js, sets others later) ----
  self.Module = self.Module || {};
  Module.print = text => log('stdout', text);
  Module.debugLogSession = session;
  // Wrap onAbort/onExit/printErr whenever browser.js assigns them.
  for (const [name, kind] of [['onAbort', 'ABORT'], ['onExit', 'EXIT']]) {
    let fn;
    Object.defineProperty(Module, name, {
      configurable: true, enumerable: true,
      get: () => (...args) => { log(kind, name, ...args); dumpGameLogs('on ' + name); flush(true); return fn?.(...args); },
      set: v => { fn = v; },
    });
  }

  // ---- Page state -------------------------------------------------------------------
  addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('native-status');
    if (status) new MutationObserver(() => { if (!status.hidden && status.textContent) log('status', status.textContent); })
      .observe(status, {childList: true, characterData: true, subtree: true, attributes: true});
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === 'DIALOG') log('dialog', n.textContent.slice(0, 2000)); })
      .observe(document.body, {childList: true});
  });
  document.addEventListener('visibilitychange', () => log('page', 'visibility', document.visibilityState));
  document.addEventListener('pointerlockchange', () => log('input', 'pointer lock', document.pointerLockElement ? 'ON' : 'off'));
  document.addEventListener('pointerlockerror', () => log('ERROR', 'pointer lock request failed'));
  document.addEventListener('fullscreenchange', () => log('page', 'fullscreen', !!document.fullscreenElement));
  addEventListener('pagehide', () => { log('page', 'pagehide (tab closing/reloading)'); dumpGameLogs('pagehide'); flush(true); });
  addEventListener('blur', () => log('page', 'window blur'));
  addEventListener('focus', () => log('page', 'window focus'));

  // Input summary (key codes + mouse buttons, counted per heartbeat).
  let keys = {};
  addEventListener('keydown', e => { if (!e.repeat) keys[e.code] = (keys[e.code] || 0) + 1; }, true);
  addEventListener('mousedown', e => { keys['Mouse' + e.button] = (keys['Mouse' + e.button] || 0) + 1; }, true);

  // ---- Game's own log files in /user (SystemMessages.log etc.), tailed incrementally ----
  const offsets = {};
  function tailGameLogs() {
    if (typeof FS === 'undefined') return;
    let files;
    try { files = FS.readdir('/user').filter(f => /\.log$/i.test(f)); } catch { return; }
    for (const f of files) {
      try {
        const data = FS.readFile('/user/' + f);
        const from = offsets[f] ?? 0;
        if (data.length < from) offsets[f] = 0;
        if (data.length > (offsets[f] ?? 0)) {
          const text = new TextDecoder().decode(data.subarray(offsets[f] ?? 0));
          offsets[f] = data.length;
          for (const l of text.split('\n')) if (l.trim()) log('game:' + f, l);
        }
      } catch {}
    }
  }
  function dumpGameLogs(why) { try { tailGameLogs(); } catch (e) { log('warn', 'tail logs failed', why, e); } }

  // ---- Heartbeat: fps, memory, stall detection ----------------------------------------
  let lastFrames = 0, lastBeat = performance.now(), stalled = false, lastRaf = performance.now();
  (function raf() { lastRaf = performance.now(); requestAnimationFrame(raf); })();
  setInterval(() => {
    const now = performance.now(), dt = (now - lastBeat) / 1000; lastBeat = now;
    const frames = Module.osPresentedFrames || 0, fps = (frames - lastFrames) / dt; lastFrames = frames;
    const heapMB = typeof wasmMemory !== 'undefined' ? (wasmMemory.buffer.byteLength / 1048576).toFixed(0) : '?';
    const jsMB = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) : '?';
    const k = Object.entries(keys).map(([c, n]) => `${c}x${n}`).join(' '); keys = {};
    const visible = document.visibilityState === 'visible';
    log('beat', `fps=${fps.toFixed(1)} frames=${frames} wasmHeap=${heapMB}MB jsHeap=${jsMB}MB vis=${document.visibilityState} lock=${!!document.pointerLockElement} mainLoopLag=${(now - lastRaf).toFixed(0)}ms` + (k ? ` keys: ${k}` : ''));
    if (visible && frames > 0 && fps === 0 && !stalled) { stalled = true; log('ERROR', 'FRAME STALL: no frames presented for ~5s while visible (client thread hung or crashed)'); dumpGameLogs('stall'); }
    if (fps > 0 && stalled) { stalled = false; log('page', 'frames resumed'); }
    tailGameLogs();
  }, 5000);

  log('page', 'session start', location.href, navigator.userAgent, `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} cores=${navigator.hardwareConcurrency} mem=${navigator.deviceMemory ?? '?'}GB isolated=${self.crossOriginIsolated}`);
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    log('page', 'GPU', gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'NO WEBGL2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (e) { log('warn', 'GPU probe failed', e); }
})();
