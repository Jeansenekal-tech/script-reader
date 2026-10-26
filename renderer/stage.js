// Shared prompter view, used by the talent display and the operator preview.
// The script is laid out on a stage `stageWidth` pixels wide and scaled to the
// view, so both wrap lines identically and share one scroll position.

export const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif',
  condensed: '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif',
  mono: '"SF Mono", Menlo, Consolas, monospace',
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "# Title" lines are markers; [text] is a cue for the presenter.
export function renderScript(text) {
  return String(text || '').split(/\r?\n/).map((line, i) => {
    const marker = /^\s*#+\s*(.*)$/.exec(line);
    if (marker) {
      const title = marker[1].trim() || 'Marker';
      return `<h2 class="pr-marker" data-line="${i}" data-title="${esc(title)}">${esc(title)}</h2>`;
    }
    if (!line.trim()) return `<p class="pr-gap" data-line="${i}"></p>`;
    const body = esc(line).replace(/\[([^\]]*)\]/g, '<span class="pr-cue">[$1]</span>');
    return `<p data-line="${i}">${body}</p>`;
  }).join('');
}

export class PrompterStage {
  // opts: { mirror: apply the mirror/flip settings, onLayout(layout), onScrub(position) }
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.stageWidth = 1600;
    this.settings = null;
    this.transport = { playing: false, position: 0, pxPerSecond: 0, at: Date.now(), extent: 0 };
    this.extent = 0;
    this.markers = [];
    host.classList.add('pr-viewport');
    host.innerHTML = '<div class="pr-frame"><div class="pr-stage"><div class="pr-text"></div></div><div class="pr-guide"><span class="pr-arrow pr-arrow-l"></span><span class="pr-line"></span><span class="pr-arrow pr-arrow-r"></span></div><div class="pr-end hidden">END</div></div>';
    this.frame = host.querySelector('.pr-frame');
    this.stage = host.querySelector('.pr-stage');
    this.text = host.querySelector('.pr-text');
    this.guide = host.querySelector('.pr-guide');
    this.endTag = host.querySelector('.pr-end');
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.bindPointer();
    const loop = () => {
      this.frameTick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setConfig(settings, stageWidth) {
    const s = settings;
    const prev = this.settings;
    this.settings = s;
    if (stageWidth) this.stageWidth = stageWidth;
    const st = this.text.style;
    st.fontSize = `${s.fontSize}px`;
    st.lineHeight = String(s.lineHeight);
    st.fontFamily = FONTS[s.fontFamily] || FONTS.system;
    st.textAlign = s.align;
    st.textTransform = s.uppercase ? 'uppercase' : 'none';
    st.color = s.textColor;
    st.padding = `0 ${(s.margin / 100) * this.stageWidth}px`;
    this.stage.style.width = `${this.stageWidth}px`;
    this.host.style.setProperty('--pr-cue', s.cueColor);
    this.host.style.setProperty('--pr-marker', s.markerColor);
    this.host.style.background = s.bgColor;
    this.guide.classList.toggle('hidden', !s.guideVisible);
    const mx = this.opts.mirror && s.mirror ? -1 : 1;
    const my = this.opts.mirror && s.flip ? -1 : 1;
    this.frame.style.transform = mx === 1 && my === 1 ? '' : `scale(${mx}, ${my})`;
    const layoutKeys = ['fontSize', 'lineHeight', 'fontFamily', 'margin', 'uppercase', 'align'];
    if (!prev || layoutKeys.some((k) => prev[k] !== s[k])) this.measureSoon();
    this.resize();
  }

  setScript(text) {
    this.text.innerHTML = renderScript(text);
    this.measureSoon();
  }

  setTransport(t) {
    this.transport = t;
    this.frameTick();
  }

  // ------------------------------------------------------------ geometry
  get scale() {
    return (this.host.clientWidth || 1) / this.stageWidth;
  }

  get lineHeightPx() {
    const s = this.settings;
    return s ? s.fontSize * s.lineHeight : 100;
  }

  // Reading line in stage pixels from the top of the view.
  get guideY() {
    const vh = (this.host.clientHeight || 1) / this.scale;
    return ((this.settings?.guide ?? 30) / 100) * vh;
  }

  resize() {
    this.stage.style.transform = `scale(${this.scale})`;
    this.guide.style.top = `${this.settings?.guide ?? 30}%`;
    this.frameTick();
  }

  measureSoon() {
    clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => this.measure(), 30);
  }

