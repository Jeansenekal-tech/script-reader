// Teleprompter engine: the script, display settings and the scroll transport.
// No Electron here so it can be unit-tested (test/engine-test.cjs).
//
// Positions are in "stage pixels": every prompter view lays the script out on
// a stage STAGE_WIDTH pixels wide and scales it to fit, so a line wraps the
// same way on the talent display and in the operator preview. Position 0 puts
// the first line on the reading line; `extent` (reported by the views) puts
// the last one there.
const { EventEmitter } = require('events');

const STAGE_WIDTH = 1600;
const SPEED_MAX = 30;
// Stage pixels per second for each speed step at the default font size. The
// rate follows the font size so a given speed reads the same number of lines.
const PX_PER_STEP = 12;
const BASE_FONT = 72;

const DEFAULT_SETTINGS = {
  fontSize: BASE_FONT,
  lineHeight: 1.45,
  margin: 8, // % of the stage width on each side
  fontFamily: 'system',
  align: 'left',
  uppercase: false,
  textColor: '#ffffff',
  cueColor: '#ffd23f',
  markerColor: '#5cc8ff',
  bgColor: '#000000',
  mirror: false, // horizontal – for beam-splitter glass
  flip: false, // vertical
  guide: 30, // reading line, % from the top
  guideVisible: true,
  defaultSpeed: 4,
  speedStep: 0.5,
  displayId: null,
  displayWindowed: false,
  remoteEnabled: false, // phone / tablet remote over the local network
  remotePort: 8090,
  autoUpdate: true,
};

const DEFAULT_SCRIPT = `# Welcome
Welcome to the Unique AV teleprompter. Type or paste your script on the left, or open a text file.

[Smile – look into the lens]

Press Space to start and stop. The down arrow speeds up, the up arrow slows down. Page Up and Page Down jump a screen, and Home goes back to the top.

# Formatting
A line that starts with a hash sign becomes a marker. Markers are listed beside the preview, and the left and right arrows jump between them.

Text in [square brackets] is a cue for the presenter. It is shown in a different colour.

# Showing the script
Click Show Display to put the prompter on another screen. Turn on Mirror for teleprompter glass.
`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, step) => Math.round(v / step) * step;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function normaliseSettings(s = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] !== undefined) out[k] = s[k];
  out.fontSize = clamp(Number(out.fontSize) || BASE_FONT, 16, 300);
  out.lineHeight = clamp(Number(out.lineHeight) || 1.45, 1, 3);
  out.margin = clamp(Number(out.margin) || 0, 0, 40);
  out.guide = clamp(Number(out.guide) || 0, 5, 90);
  out.defaultSpeed = clamp(Number(out.defaultSpeed) || 0, 0, SPEED_MAX);
  out.speedStep = clamp(Number(out.speedStep) || 0.5, 0.1, 5);
  if (!['left', 'center', 'right', 'justify'].includes(out.align)) out.align = 'left';
  out.remotePort = Math.round(clamp(Number(out.remotePort) || 8090, 1024, 65535));
  for (const k of ['uppercase', 'mirror', 'flip', 'guideVisible', 'displayWindowed', 'remoteEnabled', 'autoUpdate']) out[k] = !!out[k];
  return out;
}

class PrompterEngine extends EventEmitter {
  constructor(state = {}, now = () => Date.now()) {
    super();
    this.now = now;
    this.settings = normaliseSettings(state.settings);
    this.script = { text: typeof state.script?.text === 'string' ? state.script.text : DEFAULT_SCRIPT, name: state.script?.name || 'Untitled', file: state.script?.file || null };
    this.extent = 0;
    this.layoutMarkers = [];
    this.playing = false;
    this.speed = this.settings.defaultSpeed;
    this.basePos = 0;
    this.baseAt = this.now();
    this.ended = false;
  }

  // ------------------------------------------------------------ transport
  pxPerSecond() {
    return this.speed * PX_PER_STEP * (this.settings.fontSize / BASE_FONT);
  }

  position() {
    const p = this.playing ? this.basePos + (this.pxPerSecond() * (this.now() - this.baseAt)) / 1000 : this.basePos;
    return clamp(p, 0, this.extent);
  }

  // Freeze the current position as the new base before changing speed/state.
  rebase() {
    this.basePos = this.position();
    this.baseAt = this.now();
  }

  // Stops at either end of the script. Called a few times a second.
  tick() {
    if (!this.playing) return;
    const v = this.pxPerSecond();
    const p = this.basePos + (v * (this.now() - this.baseAt)) / 1000;
    if ((v > 0 && p >= this.extent) || (v < 0 && p <= 0)) {
      this.rebase();
      this.playing = false;
      this.ended = v > 0;
      this.changed();
    }
  }

  setPosition(p) {
    this.basePos = clamp(Number(p) || 0, 0, this.extent);
    this.baseAt = this.now();
    this.ended = false;
    this.changed();
  }

  setSpeed(v) {
    this.rebase();
    this.speed = clamp(round(Number(v) || 0, 0.1), -SPEED_MAX, SPEED_MAX);
    this.changed();
  }

  play() {
    if (this.playing) return;
    if (this.speed === 0) this.speed = this.settings.defaultSpeed || 1;
    // Starting again at the end goes back to the top.
    if (this.speed > 0 && this.position() >= this.extent && this.extent > 0) this.basePos = 0;
    this.baseAt = this.now();
    this.playing = true;
    this.ended = false;
    this.changed();
  }

  pause() {
    if (!this.playing) return;
    this.rebase();
    this.playing = false;
    this.changed();
  }

