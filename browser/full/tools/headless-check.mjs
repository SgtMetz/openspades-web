// Automated, non-interactive browser integration check for the original-client build.
// Starts the local COOP/COEP server, opens the page in headless Edge/Chrome (SwiftShader WebGL 2),
// sends no input, and records console output and one screenshot per scenario:
//   gl      ?verify-gl  -> SDLRunner + GLRenderer + scripted menu for 120 frames (main.cpp)
//   gl-low, gl-medium, gl-high, gl-ultra  ?verify-gl&quality=<preset> -> the same with each
//            graphics preset the page can choose
//   startup (default)   -> browser start: device test picks a preset, then the main menu (no launcher)
//   launcher ?launcher  -> the original startup window (software renderer)
//   touch   ?touch=1    -> touch mode: the client loop drains the touch input queue
//   net-ip, net-int, net-name  ?aos://<address> -> the original NetClient connects through a
//            WebSocket relay to a local ENet endpoint (tools/enet_test_server.c, run in WSL) that
//            accepts, sends a packet and disconnects with reason 4; the address is given as a
//            dotted IPv4 literal, as an integer (names without dots, as ServerAddress parses
//            them) and as a host name resolved by the relay. No public server is contacted.
// Usage: node tools/headless-check.mjs [gl|gl-<preset>|startup|launcher|touch|net-ip|net-int|net-name ...]   (default: all)
import {spawn, execFileSync} from 'node:child_process';
import {startTestRelay} from './test-relay.mjs';
import {mkdtempSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../build');
const browsers = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browserPath = browsers.find(p => existsSync(p));
if (!browserPath) throw Error('No Chromium-based browser found; set BROWSER');
const port = 8123 + Math.floor(Math.random() * 50), debugPort = 9333 + Math.floor(Math.random() * 50);
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['gl', 'gl-low', 'gl-medium', 'gl-high', 'gl-ultra', 'startup', 'launcher', 'touch', 'net-ip', 'net-int', 'net-name'];
const testName = 'osweb-enet.test', testPort = 32990 + Math.floor(Math.random() * 9);
let wslAddress = '';
const ipv4ToInt = a => a.split('.').map(Number).reduce((v, x, i) => v + x * 2 ** (8 * i), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, [path.resolve(here, '../server.mjs')], {env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
const profile = mkdtempSync(path.join(tmpdir(), 'osweb-check-'));
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank'], {stdio: 'ignore'});

let failures = 0;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw Error('Browser did not expose a page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map(), listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({id: n, method, params})); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  for (const scenario of scenarios) {
    const lines = [];
    const onMessage = m => {
      if (m.method === 'Runtime.consoleAPICalled') lines.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      else if (m.method === 'Runtime.exceptionThrown') lines.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      else if (m.method === 'Log.entryAdded') lines.push(`[log:${m.params.entry.level}] ${m.params.entry.text}`);
    };
    listeners.push(onMessage);
    const isNet = scenario.startsWith('net-'), isGL = scenario === 'gl' || scenario.startsWith('gl-');
    let query = scenario === 'gl' ? '?verify-gl' : isGL ? `?verify-gl&quality=${scenario.slice(3)}` :
      scenario === 'touch' ? '?touch=1' : scenario === 'launcher' ? '?launcher' : '';
    let relay, enetServer, serverLines = [], injected, expectedHost;
    if (isNet) {
      wslAddress ||= execFileSync('wsl', ['--', 'hostname', '-I'], {encoding: 'utf8'}).trim().split(/\s+/)[0];
      enetServer = spawn('wsl', ['--', 'bash', '/mnt/c/Open spades web/browser/full/tools/enet_test_server.sh', String(testPort)]);
      enetServer.stdout.on('data', d => serverLines.push(...d.toString().split('\n').filter(Boolean)));
      enetServer.stderr.on('data', d => serverLines.push('stderr: ' + d.toString().trim()));
      for (let i = 0; i < 120 && !serverLines.some(l => l.startsWith('LISTENING')); i++) await sleep(500);
      relay = await startTestRelay({resolve: (host, p) =>
        p === testPort && (host === wslAddress || host === testName) ? {host: wslAddress, port: p} : null});
      injected = (await send('Page.addScriptToEvaluateOnNewDocument', {source: `self.osRelayUrl = 'ws://127.0.0.1:${relay.port}';`})).result.identifier;
      const address = scenario === 'net-ip' ? wslAddress : scenario === 'net-int' ? String(ipv4ToInt(wslAddress)) : testName;
      expectedHost = scenario === 'net-name' ? testName : wslAddress;
      query = `?aos://${address}:${testPort}&v=75`;
    }
    const url = `http://127.0.0.1:${port}/full/${query}`;
    await send('Page.navigate', {url});
    const deadline = Date.now() + (isGL ? 300000 : 60000);
    const done = () => isGL
      ? lines.some(l => l.includes('OSWEB-GL:') || l.includes('OSWEB-GL-RESULT') || l.includes('OpenSpades stopped') || l.includes('[exception]'))
      : isNet ? lines.some(l => l.includes('Disconnected (data') || l.includes('OpenSpades stopped') || l.includes('[exception]'))
      : lines.some(l => l.includes('Starting Client Loop')) && Date.now() > deadline - 45000;
    while (Date.now() < deadline && !done()) await sleep(1000);
    if (scenario === 'startup' || scenario === 'touch' || scenario === 'launcher') await sleep(5000);
    let touchResult;
    if (scenario === 'touch' || scenario === 'startup') {
      // Detection, and the client loop polling the touch queue (queued text is consumed by the
      // original loop; a Shift press and release has no effect in the menu).
      touchResult = (await send('Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression: `(async () => {
        const t = Module.osTouch, poll = Module.osTouchPoll; let calls = 0;
        Module.osTouchPoll = (...a) => { calls++; return poll(...a); };
        t.queue.push('+Shift', '-Shift');
        await new Promise(r => setTimeout(r, 2000));
        Module.osTouchPoll = poll;
        return {enabled: Module.osTouchEnabled, cls: document.documentElement.classList.contains('touch'), calls,
          drained: !t.queue.length, padHidden: document.getElementById('touch-controls').hidden,
          textBarHidden: document.getElementById('touch-text-bar').hidden};
      })()`})).result.result.value;
      lines.push('[check] touch: ' + JSON.stringify(touchResult));
    }
    if (isNet) {
      await send('Page.removeScriptToEvaluateOnNewDocument', {identifier: injected});
      for (let i = 0; i < 20 && enetServer.exitCode === null; i++) await sleep(250);
      enetServer.kill(); relay.close();
      for (const l of serverLines) lines.push('[enet-server] ' + l);
      lines.push(`[check] relay requests: ${JSON.stringify(relay.requests)}`);
    }
    await sleep(1500);
    const presented = (await send('Runtime.evaluate', {expression: "Module.osPresentedFrames || 0", returnByValue: true})).result.result.value;
    const varying = (await send('Runtime.evaluate', {returnByValue: true, expression: `(() => {
      const c = document.getElementById('native-view'); if (c.hidden || !c.width) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 4; i < d.length; i += 4) n += d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2];
      return n / (d.length / 4); })()`})).result.result.value;
    lines.push(`[check] page presented ${presented} frames; ${(varying * 100).toFixed(1)}% of displayed pixels differ from the first`);
    const status = await send('Runtime.evaluate', {expression: "document.getElementById('native-status').hidden ? '' : document.getElementById('native-status').textContent", returnByValue: true});
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(path.join(out, `headless-${scenario}.png`), Buffer.from(shot.result.data, 'base64'));
    writeFileSync(path.join(out, `headless-${scenario}.log`), lines.join('\n') + '\n');
    listeners.splice(listeners.indexOf(onMessage), 1);
    const errors = lines.filter(l => /\bGL error|Error while (compiling|linking)|OpenSpades stopped|\[exception\]|Aborted|FULL CLIENT ERROR|Unhandled exception/.test(l));
    let ok;
    if (scenario === 'gl') {
      const registered = Number((lines.find(l => l.includes('OSWEB-AUDIO:')) ?? '').match(/(\d+) original sounds/)?.[1] ?? 0);
      const audio = (await send('Runtime.evaluate', {expression: 'JSON.stringify(Module.fullAudio.stats)', returnByValue: true})).result.result.value;
      const stats = JSON.parse(audio);
      lines.push(`[check] audio: ${registered} sounds registered, ${stats.decoded} decoded, ${stats.failed} failed`);
      console.log(`  [check] audio: ${registered} sounds registered, ${stats.decoded} decoded, ${stats.failed} failed`);
      if (!(registered > 100 && stats.decoded === registered && !stats.failed)) failures++;
    }
    if (isGL) ok = lines.some(l => l.includes('PASS: original GL renderer')) && presented > 30 && varying > 0.05 && !errors.length &&
      (scenario === 'gl' || lines.some(l => l.includes(`[quality] forced: ${scenario.slice(3)}`)));
    else if (isNet) {
      // A command-line connect runs under RunProtected, so, as on desktop, the server's disconnect
      // ends the client with the "OpenSpades Fatal Error" box carrying the reason.
      const dialogs = (await send('Runtime.evaluate', {returnByValue: true,
        expression: "[...document.querySelectorAll('dialog[open]')].map(d => d.textContent).join(' | ')"})).result.result.value;
      lines.push(`[check] dialogs: ${dialogs}`);
      writeFileSync(path.join(out, `headless-${scenario}.log`), lines.join('\n') + '\n');
      const expected = l => /Unhandled exception in SDLRunner/.test(l) && lines[lines.indexOf(l) + 1]?.includes('Disconnected: Server full');
      ok = serverLines.some(l => l.startsWith('CONNECT version=3')) &&
        lines.some(l => l.includes('Disconnected (data = 0x00000004)')) && /Server full/.test(dialogs) &&
        relay.requests.length >= 1 && relay.requests.every(r => r.host === expectedHost && r.port === testPort) &&
        !errors.filter(l => !expected(l)).length;
    }
    else {
      const start = scenario === 'launcher' ? 'Starting startup window' : 'Starting main screen';
      // A fresh profile is tested once; later scenarios in this run reuse the remembered result.
      if (scenario === 'startup' && !lines.some(l => /\[quality\] (tested|remembered): \w+/.test(l))) ok = false;
      ok = ok !== false && lines.some(l => l.includes(start)) && lines.some(l => l.includes('Starting Client Loop')) && presented > 10 && varying > 0.05 && !errors.length && !status.result.result.value;
      // Desktop (headless, no touch screen): no controls and no polling. ?touch=1: polled every
      // frame and drained; menus (absolute mouse) keep the controls hidden.
      if (scenario === 'startup') ok &&= !touchResult.enabled && !touchResult.cls && touchResult.calls === 0;
      // Polled once per frame (the main menu runs at a few frames per second on SwiftShader). Its
      // address field takes text, so the text-entry bar is shown there.
      if (scenario === 'touch') ok &&= touchResult.enabled && touchResult.cls && touchResult.calls >= 3 && touchResult.drained && touchResult.padHidden && !touchResult.textBarHidden;
    }
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${scenario} (${lines.length} console lines; build/headless-${scenario}.log, .png)`);
    for (const l of lines.filter(l => /OSWEB-GL|PASS|FAIL|Starting|linked GLSL program|\[check\]|\[enet-server\]|Connecting to|Disconnected/.test(l)).slice(-6)) console.log('  ' + l.slice(0, 200));
    for (const l of errors.slice(0, 8)) console.log('  ! ' + l.slice(0, 400));
    if (status.result.result.value) console.log('  status: ' + status.result.result.value);
  }
  ws.close();
} finally {
  browser.kill(); server.kill();
  await sleep(1000);
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}
process.exit(failures ? 1 : 0);
