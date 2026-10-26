// Full app in Electron (needs a display):  xvfb-run -a node test/electron-smoke.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-test-'));
const scriptFile = path.join(profile, 'Show.txt');
fs.writeFileSync(scriptFile, '# Intro\nHello and welcome.\n\n# Outro\nGoodbye.\n');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', scriptFile],
  env: { ...process.env, PROMPTER_USER_DATA: profile, PROMPTER_UPDATE_URL: 'http://127.0.0.1:9/none' },
});
const errors = [];
const op = await app.firstWindow();
op.on('pageerror', (e) => errors.push(e.message));
await op.waitForSelector('#editor');
await wait(800);
check((await op.title()).includes('Teleprompter'), 'operator window opens');
check((await op.inputValue('#editor')).startsWith('# Intro'), 'script file from the command line is opened');
check((await op.textContent('#scriptName')) === 'Show', 'script name shown');
check(await op.locator('#markers li[data-i]').count() === 2, 'markers listed');

await op.evaluate(() => window.prompter.cmd('play'));
await wait(600);
const cfg = await op.evaluate(() => window.prompter.getConfig());
check(cfg.transport.playing && cfg.transport.position > 0, `scrolls (position ${cfg.transport.position.toFixed(0)})`);
await op.evaluate(() => window.prompter.cmd('pause'));

await op.click('#btnDisplay');
await wait(1500);
const windows = app.windows();
const disp = windows.find((w) => w.url().endsWith('display.html'));
check(!!disp, 'display window opens');
if (disp) {
  await disp.waitForSelector('.pr-text p');
  check((await disp.locator('.pr-text').innerText()).includes('Hello and welcome'), 'display shows the script');
}
check((await op.textContent('#btnDisplay')) === 'Hide Display', 'operator shows the display is open');

// Phone remote on a free port.
const port = 18000 + Math.floor(Math.random() * 2000);
await op.evaluate((p) => window.prompter.updateSettings({ remoteEnabled: true, remotePort: p }), port);
await wait(600);
const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
check(page.includes('Teleprompter Remote'), 'phone remote page is served');
const r = await fetch(`http://127.0.0.1:${port}/api/cmd?c=speed&v=7`).then((x) => x.json()).catch(() => ({}));
check(r.ok && r.state.speed === 7, 'remote API sets the speed');
check((await op.textContent('#speedLabel')) === '7.0', 'operator shows the new speed');
check(/127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|Port/.test(await op.textContent('#remoteInfo')), 'operator shows the remote address');

// Auto-update: on by default; running from source it only reports status.
check(await op.locator('#settings [data-k="autoUpdate"]').isChecked(), 'automatic update checks are on by default');
const up = await op.evaluate(() => window.prompter.updateStatus());
check(up.supported === false && up.auto === true && /^\d+\.\d+\.\d+/.test(up.current), `updater reports status when running from source (v${up.current})`);

// Settings and script are saved for next time.
await op.fill('#editor', '# Saved\nThis should persist.');
await wait(1200);
const saved = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8'));
check(saved.script.text.startsWith('# Saved') && saved.settings.remoteEnabled === true, 'state is saved to disk');

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await app.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall Electron checks passed');
process.exit(failures ? 1 : 0);
