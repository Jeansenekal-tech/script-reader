// Updater tests without Electron: version logic, manifest generation, and
// check + verified download against a local update server.
//   node test/updater-test.mjs
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Stand-in for the parts of Electron the updater uses.
const opened = [];
const electronMock = {
  app: { getVersion: () => '1.0.0', isPackaged: false },
  net: { fetch: (...a) => fetch(...a) },
  shell: { openExternal: async (u) => opened.push(u) },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electronMock : load.call(this, request, ...rest);
};
const { Updater, isNewer, pickFile } = require('../main/updater.js');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

// ------------------------------------------------------------ versions
check(isNewer('1.0.1', '1.0.0'), '1.0.1 > 1.0.0');
check(isNewer('1.10.0', '1.9.9'), '1.10.0 > 1.9.9 (numeric, not string)');
check(isNewer('v2.0.0', '1.99.99'), 'v-prefixed tags');
check(!isNewer('1.0.0', '1.0.0'), 'same version is not newer');
check(!isNewer('1.0.0', '1.0.1'), 'older is not newer');
check(isNewer('1.2.0', '1.2.0-beta.1'), 'release > its prerelease');
check(!isNewer('1.2.0-beta.1', '1.2.0'), 'prerelease < release');

// ------------------------------------------------------------ manifest
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
const names = [
  'Unique-AV-Teleprompter-1.2.3-arm64.zip',
  'Unique-AV-Teleprompter-1.2.3-x64.zip',
  'Unique-AV-Teleprompter-1.2.3-arm64.dmg',
  'Unique-AV-Teleprompter-1.2.3-Setup.exe',
  'Unique-AV-Teleprompter-1.0.0-x64.zip',
  'Unique-AV-Teleprompter-1.2.30-x64.zip',
];
for (const n of names) fs.writeFileSync(path.join(dir, n), `content of ${n}`);
fs.writeFileSync(path.join(dir, 'notes.txt'), 'Bug fixes\n');
execFileSync('node', [path.join(root, 'scripts/make-update-manifest.mjs'), dir, 'v1.2.3', path.join(dir, 'notes.txt')]);
const m = JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8'));
check(m.version === '1.2.3', 'manifest version from the tag');
check(m.files.length === 4, `only this version’s files (got ${m.files.length})`);
check(m.notes === 'Bug fixes', 'release notes included');
const exe = m.files.find((f) => f.platform === 'win');
check(exe && exe.name.endsWith('Setup.exe'), 'Windows installer listed');
check(exe && exe.sha512 === crypto.createHash('sha512').update(`content of ${exe.name}`).digest('base64'), 'sha512 matches the file');
check(pickFile(m, 'darwin', 'arm64')?.name === 'Unique-AV-Teleprompter-1.2.3-arm64.zip', 'Apple Silicon gets the arm64 zip');
check(pickFile(m, 'darwin', 'x64')?.name === 'Unique-AV-Teleprompter-1.2.3-x64.zip', 'Intel Mac gets the x64 zip');
check(pickFile(m, 'win32', 'x64')?.name === 'Unique-AV-Teleprompter-1.2.3-Setup.exe', 'Windows gets the Setup.exe');
check(pickFile(m, 'linux', 'x64') === undefined, 'no package for Linux');

// ------------------------------------------------------- check/download
let served = m;
let corrupt = false;
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  if (name === 'update.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(served));
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const buf = corrupt ? Buffer.from('tampered') : fs.readFileSync(file);
  res.writeHead(200, { 'Content-Length': buf.length }).end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${server.address().port}`;

const make = () => {
  const statuses = [];
  const u = new Updater({ defaultUrl: feed, send: (st) => statuses.push(st.status), isBusy: () => false });
  return { u, statuses };
};

{
  const { u } = make();
  served = { ...m, version: '1.0.0' };
  const st = await u.check(true);
  check(st.status === 'uptodate', 'same version → up to date');
}
{
  const { u } = make();
  served = m;
  const st = await u.check(true);
  check(st.status === 'available' && st.latest === '1.2.3' && st.notes === 'Bug fixes', 'newer version → available (running from source: no download)');
  await u.download();
  check(opened.length === 1 && opened[0].startsWith(feed), 'from source, Download opens the release page');
}
{
  const { u, statuses } = make();
  Object.defineProperty(u, 'supported', { value: true });
  u.platform = 'win32';
  const st = await u.check(false);
  check(st.status === 'ready', `Windows build downloads and verifies the installer (status ${st.status})`);
  check(statuses.includes('downloading'), 'reports download progress');
  check(u.ready?.kind === 'win' && fs.readFileSync(u.ready.exe, 'utf8') === `content of ${exe.name}`, 'installer saved intact');
  const again = await u.check(false);
  check(again.status === 'ready', 'a ready update is not checked again');
  const busy = new Updater({ defaultUrl: feed, send: () => {}, isBusy: () => true });
  busy.ready = u.ready;
  check(busy.install().ok === false, 'refuses to install while the prompter scrolls');
  fs.rmSync(u.ready.dir, { recursive: true, force: true });
}
{
  const { u } = make();
  Object.defineProperty(u, 'supported', { value: true });
  u.platform = 'win32';
  corrupt = true;
  const st = await u.check(false);
  check(st.status === 'error' && /integrity/.test(st.error), 'a tampered download is rejected');
  corrupt = false;
}
{
  const u = new Updater({ defaultUrl: `${feed}/missing`, send: () => {}, isBusy: () => false });
  const st = await u.check(true);
  check(st.status === 'error', 'a missing manifest is reported as an error');
}

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall updater checks passed');
process.exit(failures ? 1 : 0);
