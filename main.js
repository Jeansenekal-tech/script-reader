// Unique AV Teleprompter – Electron main process.
// The operator window (script editor, preview, transport) is the main window;
// the talent display goes full screen on any screen.
const { app, BrowserWindow, ipcMain, screen, dialog, Menu, protocol, net, shell, webContents, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { PrompterEngine } = require('./main/engine');
const { RemoteServer } = require('./main/remote');

const APP_NAME = 'Unique AV Teleprompter';
const IS_MAC = process.platform === 'darwin';
const SCHEME = 'prompter';
const UI_ROOT = path.join(__dirname, 'renderer');
const SCRIPT_FILTERS = [{ name: 'Script', extensions: ['txt', 'md', 'text'] }, { name: 'All Files', extensions: ['*'] }];

app.setName(APP_NAME);
// Tests run against a throwaway profile.
if (process.env.PROMPTER_USER_DATA) app.setPath('userData', process.env.PROMPTER_USER_DATA);
// Keep scrolling smooth when windows are covered or on another screen.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let engine = null;
let remote = null;
let operator = null;
let display = null;
let placedKey = '';
let saveTimer = null;
let pendingOpen = null; // file opened from Finder before the app was ready
let quitting = false;

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!engine) return;
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(`${stateFile()}.tmp`, JSON.stringify(engine.saveData(), null, 2));
    fs.renameSync(`${stateFile()}.tmp`, stateFile());
  } catch (e) {
    console.error('Could not save state', e);
  }
}

function broadcast(channel, data) {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && wc.getURL().startsWith(`${SCHEME}://`)) wc.send(channel, data);
  }
}

function sendOperator(channel, data) {
  if (operator && !operator.isDestroyed()) operator.webContents.send(channel, data);
}

function applyRemote() {
  const s = engine.settings;
  if (s.remoteEnabled) {
    if (remote.port !== s.remotePort) remote.start(s.remotePort);
  } else if (remote.port !== null) remote.stop();
  // listen() reports a busy port asynchronously.
  setTimeout(() => sendOperator('pr:remote', remote.status), 300);
}

// --------------------------------------------------------------- displays
function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => {
    const name = d.label || (d.internal ? 'Built-in display' : `Display ${i + 1}`);
    return { id: d.id, name: `${name} — ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (main)' : ''}`, primary: d.id === primary.id };
  });
}

function targetDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id === engine.settings.displayId) || all.find((d) => d.id !== primary.id) || primary;
}

function displayAspect() {
  const d = targetDisplay();
  return d.size.width / d.size.height;
}

// Full screen on the chosen screen, or a floating window when there is only
// one screen (or "In a window" is ticked).
function placeDisplay() {
  const w = display;
  if (!w || w.isDestroyed()) return { open: false };
  const d = targetDisplay();
  const windowed = engine.settings.displayWindowed || screen.getAllDisplays().length < 2 || d.id === screen.getPrimaryDisplay().id;
  const key = `${d.id}|${windowed}|${JSON.stringify(d.bounds)}`;
  if (key === placedKey && w.isVisible()) return { open: true, windowed };
  placedKey = key;
  if (IS_MAC) w.setSimpleFullScreen(false);
  else w.setFullScreen(false);
  if (windowed) {
    const wa = d.workArea;
    const width = Math.min(960, wa.width);
    const height = Math.min(Math.round((width * 9) / 16), wa.height);
    w.setResizable(true);
    w.setAlwaysOnTop(true, 'floating');
    w.setBounds({ x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height });
  } else {
    w.setBounds(d.bounds);
    w.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) w.setSimpleFullScreen(true);
    else w.setFullScreen(true);
  }
  if (!w.isVisible()) w.showInactive();
  return { open: true, windowed };
}