  markerOffsets() {
    return this.layoutMarkers.map((m) => m.offset).sort((a, b) => a - b);
  }

  gotoMarker(dir) {
    const pos = this.position();
    const offs = this.markerOffsets();
    let target;
    if (dir > 0) target = offs.find((o) => o > pos + 2);
    else target = [...offs].reverse().find((o) => o < pos - 2);
    if (target === undefined) target = dir > 0 ? this.extent : 0;
    this.setPosition(target);
  }

  // Marker by number (1-based) or title.
  gotoMarkerNamed(v) {
    const list = this.layoutMarkers;
    const n = Number(v);
    const m = Number.isInteger(n) && n >= 1 ? list[n - 1] : list.find((x) => x.title.toLowerCase() === String(v).toLowerCase());
    if (!m) return false;
    this.setPosition(m.offset);
    return true;
  }

  // Commands shared by the operator, the display, the menu and the mixer API.
  perform(cmd, value) {
    const c = String(cmd || '').toLowerCase();
    const s = this.settings;
    const has = value !== undefined && value !== null && value !== '';
    switch (c) {
      case 'play': case 'start': this.play(); break;
      case 'pause': case 'stop': this.pause(); break;
      case 'toggle': if (this.playing) this.pause(); else this.play(); break;
      case 'faster': this.setSpeed(this.speed + (has ? Number(value) : s.speedStep)); break;
      case 'slower': this.setSpeed(this.speed - (has ? Number(value) : s.speedStep)); break;
      case 'speed': this.setSpeed(/^[+-]/.test(String(value)) ? this.speed + Number(value) : value); break;
      case 'reverse': this.setSpeed(-this.speed); break;
      case 'top': this.setPosition(0); break;
      case 'end': this.setPosition(this.extent); break;
      // Value = stage pixels, or "50%" of the script.
      case 'jump': {
        const str = String(value ?? '');
        const pct = /%$/.test(str);
        const n = parseFloat(str);
        if (Number.isNaN(n)) return false;
        const amount = pct ? (n / 100) * this.extent : n;
        this.setPosition(/^[+-]/.test(str) ? this.position() + amount : amount);
        break;
      }
      case 'nudge': this.setPosition(this.position() + (Number(value) || 0)); break;
      case 'next': this.gotoMarker(1); break;
      case 'prev': case 'previous': this.gotoMarker(-1); break;
      case 'marker': return this.gotoMarkerNamed(value);
      case 'mirror': this.updateSettings({ mirror: has ? /^(1|true|on|yes)$/i.test(String(value)) : !s.mirror }); break;
      case 'flip': this.updateSettings({ flip: has ? /^(1|true|on|yes)$/i.test(String(value)) : !s.flip }); break;
      case 'fontsize': {
        const str = String(value ?? '');
        this.updateSettings({ fontSize: /^[+-]/.test(str) ? s.fontSize + Number(str) : Number(str) });
        break;
      }
      default: return false;
    }
    return true;
  }

  // -------------------------------------------------------------- content
  updateSettings(patch = {}) {
    this.rebase();
    this.settings = normaliseSettings({ ...this.settings, ...patch });
    this.emit('config');
    this.changed();
    return this.settings;
  }

  setScript({ text, name, file } = {}) {
    if (typeof text === 'string') this.script.text = text;
    if (name !== undefined) this.script.name = name || 'Untitled';
    if (file !== undefined) this.script.file = file || null;
    this.emit('script');
    return this.script;
  }

  newScript() {
    this.setScript({ text: '', name: 'Untitled', file: null });
    this.setPosition(0);
  }

  // The views measure the laid-out script and report its height and the
  // marker positions. A change of height (new font size, edited text) keeps
  // the reader at the same proportion of the script.
  setLayout({ extent, markers } = {}) {
    const e = Math.max(0, Number(extent) || 0);
    const list = Array.isArray(markers) ? markers.map((m) => ({ title: String(m.title || ''), offset: Math.max(0, Number(m.offset) || 0) })) : [];
    if (e === this.extent && JSON.stringify(list) === JSON.stringify(this.layoutMarkers)) return false;
    const pos = this.position();
    const old = this.extent;
    this.extent = e;
    this.layoutMarkers = list;
    this.basePos = clamp(old > 0 ? (pos / old) * e : pos, 0, e);
    this.baseAt = this.now();
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- state
  transport() {
    const pos = this.position();
    const v = this.pxPerSecond();
    return {
      playing: this.playing,
      speed: this.speed,
      pxPerSecond: v,
      position: pos,
      at: this.now(),
      extent: this.extent,
      ended: this.ended,
      progress: this.extent > 0 ? pos / this.extent : 0,
      remaining: v > 0 ? (this.extent - pos) / v : (this.speed === 0 && this.extent - pos > 0 ? Infinity : 0),
    };
  }

  // Short status for the mixer's top bar and the API.
  snapshot() {
    const t = this.transport();
    return {
      playing: t.playing,
      speed: t.speed,
      progress: Math.round(t.progress * 1000) / 10,
      remaining: formatDuration(t.remaining),
      name: this.script.name,
      markers: this.layoutMarkers.length,
    };
  }

  getConfig() {
    return { settings: this.settings, script: this.script, stageWidth: STAGE_WIDTH, speedMax: SPEED_MAX, transport: this.transport(), markers: this.layoutMarkers };
  }

  saveData() {
    return { settings: this.settings, script: this.script };
  }

  changed() {
    this.emit('transport', this.transport());
  }
}

module.exports = { PrompterEngine, DEFAULT_SETTINGS, STAGE_WIDTH, SPEED_MAX, formatDuration, normaliseSettings };