  // offsetTop is in layout (unscaled stage) pixels.
  measure() {
    const lh = this.lineHeightPx;
    const last = this.text.lastElementChild;
    this.extent = last ? Math.max(0, Math.round(last.offsetTop + last.offsetHeight - lh)) : 0;
    this.markers = [...this.text.querySelectorAll('.pr-marker')].map((el) => ({ title: el.dataset.title, offset: Math.round(el.offsetTop), line: Number(el.dataset.line) }));
    this.opts.onLayout?.({ extent: this.extent, markers: this.markers.map(({ title, offset }) => ({ title, offset })) });
  }

  // Stage position that puts script line `n` (0-based) on the reading line.
  offsetForLine(n) {
    let best = null;
    for (const el of this.text.children) {
      if (Number(el.dataset.line) > n) break;
      best = el;
    }
    return best ? Math.min(this.extent, Math.round(best.offsetTop)) : 0;
  }

  position() {
    const t = this.transport;
    const p = t.playing ? t.position + (t.pxPerSecond * (Date.now() - t.at)) / 1000 : t.position;
    return Math.min(Math.max(p, 0), this.extent || t.extent || 0);
  }

  frameTick() {
    if (this.dragging) return;
    const pos = this.position();
    this.currentPos = pos;
    // Centre the current line on the reading line.
    const y = this.guideY - pos - this.lineHeightPx / 2;
    this.text.style.transform = `translate3d(0, ${y}px, 0)`;
    this.endTag.classList.toggle('hidden', !(this.extent > 0 && pos >= this.extent && !this.transport.playing));
  }

  // --------------------------------------------- wheel / drag to scroll
  bindPointer() {
    const host = this.host;
    host.addEventListener('wheel', (e) => {
      e.preventDefault();
      const flip = this.opts.mirror && this.settings?.flip ? -1 : 1;
      this.opts.onScrub?.(this.position() + (e.deltaY * flip) / this.scale);
    }, { passive: false });
    let startY = 0;
    let startPos = 0;
    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      host.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startPos = this.position();
      this.dragging = true;
    });
    host.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const flip = this.opts.mirror && this.settings?.flip ? -1 : 1;
      const p = Math.min(Math.max(startPos - ((e.clientY - startY) * flip) / this.scale, 0), this.extent);
      this.text.style.transform = `translate3d(0, ${this.guideY - p - this.lineHeightPx / 2}px, 0)`;
      this.dragPos = p;
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.dragPos !== undefined) this.opts.onScrub?.(this.dragPos);
      this.dragPos = undefined;
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
  }
}

// Keys shared by the operator window and the display (presentation clickers
// send Page Up / Page Down or the arrow keys).
export function handlePrompterKey(e, api, stage) {
  const page = () => (stage.host.clientHeight / stage.scale) * 0.6;
  const map = {
    ' ': () => api.cmd('toggle'),
    ArrowDown: () => api.cmd('faster'),
    ArrowUp: () => api.cmd('slower'),
    ArrowRight: () => api.cmd('next'),
    ArrowLeft: () => api.cmd('prev'),
    PageDown: () => api.cmd('jump', `+${page()}`),
    PageUp: () => api.cmd('jump', `-${page()}`),
    Home: () => api.cmd('top'),
    End: () => api.cmd('end'),
    r: () => api.cmd('reverse'),
    m: () => api.cmd('mirror'),
  };
  const fn = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!fn || e.metaKey || e.ctrlKey || e.altKey) return false;
  e.preventDefault();
  fn();
  return true;
}
