// Engine logic tests – no Electron needed:  node test/engine-test.cjs
const assert = require('assert');
const { PrompterEngine, normaliseSettings, formatDuration } = require('../main/engine');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.stack}`);
    process.exitCode = 1;
  }
}

function make(state = {}) {
  let t = 1_000_000;
  const e = new PrompterEngine(state, () => t);
  e.setLayout({ extent: 1200, markers: [{ title: 'A', offset: 0 }, { title: 'B', offset: 400 }, { title: 'C', offset: 900 }] });
  return { e, advance: (s) => { t += s * 1000; e.tick(); } };
}

test('formatDuration', () => {
  assert.strictEqual(formatDuration(0), '00:00');
  assert.strictEqual(formatDuration(75), '01:15');
  assert.strictEqual(formatDuration(3725), '1:02:05');
  assert.strictEqual(formatDuration(Infinity), '--:--');
});

test('settings are clamped and defaulted', () => {
  const s = normaliseSettings({ fontSize: 5, guide: 200, align: 'weird', mirror: 1, remotePort: 80 });
  assert.strictEqual(s.fontSize, 16);
  assert.strictEqual(s.guide, 90);
  assert.strictEqual(s.align, 'left');
  assert.strictEqual(s.mirror, true);
  assert.strictEqual(s.remotePort, 1024);
  assert.strictEqual(s.lineHeight, 1.45);
});

test('plays at speed × 12 px/s at the default font size', () => {
  const { e, advance } = make();
  e.setSpeed(5);
  e.play();
  advance(2);
  assert.strictEqual(e.position(), 120);
  e.pause();
  advance(5);
  assert.strictEqual(e.position(), 120);
});

test('speed follows font size', () => {
  const { e, advance } = make({ settings: { fontSize: 144 } });
  e.setSpeed(5);
  e.play();
  advance(1);
  assert.strictEqual(e.position(), 120);
});

test('changing speed while playing keeps the position', () => {
  const { e, advance } = make();
  e.setSpeed(5);
  e.play();
  advance(1); // 60
  e.perform('faster', 5); // speed 10
  advance(1); // +120
  assert.strictEqual(e.position(), 180);
});

test('stops at the end and restarts from the top', () => {
  const { e, advance } = make();
  e.setSpeed(10);
  e.play();
  advance(20);
  assert.strictEqual(e.playing, false);
  assert.strictEqual(e.ended, true);
  assert.strictEqual(e.position(), 1200);
  e.play();
  assert.strictEqual(e.position(), 0);
  assert.strictEqual(e.playing, true);
});

test('reverse scrolls back and stops at the top', () => {
  const { e, advance } = make();
  e.setPosition(300);
  e.setSpeed(5);
  e.perform('reverse');
  assert.strictEqual(e.speed, -5);
  e.play();
  advance(2);
  assert.strictEqual(e.position(), 180);
  advance(10);
  assert.strictEqual(e.position(), 0);
  assert.strictEqual(e.playing, false);
  assert.strictEqual(e.ended, false);
});

test('marker navigation', () => {
  const { e } = make();
  e.perform('next');
  assert.strictEqual(e.position(), 400);
  e.perform('next');
  assert.strictEqual(e.position(), 900);
  e.perform('next');
  assert.strictEqual(e.position(), 1200);
  e.perform('prev');
  assert.strictEqual(e.position(), 900);
  assert.strictEqual(e.perform('marker', 'b'), true);
  assert.strictEqual(e.position(), 400);
  assert.strictEqual(e.perform('marker', 1), true);
  assert.strictEqual(e.position(), 0);
  assert.strictEqual(e.perform('marker', 'nope'), false);
});

test('jump: absolute, relative and percent', () => {
  const { e } = make();
  e.perform('jump', '50%');
  assert.strictEqual(e.position(), 600);
  e.perform('jump', '+100');
  assert.strictEqual(e.position(), 700);
  e.perform('jump', '-1000');
  assert.strictEqual(e.position(), 0);
  e.perform('jump', 5000);
  assert.strictEqual(e.position(), 1200);
  assert.strictEqual(e.perform('jump', 'abc'), false);
});

test('a new layout keeps the reader at the same proportion', () => {
  const { e } = make();
  e.setPosition(600);
  e.setLayout({ extent: 2400, markers: [] });
  assert.strictEqual(e.position(), 1200);
});

test('speed is clamped; unknown commands fail', () => {
  const { e } = make();
  e.perform('speed', 99);
  assert.strictEqual(e.speed, 30);
  e.perform('speed', '-5');
  assert.strictEqual(e.speed, 25);
  assert.strictEqual(e.perform('bogus'), false);
});

test('mirror and font size commands change settings', () => {
  const { e } = make();
  let configs = 0;
  e.on('config', () => configs++);
  e.perform('mirror');
  assert.strictEqual(e.settings.mirror, true);
  e.perform('mirror', 'off');
  assert.strictEqual(e.settings.mirror, false);
  e.perform('fontsize', '+8');
  assert.strictEqual(e.settings.fontSize, 80);
  assert.strictEqual(configs, 3);
});

test('script and save data', () => {
  const { e } = make();
  e.setScript({ text: 'Hello', name: 'Show' });
  assert.deepStrictEqual(e.saveData().script, { text: 'Hello', name: 'Show', file: null });
  e.newScript();
  assert.strictEqual(e.script.text, '');
  assert.strictEqual(e.position(), 0);
  const snap = e.snapshot();
  assert.strictEqual(snap.name, 'Untitled');
  assert.strictEqual(snap.playing, false);
});

console.log(`${passed} engine tests passed`);
