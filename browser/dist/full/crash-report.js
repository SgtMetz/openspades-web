// Crash reports. When the game stops (an abort, an exit with an error, an error in one of its threads, or no frames
// for a long time) the page shows a crash screen instead of just stopping, so the player can send the log, save it,
// or reload. If the tab itself died (out of memory, the browser killed it), the next visit offers to send that log.
//
// The report goes to <meta name="openspades-crash-report" content="URL"> (a JSON POST); on localhost it goes to the
// local server's /__crash (browser/full/server.mjs). Without either the screen offers only Save and Copy.
// Loaded before full-client.js, after debug-log.js when that is present.
(() => {
  const MAX_LINES = 1500, MAX_LINE = 2000, SAVED_LINES = 400, SAVED_LINE = 500;
  const STALL_MS = 30000, KEY = 'openspades-crash-session';
  const started = Date.now(), session = started.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const lines = [];
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const endpoint = () => document.querySelector('meta[name="openspades-crash-report"]')?.content || (local ? '/__crash' : '');

  // ---- The recent log -------------------------------------------------------------------------------------------
  const fmt = a => {
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  };
  function add(kind, args) {
    let text = args.map(fmt).join(' ');
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + '…';
    lines.push(`${((Date.now() - started) / 1000).toFixed(3).padStart(9)} [${kind}] ${text}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }
  const consoleLog = console.log.bind(console);
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { add(level, args); orig(...args); };
  }
  addEventListener('error', e => add('error', ['uncaught:', e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error || '']), true);
  addEventListener('unhandledrejection', e => add('error', ['unhandled rejection:', e.reason]));

  self.Module = self.Module || {};
  // The game's standard output: debug-log.js sends it to its own log only, so keep a copy here.
  const print = Module.print;
  Module.print = text => { add('stdout', [text]); if (print) print(text); else consoleLog(text); };
  // Wrap a Module handler that browser.js (compiled into full-client.js) assigns later, keeping any wrapper
  // debug-log.js already put there. Emscripten reads these when it calls them.
  function hook(name, before) {
    const d = Object.getOwnPropertyDescriptor(Module, name);
    let fn = d && 'value' in d ? d.value : undefined;
    Object.defineProperty(Module, name, {
      configurable: true, enumerable: true,
      get: () => (...args) => { try { before(...args); } catch (e) { consoleLog('crash-report:', e); } return (d?.get ? d.get() : fn)?.(...args); },
      set: v => { if (d?.set) d.set(v); else fn = v; },
    });
  }
  // The game's own error message (its error dialog goes to stderr just before it exits), for the crash screen.
  const lastErrors = () => {
    const out = [];
    // the error lines just before the end (the abort/exit lines aside), not older warnings
    for (let i = lines.length - 1; i >= 0 && out.length < 3; i--) {
      if (/^\s*[\d.]+ \[(abort|exit)\]/.test(lines[i])) continue;
      const m = /^\s*[\d.]+ \[error\] (.*)$/s.exec(lines[i]);
      if (!m || /^WARNING/.test(m[1])) break;
      if (m[1] !== '(none)') out.unshift(m[1].slice(0, 300));
    }
    return out.length ? '\n' + out.join('\n') : '';
  };
  hook('onAbort', reason => { add('abort', [reason]); crash('abort', 'The game stopped: ' + fmt(reason ?? 'unknown error') + lastErrors()); });
  hook('onExit', code => { add('exit', ['code', code]); if (code) crash('exit', `The game exited with error code ${code}.` + lastErrors()); else quitClean(); });

  // The game's threads (Emscripten pthreads): an uncaught error in one stops the game.
  const PrevWorker = self.Worker;
  self.Worker = function (url, opts) {
    const w = new PrevWorker(url, opts);
    w.addEventListener('error', e => {
      add('error', ['thread error:', e.message, `${e.filename}:${e.lineno}`]);
      // the abort that usually follows has the better reason
      setTimeout(() => crash('thread', 'A game thread crashed: ' + (e.message || 'unknown error')), 1500);
    });
    return w;
  };
  self.Worker.prototype = PrevWorker.prototype;

  // ---- The game's own log files (/user/*.log, e.g. SystemMessages.log), their last part --------------------------
  function gameLogs() {
    const out = {};
    try {
      for (const f of FS.readdir('/user').filter(f => /\.log$/i.test(f))) {
        const data = FS.readFile('/user/' + f);
        out[f] = new TextDecoder().decode(data.subarray(Math.max(0, data.length - 60000)));
      }
    } catch {}
    return out;
  }
  function gpu() {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no WebGL2';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return name;
    } catch { return '?'; }
  }
  const device = () => ({
    userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}`, window: `${innerWidth}x${innerHeight}`,
    dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory ?? null,
    isolated: self.crossOriginIsolated, touch: matchMedia('(pointer:coarse)').matches, gpu: gpu(),
  });
  const build = () => document.querySelector('meta[name="openspades-build"]')?.content || '';

  // ---- If the tab dies: the last part of the log in localStorage, cleared when the page closes normally ----------
  let saving = true;
  function save() {
    if (!saving) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        session, started, lastSeen: Date.now(), visible: document.visibilityState === 'visible', build: build(),
        frames: Module.osPresentedFrames || 0, url: location.pathname + location.search,
        lines: lines.slice(-SAVED_LINES).map(l => l.length > SAVED_LINE ? l.slice(0, SAVED_LINE) + '…' : l),
      }));
    } catch {}
  }
  const forget = () => { try { localStorage.removeItem(KEY); } catch {} };
  addEventListener('pagehide', () => { saving = false; forget(); });
  addEventListener('pageshow', e => { if (e.persisted) { saving = true; save(); } });
  document.addEventListener('visibilitychange', save);
  let previous = null;
  try { previous = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}

  // ---- No frames for a long time while visible: the game hung --------------------------------------------------
  let lastFrames = 0, lastChange = Date.now(), wasHidden = false;
  setInterval(() => {
    save();
    const frames = Module.osPresentedFrames || 0;
    if (document.visibilityState !== 'visible') { wasHidden = true; return; }
    if (frames !== lastFrames || wasHidden) { lastFrames = frames; lastChange = Date.now(); wasHidden = false; return; }
    if (frames > 0 && Date.now() - lastChange > STALL_MS && !shown) {
      add('stall', [`no frames for ${Math.round((Date.now() - lastChange) / 1000)} s`]);
      crash('stall', 'The game stopped responding (no new frames for 30 seconds).', true);
    }
  }, 5000);

  // ---- The crash screen -----------------------------------------------------------------------------------------
  let shown = null;
  const css = `#os-crash{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;
background:rgba(0,0,0,.78);font:15px/1.4 system-ui,sans-serif;color:#eee}
#os-crash .box{width:min(520px,100%);max-height:100%;overflow:auto;background:#151515;border:1px solid #777;border-radius:8px;padding:18px 20px;box-sizing:border-box}
#os-crash h2{margin:0 0 6px;font-size:20px}#os-crash .why{margin:0 0 12px;color:#f3b0a0;word-break:break-word;white-space:pre-wrap}
#os-crash p{margin:0 0 10px}#os-crash textarea{width:100%;box-sizing:border-box;min-height:64px;font:15px system-ui,sans-serif;
background:#0d0d0d;color:#fff;border:1px solid #666;border-radius:6px;padding:8px;resize:vertical}
#os-crash .row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}#os-crash button{background:#202020;color:#fff;border:1px solid #777;
border-radius:5px;padding:9px 14px;font:15px system-ui,sans-serif;cursor:pointer}#os-crash button.main{background:#2d4a2d;border-color:#8a8}
#os-crash button:disabled{opacity:.5;cursor:default}#os-crash .status{min-height:1.4em;margin:10px 0 0;color:#bbb}#os-crash .status.ok{color:#7d7}
#os-crash .status.bad{color:#f99}#os-crash small{color:#999}`;
  function screenFor({kind, reason, title, report, canResume}) {
    const manual = kind === 'manual', closes = manual || kind === 'previous';
    shown?.dispatchEvent(new Event('remove-listeners')); shown?.remove();
    if (!document.getElementById('os-crash-css')) {
      const s = document.createElement('style'); s.id = 'os-crash-css'; s.textContent = css; document.head.append(s);
    }
    try { document.exitPointerLock?.(); } catch {}
    const url = endpoint();
    const el = document.createElement('div');
    el.id = 'os-crash'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-labelledby', 'os-crash-title');
    el.innerHTML = `<div class="box"><h2 id="os-crash-title"></h2><p class="why"></p>
<p>${manual ? 'Tell us what went wrong. The report also holds the game’s log (which includes your player name and the server you are on) and your browser and graphics card.' : url ? 'Sending the crash report helps fix it. It holds the game\'s log (which includes your player name and the server you were on) and your browser and graphics card.' : 'Save the log to send it to whoever runs this site.'}</p>
${url || manual ? `<textarea placeholder="${manual ? 'What happened? What were you doing? (required)' : 'What were you doing when it happened? (optional)'}" maxlength="2000"></textarea>` : ''}
<div class="row">${url ? `<button class="main send">${manual ? 'Send report' : 'Send crash report'}</button>` : ''}<button class="save">Save log</button><button class="copy">Copy log</button>
${canResume ? '<button class="resume">Keep waiting</button>' : ''}<button class="${closes ? 'close' : 'reload'}">${closes ? 'Close' : 'Reload'}</button></div>
<p class="status" aria-live="polite"></p></div>`;
    el.querySelector('h2').textContent = title;
    el.querySelector('.why').textContent = reason;
    const status = (text, cls = '') => { const s = el.querySelector('.status'); s.textContent = text; s.className = 'status ' + cls; };
    const full = () => {
      const note = el.querySelector('textarea')?.value.trim() || '';
      const r = {...report(), note};
      if (manual && note) r.reason = 'Player report: ' + note.split('\n')[0].slice(0, 200);
      return r;
    };
    const asText = r => [`OpenSpades crash report ${r.id}`, `kind: ${r.kind}`, `reason: ${r.reason}`, `page: ${r.url}`,
      `build: ${r.build || '-'}`, `when: ${new Date(r.time).toISOString()}`, `device: ${JSON.stringify(r.device)}`,
      r.note ? `note: ${r.note}` : '', '', '---- log ----', ...r.lines,
      ...Object.entries(r.gameLogs || {}).flatMap(([f, t]) => ['', `---- ${f} (last part) ----`, t])].join('\n');
    el.querySelector('.send')?.addEventListener('click', async e => {
      const button = e.currentTarget;
      if (manual && !el.querySelector('textarea').value.trim()) { status('Write a few words about the problem first.', 'bad'); el.querySelector('textarea').focus(); return; }
      button.disabled = true; status('Sending…');
      try {
        const r = full(), body = JSON.stringify(r);
        const res = await fetch(url, {method: 'POST', body, headers: {'Content-Type': 'application/json'}});
        if (!res.ok) throw new Error(res.status === 429 ? 'too many reports from here just now, try again later' : 'server answered ' + res.status);
        const id = (await res.json().catch(() => ({}))).id || r.id;
        status(`Sent, thank you. Report ${id}.`, 'ok'); button.textContent = 'Sent';
      } catch (err) {
        button.disabled = false; status(`Could not send the report (${err.message || err}). Save the log instead.`, 'bad');
      }
    });
    el.querySelector('.save').addEventListener('click', () => {
      const r = full(), a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([asText(r)], {type: 'text/plain'}));
      a.download = `openspades-crash-${r.id}.txt`; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      status('Saved.', 'ok');
    });
    el.querySelector('.copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(asText(full())); status('Copied to the clipboard.', 'ok'); }
      catch { status('The browser did not allow copying. Use Save log.', 'bad'); }
    });
    el.querySelector('.resume')?.addEventListener('click', () => { el.remove(); shown = null; lastChange = Date.now(); });
    el.querySelector('.reload')?.addEventListener('click', () => location.reload());
    el.querySelector('.close')?.addEventListener('click', () => { el.dispatchEvent(new Event('remove-listeners')); el.remove(); shown = null; if (manual) document.getElementById('canvas')?.focus(); });
    // Escape closes the report (wherever the focus is: after sending it is on the page, not in the box)
    const onEscape = e => { if (e.key === 'Escape' && closes && shown === el) { e.stopPropagation(); e.preventDefault(); el.querySelector('.close').click(); } };
    if (closes) { addEventListener('keydown', onEscape, true); el.addEventListener('remove-listeners', () => removeEventListener('keydown', onEscape, true)); }
    // keys typed here are not the game's
    for (const type of ['keydown', 'keyup', 'keypress']) el.addEventListener(type, e => e.stopPropagation());
    (document.body || document.documentElement).append(el);
    shown = el;
    if (manual) el.querySelector('textarea')?.focus();
    return el;
  }

  let crashed = false;
  function crash(kind, reason, canResume = false) {
    if (crashed && kind === 'thread') return; // the abort already showed it
    if (shown && !canResume && !['stall', 'previous', 'manual'].includes(shown.dataset.kind)) return;
    if (!canResume) { crashed = true; saving = false; forget(); }
    const time = Date.now(), id = session + (kind === 'stall' ? '-stall' : '');
    const show = () => {
      const el = screenFor({kind, reason, title: canResume ? 'OpenSpades is not responding' : 'OpenSpades crashed', canResume,
        report: () => ({id, kind, reason, time, url: location.pathname + location.search, build: build(), uptimeS: Math.round((time - started) / 1000),
          frames: Module.osPresentedFrames || 0, device: device(), lines: lines.slice(), gameLogs: gameLogs()})});
      el.dataset.kind = kind;
    };
    if (document.body) show(); else addEventListener('DOMContentLoaded', show);
  }
  function quitClean() { saving = false; forget(); }

  // The tab died last time while it was on screen: offer to send that log. (A tab closed or killed in the
  // background does not count: phones close background tabs all the time.)
  if (previous?.lines?.length && previous.visible && previous.frames > 0 && Date.now() - previous.lastSeen < 3 * 86400e3) {
    addEventListener('DOMContentLoaded', () => {
      const el = screenFor({kind: 'previous', title: 'OpenSpades closed unexpectedly last time',
        reason: `The game's tab stopped ${Math.max(1, Math.round((Date.now() - previous.lastSeen) / 60000))} min ago without closing normally (it may have run out of memory).`,
        report: () => ({id: previous.session, kind: 'tab-died', reason: 'tab ended without closing normally',
          time: previous.lastSeen, url: previous.url, build: previous.build, uptimeS: Math.round((previous.lastSeen - previous.started) / 1000),
          frames: previous.frames, device: device(), lines: previous.lines, gameLogs: {}})});
      el.dataset.kind = 'previous';
    });
  }
  // ---- The player's own report: the Report a bug button below the game (or in the corner on phones) -----------
  let manualCount = 0;
  function reportBug() {
    if (shown && shown.dataset.kind !== 'manual') return; // a crash screen is already up
    if (shown) { shown.querySelector('textarea')?.focus(); return; }
    const time = Date.now(), id = `${session}-r${++manualCount}`;
    const el = screenFor({kind: 'manual', title: 'Report a bug or crash', canResume: false,
      reason: '',
      report: () => ({id, kind: 'manual', reason: 'Player report', time, url: location.pathname + location.search, build: build(),
        uptimeS: Math.round((time - started) / 1000), frames: Module.osPresentedFrames || 0, device: device(), lines: lines.slice(), gameLogs: gameLogs()})});
    el.dataset.kind = 'manual';
    el.querySelector('.why').hidden = true;
  }
  addEventListener('DOMContentLoaded', () => {
    for (const b of document.querySelectorAll('.os-report-bug')) b.addEventListener('click', e => { e.currentTarget.blur(); reportBug(); });
  });
  save(); // this session's record replaces the last one (already read into previous)
  self.osCrashReport = {crash, lines, reportBug};
})();
