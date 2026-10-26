// Auto-update for macOS and Windows.
//
// Each release publishes an `update.json` manifest next to the installers
// (see scripts/make-update-manifest.mjs). The updater:
//   1. fetches the manifest and compares versions,
//   2. downloads this platform's package and verifies its SHA-512,
//   3. installs it after the app quits:
//      - Mac: unpacks the .zip with `ditto` and swaps the app bundle in place
//        (works for unsigned builds, which Squirrel.Mac refuses);
//      - Windows: runs the NSIS installer silently.
// It never restarts on its own: the operator chooses when, and an update
// that is ready installs the next time the app quits.
const { app, net, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST = 'update.json';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

function parseVersion(v) {
  const [core, pre] = String(v).replace(/^v/, '').split('-');
  return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
}

function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0);
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 1.2.0 > 1.2.0-beta
  if (!y.pre) return false;
  return x.pre > y.pre;
}

// The package to install on this platform/architecture.
function pickFile(manifest, platform = process.platform, arch = process.arch) {
  const files = manifest.files || [];
  if (platform === 'win32') return files.find((f) => f.platform === 'win' && /\.exe$/i.test(f.name));
  if (platform !== 'darwin') return undefined;
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const mac = files.filter((f) => f.platform === 'mac' && /\.zip$/i.test(f.name));
  return mac.find((f) => f.arch === a) || mac.find((f) => f.arch === 'universal');
}

