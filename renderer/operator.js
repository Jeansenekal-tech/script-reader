// Operator window: script editor, live preview, transport and display
// settings. State lives in the main process (main/engine.js).
import { PrompterStage, handlePrompterKey } from './stage.js';

const api = window.prompter;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const editor = $('#editor');
const previewEl = $('#preview');
let settings = {};
let transport = {};
let aspect = 16 / 9;
let speedMax = 30;
let lastSentText = null;

const stage = new PrompterStage(previewEl, {
  mirror: false,
  onLayout: (l) => {
    api.setLayout(l);
    renderMarkers();
  },
  onScrub: (p) => api.setPosition(p),
});

// ---------------------------------------------------------------- preview
function fitPreview() {
  const wrap = $('#previewWrap');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  const width = Math.max(120, Math.min(w, h * aspect));
  previewEl.style.width = `${Math.floor(width)}px`;
  previewEl.style.height = `${Math.floor(width / aspect)}px`;
}
new ResizeObserver(fitPreview).observe($('#previewWrap'));

$('#previewMirror').onchange = (e) => {
  stage.opts.mirror = e.target.checked;
  stage.setConfig(settings);
};

// ------------------------------------------------------------- transport
function showTransport(t) {
  transport = t;
  stage.setTransport(t);
  const play = $('#btnPlay');
  play.classList.toggle('playing', t.playing);
  play.textContent = t.playing ? '❚❚ Pause' : t.ended ? '↺ Restart' : '▶ Play';
  $('#speedLabel').textContent = (t.speed < 0 ? '−' : '') + Math.abs(t.speed).toFixed(1);
  if (document.activeElement !== $('#speedRange')) $('#speedRange').value = t.speed;
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.round(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// Progress, time left and the current marker, a few times a second.
setInterval(() => {
  const pos = stage.position();
  const ext = stage.extent;
  const pct = ext > 0 ? pos / ext : 0;
  $('#progress i').style.width = `${(pct * 100).toFixed(2)}%`;
  $('#pctLabel').textContent = `${Math.round(pct * 100)}%`;
  const v = transport.pxPerSecond || 0;
  $('#remainLabel').textContent = v > 0 ? `${fmt((ext - pos) / v)} left` : v < 0 ? `${fmt(pos / -v)} to top` : 'stopped';
  let current = -1;
  stage.markers.forEach((m, i) => {
    if (m.offset <= pos + 2) current = i;
  });
  $$('#markers li[data-i]').forEach((li) => li.classList.toggle('current', Number(li.dataset.i) === current));
}, 200);

$('#progress').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  api.setPosition(((e.clientX - r.left) / r.width) * stage.extent);
};

const cmd = (c, v) => () => api.cmd(c, v);
$('#btnPlay').onclick = cmd('toggle');
$('#btnTop').onclick = cmd('top');
$('#btnPrev').onclick = cmd('prev');
$('#btnNext').onclick = cmd('next');
$('#btnReverse').onclick = cmd('reverse');
$('#btnSlower').onclick = cmd('slower');
$('#btnFaster').onclick = cmd('faster');
$('#speedRange').oninput = (e) => api.cmd('speed', e.target.value);

function renderMarkers() {
  const ol = $('#markers');
  ol.innerHTML = '';
  if (!stage.markers.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Start a line with # to add a marker';
    ol.append(li);
    return;
  }
  stage.markers.forEach((m, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    li.textContent = m.title;
    li.title = `Jump to “${m.title}”`;
    li.onclick = () => api.setPosition(m.offset);
    ol.append(li);
  });
}

// ----------------------------------------------------------------- script
function countWords(text) {
  const words = text.replace(/\[[^\]]*\]/g, ' ').replace(/^\s*#.*$/gm, ' ').match(/\S+/g);
  const n = words ? words.length : 0;
  // About 150 spoken words a minute.
  $('#wordCount').textContent = n ? `${n} words · ~${fmt((n / 150) * 60)} read` : '';
}

let editTimer = null;
editor.addEventListener('input', () => {
  stage.setScript(editor.value);
  countWords(editor.value);
  $('#saveState').textContent = '• edited';
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    lastSentText = editor.value;
    api.setScript({ text: editor.value });
  }, 250);
});

