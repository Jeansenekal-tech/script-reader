// Operator + display pages in headless Chromium, wired to the real engine in
// place of Electron's IPC:  node test/ui-test.mjs   (needs playwright)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const { PrompterEngine } = require('../main/engine.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'renderer');
const out = path.join(here, 'output');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const engine = new PrompterEngine({});
const pages = [];
const emit = (channel, data) => Promise.all(pages.map((p) => p.evaluate(([c, d]) => window.__emit(c, d), [channel, data]).catch(() => {})));
engine.on('transport', (t) => emit('transport', t));
engine.on('config', () => emit('config', engine.getConfig()));
engine.on('script', () => emit('script', engine.script));
const ticker = setInterval(() => engine.tick(), 100);

// window.prompter, as preload.js exposes it, backed by the engine above.
async function openPage(file, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(`${file}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${file}: ${m.text()}`));
  const calls = {
    getConfig: () => ({ ...engine.getConfig(), displayOpen: false, aspect: 16 / 9 }),
    cmd: (c, v) => engine.perform(c, v),
    updateSettings: (p) => engine.updateSettings(p),
    setScript: (s) => engine.setScript(s),
    newScript: () => { engine.newScript(); return true; },
    openScript: () => null,
    saveScript: () => null,
    setLayout: (l) => engine.setLayout(l),
    setPosition: (p) => engine.setPosition(p),
    getDisplays: () => ({ displays: [{ id: 1, name: 'Built-in display — 1920×1080 (main)' }], selected: 1, aspect: 16 / 9 }),
    toggleDisplay: () => ({ open: true }),
    closeDisplay: () => ({ open: false }),
    remoteStatus: () => ({ running: false, urls: [] }),
  };
  for (const [name, fn] of Object.entries(calls)) await page.exposeFunction(`__${name}`, async (...a) => JSON.parse(JSON.stringify((await fn(...a)) ?? null)));
  await page.addInitScript((names) => {
    const handlers = {};
    window.__emit = (c, d) => (handlers[c] || []).forEach((f) => f(d));
    const on = (c) => (f) => { (handlers[c] ||= []).push(f); };
    window.prompter = { pathForFile: () => '' };
    for (const n of names) window.prompter[n] = (...a) => window[`__${n}`](...a);
    Object.assign(window.prompter, {
      onTransport: on('transport'), onConfig: on('config'), onScript: on('script'), onDisplayState: on('display:state'),
      onDisplaysChanged: on('displays:changed'), onRemote: on('remote'), onMenu: on('menu'),
    });
  }, Object.keys(calls));
  pages.push(page);
  await page.goto(`${base}/${file}`);
  return page;
}

const errors = [];
const browser = await playwright.chromium.launch();
const op = await openPage('operator.html', { width: 1360, height: 860 });
await op.waitForTimeout(500);
check(engine.extent > 0, `operator measures the script (extent ${engine.extent})`);
check(engine.layoutMarkers.length === 3, `finds the 3 markers in the sample script (got ${engine.layoutMarkers.length})`);
check(await op.locator('#markers li[data-i]').count() === 3, 'markers are listed');

const disp = await openPage('display.html', { width: 1920, height: 1080 });
await disp.waitForTimeout(400);
const extentBefore = engine.extent;

// Typing in the editor reaches the engine and the display.
await op.fill('#editor', '# Opening\nGood evening and welcome.\n\n[Pause]\n\n# Close\nThank you and good night.\n' + 'More lines of script to read. '.repeat(80));
await op.waitForTimeout(700);
check(engine.script.text.startsWith('# Opening'), 'editor text is sent to the engine');
check(engine.layoutMarkers.map((m) => m.title).join(',') === 'Opening,Close', 'markers follow the edited script');
const dispText = await disp.locator('.pr-text').innerText();
check(dispText.includes('Good evening'), 'display shows the edited script');
check(await disp.locator('.pr-cue').count() === 1, '[cues] are highlighted on the display');
check(engine.extent !== extentBefore, 'extent updates after editing');

// Play from the keyboard, then pause.
await op.locator('#preview').click();
await op.keyboard.press('Space');
await op.waitForTimeout(1200);
check(engine.playing, 'Space starts scrolling');
const p1 = engine.position();
check(p1 > 20, `position advances while playing (${p1.toFixed(0)})`);
await op.keyboard.press('ArrowDown');
check(engine.speed > engine.settings.defaultSpeed, 'Down arrow speeds up');
await op.keyboard.press('Space');
await op.waitForTimeout(150);
check(!engine.playing, 'Space pauses');

// Both views put the same line on the reading line.
await disp.waitForTimeout(200);
const lineAtGuide = async (page) => page.evaluate(() => {
  const v = document.querySelector('.pr-viewport').getBoundingClientRect();
  const g = document.querySelector('.pr-guide').getBoundingClientRect().top;
  const el = [...document.querySelectorAll('.pr-text [data-line]')].find((e) => {
    const r = e.getBoundingClientRect();
    return r.top <= g && r.bottom >= g;
  });
  return el ? { line: el.dataset.line, text: el.textContent.slice(0, 20), rel: (g - v.top) / v.height } : null;
});
const a = await lineAtGuide(op);
const b = await lineAtGuide(disp);
check(a && b && a.line === b.line, `preview and display show the same line at the reading line (${a?.line} / ${b?.line})`);

// Marker buttons, settings and mirror.
await op.click('#btnTop');
await op.click('#btnNext');
await op.waitForTimeout(100);
check(engine.position() === engine.layoutMarkers[1].offset, 'Next marker jumps to the second marker');
await op.locator('#settings [data-k="mirror"]').check();
await op.waitForTimeout(200);
check(engine.settings.mirror, 'mirror setting reaches the engine');
const dispTransform = await disp.locator('.pr-frame').evaluate((el) => el.style.transform);
const opTransform = await op.locator('#preview .pr-frame').evaluate((el) => el.style.transform);
check(/scale\(-1, 1\)/.test(dispTransform), 'display is mirrored');
check(opTransform === '', 'operator preview stays readable (not mirrored)');
await op.locator('#settings [data-k="fontSize"]').fill('120');
await op.waitForTimeout(400);
check(engine.settings.fontSize === 120, 'text size slider works');
check(await disp.locator('.pr-text').evaluate((el) => el.style.fontSize) === '120px', 'display uses the new text size');

// Scrolls to the end and stops.
engine.setSpeed(30);
engine.setPosition(engine.extent - 50);
engine.play();
await op.waitForTimeout(800);
check(!engine.playing && engine.ended, 'stops at the end of the script');
await disp.waitForTimeout(100);
check(await disp.locator('.pr-end').isVisible(), 'display shows END');

await op.screenshot({ path: path.join(out, 'operator.png') });
await disp.screenshot({ path: path.join(out, 'display.png') });
check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

clearInterval(ticker);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall UI checks passed');
process.exit(failures ? 1 : 0);