function joinUrl(base, name) {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

class Updater {
  constructor({ defaultUrl, send, isBusy, log }) {
    this.defaultUrl = defaultUrl;
    this.send = send;
    this.isBusy = isBusy;
    this.log = log || (() => {});
    this.config = { auto: true };
    this.state = { status: 'idle', current: app.getVersion() };
    this.timer = null;
    this.ready = null; // { kind: 'mac', app } | { kind: 'win', exe }
    this.platform = process.platform;
    this.arch = process.arch;
    this.installing = false;
  }

  get feedUrl() {
    return (this.defaultUrl || '').trim();
  }

  get supported() {
    return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
  }

  set(patch) {
    this.state = { ...this.state, ...patch, current: app.getVersion() };
    this.send(this.status());
  }

  status() {
    return { ...this.state, supported: this.supported, auto: this.config.auto };
  }

  configure(cfg) {
    this.config = { ...this.config, ...cfg };
    clearInterval(this.timer);
    this.timer = null;
    if (this.config.auto && this.feedUrl) {
      this.timer = setInterval(() => this.check(false), CHECK_INTERVAL);
      if (!this.firstCheckDone) {
        this.firstCheckDone = true;
        setTimeout(() => this.check(false), 15000);
      }
    }
    return this.status();
  }

  async fetchManifest() {
    const res = await net.fetch(`${joinUrl(this.feedUrl, MANIFEST)}?t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
    if (res.status === 404) throw new Error('No published release was found.');
    if (!res.ok) throw new Error(`The update server returned HTTP ${res.status}`);
    const m = await res.json();
    if (!m || !m.version || !Array.isArray(m.files)) throw new Error('Invalid update manifest');
    return m;
  }

  async check(manual = true) {
    if (!this.feedUrl) {
      this.set({ status: 'error', error: 'No update URL configured', manual });
      return this.status();
    }
    if (['checking', 'downloading', 'ready', 'installing'].includes(this.state.status)) return this.status();
    this.set({ status: 'checking', error: null, manual });
    try {
      const m = await this.fetchManifest();
      this.manifest = m;
      if (!isNewer(m.version, app.getVersion())) {
        this.set({ status: 'uptodate', latest: m.version, checkedAt: Date.now() });
        return this.status();
      }
      const file = pickFile(m, this.platform, this.arch);
      this.set({ status: 'available', latest: m.version, notes: m.notes || '', size: file?.size, checkedAt: Date.now() });
      if (this.supported && file) await this.download();
    } catch (e) {
      this.log(`Update check failed: ${e.message}`);
      this.set({ status: 'error', error: e.message });
    }
    return this.status();
  }

  // Running from source (or an unsupported OS): open the release page instead.
  openReleasePage() {
    shell.openExternal(this.feedUrl.replace(/\/latest\/download\/?$/, '/latest').replace(/\/download\/?$/, '')).catch(() => {});
  }

  async download() {
    if (!this.supported) {
      this.openReleasePage();
      return this.status();
    }
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.status();
    const m = this.manifest || (await this.fetchManifest());
    const file = pickFile(m, this.platform, this.arch);
    if (!file) {
      this.set({ status: 'error', error: `No update package for ${this.platform} ${this.arch}` });
      return this.status();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uatp-update-'));
    const dest = path.join(dir, file.name);
    this.set({ status: 'downloading', progress: 0, latest: m.version });
    try {
      const res = await net.fetch(joinUrl(this.feedUrl, file.name), { redirect: 'follow', cache: 'no-store' });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || file.size || 0;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(dest);
      const reader = res.body.getReader();
      let got = 0;
      let lastSent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastSent > 250) {
          lastSent = Date.now();
          this.set({ progress: total ? got / total : 0 });
        }
      }
      await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
      if (file.sha512 && hash.digest('base64') !== file.sha512) throw new Error('The downloaded update failed its integrity check');

      if (this.platform === 'darwin') {
        const extractDir = path.join(dir, 'app');
        fs.mkdirSync(extractDir);
        await run('/usr/bin/ditto', ['-x', '-k', dest, extractDir]);
        const bundle = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
        if (!bundle) throw new Error('The update package does not contain an app');
        const newApp = path.join(extractDir, bundle);
        await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});
        fs.unlinkSync(dest);
        this.ready = { kind: 'mac', app: newApp, dir };
      } else {
        this.ready = { kind: 'win', exe: dest, dir };
      }
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.log(`Update download failed: ${e.message}`);
      fs.rmSync(dir, { recursive: true, force: true });
      this.set({ status: 'error', error: e.message });
    }
    return this.status();
  }

  currentBundle() {
    // …/Name.app/Contents/MacOS/Name  →  …/Name.app
    return path.resolve(path.dirname(process.execPath), '..', '..');
  }

  canReplaceMac() {
    const bundle = this.currentBundle();
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      fs.accessSync(bundle, fs.constants.W_OK);
      return !bundle.startsWith('/Volumes/') && !bundle.includes('/AppTranslocation/');
    } catch {
      return false;
    }
  }

  // Installs once this process exits; the caller then quits the app.
  install({ relaunch = true, force = false } = {}) {
    if (!this.ready || this.installing) return { ok: false, message: 'No update is ready.' };
    if (!force && this.isBusy()) return { ok: false, message: 'Pause the prompter before updating.' };
    if (this.ready.kind === 'mac') {
      if (!this.canReplaceMac()) {
        const dmg = (this.manifest?.files || []).find((f) => f.platform === 'mac' && f.arch === (process.arch === 'arm64' ? 'arm64' : 'x64') && /\.dmg$/i.test(f.name));
        if (dmg) shell.openExternal(joinUrl(this.feedUrl, dmg.name)).catch(() => {});
        return { ok: false, message: 'The app can’t update itself from this location. Move it to the Applications folder. The new installer has been opened in your browser.' };
      }
      const script = path.join(os.tmpdir(), `uatp-install-${Date.now()}.sh`);
      fs.writeFileSync(script, `#!/bin/sh
APP="$1"; NEW="$2"; PID="$3"; RELAUNCH="$4"; WORK="$5"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
BAK="$APP.old-$$"
if mv "$APP" "$BAK"; then
  if /usr/bin/ditto "$NEW" "$APP"; then rm -rf "$BAK"; else rm -rf "$APP"; mv "$BAK" "$APP"; fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
case "$WORK" in */uatp-update-*) rm -rf "$WORK" ;; esac
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$APP"
rm -f "$0"
`, { mode: 0o755 });
      spawn('/bin/sh', [script, this.currentBundle(), this.ready.app, String(process.pid), relaunch ? '1' : '0', this.ready.dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Wait for this process to exit, then run the installer silently.
      // --force-run makes the NSIS installer start the app again afterwards.
      const args = relaunch ? "'/S','--updated','--force-run'" : "'/S','--updated'";
      const ps = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '${this.ready.exe.replace(/'/g, "''")}' -ArgumentList ${args}`;
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    this.installing = true;
    this.set({ status: 'installing' });
    return { ok: true };
  }
}

module.exports = { Updater, isNewer, pickFile };