function showScript(s) {
  $('#scriptName').textContent = s.name || 'Untitled';
  $('#scriptName').title = s.file || 'Not saved to a file yet';
  // Ignore the echo of our own edits so typing is never overwritten.
  if (s.text !== lastSentText && s.text !== editor.value) {
    editor.value = s.text;
    stage.setScript(s.text);
    countWords(s.text);
    $('#saveState').textContent = '';
  }
  lastSentText = null;
}

function goToCursor() {
  const line = editor.value.slice(0, editor.selectionStart).split('\n').length - 1;
  api.setPosition(stage.offsetForLine(line));
}
$('#btnGoCursor').onclick = goToCursor;

async function flushEdits() {
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
    lastSentText = editor.value;
    await api.setScript({ text: editor.value });
  }
}

$('#btnNew').onclick = async () => {
  if (await api.newScript()) editor.focus();
};
$('#btnOpen').onclick = () => api.openScript();
async function save(as) {
  await flushEdits();
  if (await api.saveScript(as)) $('#saveState').textContent = '';
}
$('#btnSave').onclick = () => save(false);
$('#btnSaveAs').onclick = () => save(true);

// Drop a text file anywhere to open it.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('#dropHint').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropHint').classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').classList.add('hidden');
  const file = e.dataTransfer.files[0];
  const p = file && api.pathForFile(file);
  if (p) api.openScript(p);
});

// --------------------------------------------------------------- settings
function showSettings(s) {
  settings = s;
  stage.setConfig(s);
  for (const el of $$('#settings [data-k]')) {
    if (document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.dataset.k];
    else el.value = s[el.dataset.k];
  }
  for (const out of $$('#settings output')) {
    const v = s[out.dataset.for];
    out.textContent = `${Number.isInteger(v) ? v : Number(v).toFixed(2).replace(/0$/, '')}${out.dataset.unit || ''}`;
  }
}

for (const el of $$('#settings [data-k]')) {
  const k = el.dataset.k;
  const send = () => {
    const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
    api.updateSettings({ [k]: v });
  };
  el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', send);
}

// ---------------------------------------------------------------- display
async function refreshDisplays() {
  const { displays, selected, aspect: a } = await api.getDisplays();
  const sel = $('#displaySelect');
  sel.innerHTML = '';
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    sel.append(o);
  }
  sel.value = selected;
  aspect = a || 16 / 9;
  fitPreview();
}
$('#displaySelect').onchange = async (e) => {
  await api.updateSettings({ displayId: Number(e.target.value) });
  refreshDisplays();
};
function showDisplayState(open) {
  const b = $('#btnDisplay');
  b.textContent = open ? 'Hide Display' : 'Show Display';
  b.classList.toggle('on', open);
}
$('#btnDisplay').onclick = () => api.toggleDisplay();

// ----------------------------------------------------------------- remote
function showRemote(st) {
  const el = $('#remoteInfo');
  if (st.error) el.textContent = st.error;
  else if (st.running) el.innerHTML = st.urls.length ? st.urls.map((u) => `<b>${u}</b>`).join(' or ') : `Port ${st.port} (no network found)`;
  else el.textContent = 'Off';
  el.classList.toggle('err', !!st.error);
}

// --------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  // Escape leaves the editor so the transport keys work.
  if (e.key === 'Escape') {
    document.activeElement?.blur();
    return;
  }
  const t = e.target;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'range', 'color'].includes(t.type))) return;
  if (t.tagName === 'INPUT' && t.type === 'range' && e.key.startsWith('Arrow')) return;
  handlePrompterKey(e, api, stage);
});

// ------------------------------------------------------------------ start
const cfg = await api.getConfig();
speedMax = cfg.speedMax;
$('#speedRange').min = -speedMax;
$('#speedRange').max = speedMax;
stage.stageWidth = cfg.stageWidth;
aspect = cfg.aspect || aspect;
showSettings(cfg.settings);
editor.value = cfg.script.text;
stage.setScript(cfg.script.text);
countWords(cfg.script.text);
showScript(cfg.script);
showTransport(cfg.transport);
showDisplayState(cfg.displayOpen);
refreshDisplays();
fitPreview();

api.onConfig((c) => showSettings(c.settings));
api.onScript(showScript);
api.onTransport(showTransport);
api.onDisplayState((s) => showDisplayState(s.open));
api.onDisplaysChanged(refreshDisplays);
api.onRemote(showRemote);
api.remoteStatus().then(showRemote);
api.onMenu((what) => {
  if (what === 'save') save(false);
  else if (what === 'saveAs') save(true);
  else if (what === 'goCursor') goToCursor();
});