function openDisplay() {
  if (display && !display.isDestroyed()) return placeDisplay();
  display = new BrowserWindow({
    show: false,
    frame: false,
    title: 'Prompter Display',
    backgroundColor: engine.settings.bgColor || '#000000',
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  placedKey = '';
  display.once('ready-to-show', placeDisplay);
  display.on('closed', () => {
    display = null;
    placedKey = '';
    sendOperator('pr:display:state', { open: false });
  });
  display.loadURL(`${SCHEME}://app/display.html`);
  sendOperator('pr:display:state', { open: true });
  return { open: true };
}

function closeDisplay() {
  if (display && !display.isDestroyed()) display.close();
  return { open: false };
}

function toggleDisplay() {
  return display && !display.isDestroyed() ? closeDisplay() : openDisplay();
}

// ---------------------------------------------------------------- operator
function createOperator() {
  operator = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#121418',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  operator.once('ready-to-show', () => operator.show());
  operator.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  operator.on('closed', () => {
    operator = null;
    // The operator is the app: closing it closes the display too.
    closeDisplay();
    if (!IS_MAC) app.quit();
  });
  operator.loadURL(`${SCHEME}://app/operator.html`);
  if (process.argv.includes('--dev')) operator.webContents.openDevTools({ mode: 'detach' });
}

function showOperator() {
  if (!operator || operator.isDestroyed()) createOperator();
  else {
    operator.show();
    operator.focus();
  }
}

// ----------------------------------------------------------------- scripts
const parentWin = () => (operator && !operator.isDestroyed() ? operator : undefined);

async function openScript(file) {
  let p = file;
  if (!p) {
    const r = await dialog.showOpenDialog(parentWin(), { title: 'Open Script', filters: SCRIPT_FILTERS, properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    p = r.filePaths[0];
  }
  try {
    const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    engine.setScript({ text, name: path.basename(p).replace(/\.[^.]+$/, ''), file: p });
    engine.setPosition(0);
    app.addRecentDocument(p);
    return engine.script;
  } catch (e) {
    dialog.showErrorBox("Couldn't open the script", e.message);
    return null;
  }
}

async function saveScript(saveAs) {
  const s = engine.script;
  let p = saveAs ? null : s.file;
  if (!p) {
    const r = await dialog.showSaveDialog(parentWin(), { title: 'Save Script', defaultPath: `${s.name || 'Script'}.txt`, filters: SCRIPT_FILTERS });
    if (r.canceled || !r.filePath) return null;
    p = r.filePath;
  }
  try {
    fs.writeFileSync(p, s.text, 'utf8');
    engine.setScript({ name: path.basename(p).replace(/\.[^.]+$/, ''), file: p });
    app.addRecentDocument(p);
    return engine.script;
  } catch (e) {
    dialog.showErrorBox("Couldn't save the script", e.message);
    return null;
  }
}

async function newScript() {
  const { response } = await dialog.showMessageBox(parentWin(), {
    type: 'question',
    buttons: ['New Script', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Start a new script?',
    detail: 'The current script will be cleared. Save it first if you need it.',
  });
  if (response === 0) engine.newScript();
  return response === 0;
}

// --------------------------------------------------------------------- IPC
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(`pr:${ch}`, fn);
  h('config:get', () => ({ ...engine.getConfig(), displayOpen: !!(display && !display.isDestroyed()), aspect: displayAspect(), version: app.getVersion() }));
  h('cmd', (_e, c, v) => engine.perform(c, v));
  h('settings:update', (_e, patch) => engine.updateSettings(patch));
  h('script:set', (_e, s) => engine.setScript(s));
  h('script:new', () => newScript());
  h('script:open', (_e, file) => openScript(file));
  h('script:save', (_e, saveAs) => saveScript(!!saveAs));
  h('layout', (_e, l) => engine.setLayout(l));
  h('position', (_e, p) => engine.setPosition(p));
  h('displays:get', () => ({ displays: displayList(), selected: targetDisplay().id, aspect: displayAspect() }));
  h('display:toggle', () => toggleDisplay());
  h('display:close', () => closeDisplay());
  h('remote:status', () => remote.status);
}

// -------------------------------------------------------------------- menu
function buildMenu() {
  const cmd = (c, v) => () => engine.perform(c, v);
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Script', accelerator: 'CmdOrCtrl+N', click: () => newScript() },
        { label: 'Open Script…', accelerator: 'CmdOrCtrl+O', click: () => openScript() },
        ...(IS_MAC ? [{ role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] }] : []),
        { type: 'separator' },
        { label: 'Save Script', accelerator: 'CmdOrCtrl+S', click: () => sendOperator('pr:menu', 'save') },
        { label: 'Save Script As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendOperator('pr:menu', 'saveAs') },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Prompter',
      submenu: [
        { label: 'Show / Hide Display', accelerator: 'CmdOrCtrl+D', click: () => toggleDisplay() },
        { type: 'separator' },
        // Single keys (Space, arrows, Page Up/Down) also work when the editor isn't focused.
        { label: 'Play / Pause', accelerator: 'CmdOrCtrl+Enter', click: cmd('toggle') },
        { label: 'Faster', accelerator: 'CmdOrCtrl+]', click: cmd('faster') },
        { label: 'Slower', accelerator: 'CmdOrCtrl+[', click: cmd('slower') },
        { label: 'Reverse Direction', click: cmd('reverse') },
        { type: 'separator' },
        { label: 'Back to Top', click: cmd('top') },
        { label: 'Next Marker', accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next') },
        { label: 'Previous Marker', accelerator: 'CmdOrCtrl+Shift+[', click: cmd('prev') },
        { label: 'Go to Text Cursor', accelerator: 'CmdOrCtrl+J', click: () => sendOperator('pr:menu', 'goCursor') },
        { type: 'separator' },
        { label: 'Mirror Display', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('mirror') },
        { label: 'Larger Text', accelerator: 'CmdOrCtrl+=', click: cmd('fontsize', '+4') },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: cmd('fontsize', '-4') },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------- start
// Double-clicking a script in Finder / "Open With".
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (engine) {
    openScript(file);
    showOperator();
  } else pendingOpen = file;
});

// Windows/Linux: one instance; a second launch with a file opens it here.
if (!IS_MAC && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const file = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
  if (file) openScript(file);
  showOperator();
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'operator.html';
    const file = path.normalize(path.join(UI_ROOT, rel));
    if (!file.startsWith(UI_ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  engine = new PrompterEngine(loadState());
  remote = new RemoteServer({ state: () => engine.snapshot(), command: (c, v) => engine.perform(c, v) });
  engine.on('transport', (t) => broadcast('pr:transport', t));
  engine.on('config', () => {
    broadcast('pr:config', engine.getConfig());
    placeDisplay();
    applyRemote();
    scheduleSave();
  });
  engine.on('script', () => {
    broadcast('pr:script', engine.script);
    scheduleSave();
  });
  setInterval(() => engine.tick(), 100);
  applyRemote();

  const onDisplays = () => {
    placedKey = '';
    placeDisplay();
    sendOperator('pr:displays:changed');
  };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);

  if (IS_MAC && app.dock) {
    const icon = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(icon)) app.dock.setIcon(nativeImage.createFromPath(icon));
  }
  registerIpc();
  buildMenu();
  createOperator();

  const argFile = process.argv.slice(1).find((a) => /\.(txt|md|text)$/i.test(a) && fs.existsSync(a));
  if (pendingOpen || argFile) openScript(pendingOpen || argFile);

  app.on('activate', () => {
    if (!operator) createOperator();
  });
});

app.on('before-quit', () => {
  quitting = true;
  saveNow();
  remote?.stop();
});

app.on('window-all-closed', () => {
  if (!IS_MAC || quitting) app.quit();
});
