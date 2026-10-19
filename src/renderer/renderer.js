'use strict';

const $ = (id) => document.getElementById(id);

const video = $('video');
const stage = $('stage');
const timeline = $('timeline');
const track = $('track');
const ruler = $('ruler');
const thumbsEl = $('thumbs');
const playheadEl = $('playhead');
const selectionEl = $('selection');
const inMarker = $('inMarker');
const outMarker = $('outMarker');
const playBtn = $('playBtn');
const exportBtn = $('exportBtn');

const MIN_TICK_PX = 90;
const MAX_PX_PER_SEC = 240;

const state = {
  file: null,
  fps: 30,
  duration: 0,
  inPoint: null,
  outPoint: null,
  zoom: 1,
  shuttle: 0, // 0 = stopped, >0 forward rate, <0 reverse rate
  stopAt: null, // used by "play selection"
  exporting: false,
};

// ---------- formatting helpers ----------

function fmt(t) {
  if (t == null || !isFinite(t)) return '--';
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
}

function fmtShort(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const sec = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let statusTimer;
function status(msg, { error = false, sticky = false } = {}) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 2200);
}

// ---------- timeline geometry ----------

function trackWidth() {
  return timeline.clientWidth * state.zoom;
}
function pxPerSec() {
  return state.duration ? trackWidth() / state.duration : 0;
}
function timeToX(t) {
  return t * pxPerSec();
}
function xToTime(x) {
  return clamp(x / (pxPerSec() || 1), 0, state.duration);
}
function maxZoom() {
  if (!state.duration) return 1;
  return Math.max(1, (state.duration * MAX_PX_PER_SEC) / timeline.clientWidth);
}

// ---------- loading ----------

async function openFile(loader) {
  try {
    const file = await loader();
    if (!file) return;
    loadVideo(file);
  } catch (err) {
    status(`Could not open file:\n${err.message}`, { error: true });
  }
}

function loadVideo(file) {
  stopShuttle();
  state.file = file;
  state.fps = file.info?.fps || 30;
  state.inPoint = null;
  state.outPoint = null;
  state.zoom = 1;
  state.stopAt = null;
  thumbCache.clear();

  $('fileName').textContent = file.path;
  $('dropHint').classList.add('hidden');
  document.title = `VideoSplit — ${file.name}`;

  video.src = file.url;
  thumbVideo.src = file.url;
  thumbReady = new Promise((resolve) => thumbVideo.addEventListener('loadeddata', resolve, { once: true }));
}

video.addEventListener('loadedmetadata', () => {
  state.duration = video.duration;
  playBtn.disabled = false;
  timeline.scrollLeft = 0;
  layout();
  updateMarks();
  const info = state.file.info || {};
  const parts = [info.width && `${info.width}×${info.height}`, info.videoCodec, info.audioCodec, `${state.fps} fps`];
  status(`Loaded ${state.file.name}\n${parts.filter(Boolean).join(' · ')}`);
});

video.addEventListener('error', () => {
  status('This video could not be played (unsupported codec?).', { error: true });
});

// ---------- thumbnails ----------

const thumbVideo = document.createElement('video');
thumbVideo.muted = true;
thumbVideo.preload = 'auto';
let thumbReady = Promise.resolve();
const thumbCache = new Map(); // time key -> canvas
let tiles = [];
let thumbQueue = [];
let thumbBusy = false;

function renderThumbs() {
  thumbsEl.replaceChildren();
  tiles = [];
  thumbQueue = [];
  if (!state.duration) return;

  const h = thumbsEl.clientHeight;
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const tileW = Math.max(40, Math.round(h * aspect));
  const width = trackWidth();
  const count = Math.ceil(width / tileW);
  const dpr = window.devicePixelRatio || 1;

  for (let i = 0; i < count; i++) {
    const left = i * tileW;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(tileW * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.left = `${left}px`;
    canvas.style.width = `${tileW}px`;
    thumbsEl.appendChild(canvas);
    // Sample the frame at the tile's centre (clamped so the last tile isn't past the end).
    const t = clamp(xToTime(left + tileW / 2), 0, Math.max(0, state.duration - 0.05));
    tiles.push({ canvas, left, width: tileW, time: t, drawn: false });
  }
  queueVisibleThumbs();
}

function queueVisibleThumbs() {
  const margin = timeline.clientWidth * 0.5;
  const lo = timeline.scrollLeft - margin;
  const hi = timeline.scrollLeft + timeline.clientWidth + margin;
  const centre = timeline.scrollLeft + timeline.clientWidth / 2;
  thumbQueue = tiles
    .filter((tile) => !tile.drawn && tile.left + tile.width >= lo && tile.left <= hi)
    .sort((a, b) => Math.abs(a.left - centre) - Math.abs(b.left - centre));
  pumpThumbs();
}

function seekThumb(t) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      thumbVideo.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    thumbVideo.addEventListener('seeked', done);
    thumbVideo.currentTime = t;
  });
}

function drawCover(ctx, src, w, h) {
  const sw = src.videoWidth || src.width;
  const sh = src.videoHeight || src.height;
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    await thumbReady;
    while (thumbQueue.length) {
      const tile = thumbQueue.shift();
      if (tile.drawn) continue;
      const key = tile.time.toFixed(2);
      let cached = thumbCache.get(key);
      if (!cached) {
        await seekThumb(tile.time);
        cached = document.createElement('canvas');
        cached.width = tile.canvas.width;
        cached.height = tile.canvas.height;
        drawCover(cached.getContext('2d'), thumbVideo, cached.width, cached.height);
        thumbCache.set(key, cached);
      }
      const ctx = tile.canvas.getContext('2d');
      drawCover(ctx, cached, tile.canvas.width, tile.canvas.height);
      tile.drawn = true;
    }
  } finally {
    thumbBusy = false;
  }
}

// ---------- ruler ----------

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function renderRuler() {
  ruler.replaceChildren();
  if (!state.duration) return;
  const pps = pxPerSec();
  const step = TICK_STEPS.find((s) => s * pps >= MIN_TICK_PX) || TICK_STEPS[TICK_STEPS.length - 1];
  const minor = step / 5;
  const frag = document.createDocumentFragment();
  const count = Math.floor(state.duration / minor + 1e-6);
  for (let i = 0; i <= count; i++) {
    const t = i * minor;
    const tick = document.createElement('div');
    const major = i % 5 === 0;
    tick.className = major ? 'tick' : 'tick minor';
    tick.style.left = `${timeToX(t)}px`;
    if (major) tick.textContent = fmtShort(Math.round(t * 10) / 10);
    frag.appendChild(tick);
  }
  ruler.appendChild(frag);
}

// ---------- layout & drawing ----------

function layout() {
  state.zoom = clamp(state.zoom, 1, maxZoom());
  track.style.width = `${trackWidth()}px`;
  $('zoomLabel').textContent = `${state.zoom < 10 ? state.zoom.toFixed(1) : Math.round(state.zoom)}×`;
  renderRuler();
  renderThumbs();
  updatePlayhead();
  updateMarks();
}

function updatePlayhead() {
  const t = video.currentTime || 0;
  playheadEl.style.left = `${timeToX(t)}px`;
  $('timecode').textContent = `${fmt(t)} / ${fmt(state.duration)}`;
  playBtn.textContent = isPlaying() ? '❚❚' : '▶';
  const rate = state.shuttle;
  $('rate').textContent = rate && Math.abs(rate) !== 1 ? `${rate > 0 ? '' : '◀ '}${Math.abs(rate)}×` : rate < 0 ? '◀ 1×' : '';
}

function followPlayhead() {
  if (!isPlaying()) return;
  const x = timeToX(video.currentTime);
  const left = timeline.scrollLeft;
  const w = timeline.clientWidth;
  if (x < left || x > left + w - 20) timeline.scrollLeft = x - w * 0.1;
}

function updateMarks() {
  const { inPoint, outPoint } = state;
  const hasIn = inPoint != null;
  const hasOut = outPoint != null;
  inMarker.classList.toggle('hidden', !hasIn);
  outMarker.classList.toggle('hidden', !hasOut);
  if (hasIn) inMarker.style.left = `${timeToX(inPoint)}px`;
  if (hasOut) outMarker.style.left = `${timeToX(outPoint) - 2}px`;

  const range = selectionRange();
  selectionEl.classList.toggle('hidden', !range);
  if (range) {
    selectionEl.style.left = `${timeToX(range.start)}px`;
    selectionEl.style.width = `${timeToX(range.end) - timeToX(range.start)}px`;
  }

  $('inLabel').textContent = fmt(inPoint);
  $('outLabel').textContent = fmt(outPoint);
  $('lenLabel').textContent = range ? fmt(range.end - range.start) : '--';
  exportBtn.disabled = !range || state.exporting;
}

// Missing In defaults to the start, missing Out to the end; null when nothing is marked.
function selectionRange() {
  if (state.inPoint == null && state.outPoint == null) return null;
  const start = state.inPoint ?? 0;
  const end = state.outPoint ?? state.duration;
  return end > start ? { start, end } : null;
}

function tick() {
  if (state.shuttle < 0) {
    const now = performance.now();
    const dt = (now - (tick.last || now)) / 1000;
    tick.last = now;
    const t = video.currentTime + dt * state.shuttle;
    if (t <= 0) {
      video.currentTime = 0;
      stopShuttle();
    } else {
      video.currentTime = t;
    }
  } else {
    tick.last = null;
  }
  if (state.stopAt != null && video.currentTime >= state.stopAt) {
    video.pause();
    video.currentTime = state.stopAt;
    state.stopAt = null;
  }
  updatePlayhead();
  followPlayhead();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- playback control ----------

function isPlaying() {
  return state.shuttle < 0 || !video.paused;
}

function stopShuttle() {
  state.shuttle = 0;
  state.stopAt = null;
  video.pause();
  video.playbackRate = 1;
}

function playForward(rate) {
  state.shuttle = rate;
  video.playbackRate = rate;
  if (video.ended || video.currentTime >= state.duration) video.currentTime = 0;
  video.play().catch(() => {});
}

function togglePlay() {
  if (!state.duration) return;
  if (isPlaying()) stopShuttle();
  else playForward(1);
}

function shuttle(dir) {
  if (!state.duration) return;
  const cur = state.shuttle;
  state.stopAt = null;
  if (dir > 0) {
    playForward(cur > 0 ? Math.min(cur * 2, 8) : 1);
  } else {
    video.pause();
    video.playbackRate = 1;
    state.shuttle = cur < 0 ? Math.max(cur * 2, -8) : -1;
  }
}

function seek(t) {
  if (!state.duration) return;
  video.currentTime = clamp(t, 0, state.duration);
  updatePlayhead();
}

function stepFrames(n) {
  if (!state.duration) return;
  stopShuttle();
  const frame = Math.round(video.currentTime * state.fps) + n;
  // Land slightly inside the frame so rounding doesn't show the previous one.
  seek((frame + 0.01) / state.fps);
}

function playSelection() {
  const range = selectionRange();
  if (!range) return status('Set In and/or Out first.');
  video.currentTime = range.start;
  state.stopAt = range.end;
  playForward(1);
}

// ---------- marks ----------

function setIn() {
  if (!state.duration) return;
  state.inPoint = video.currentTime;
  if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null;
  updateMarks();
}

function setOut() {
  if (!state.duration) return;
  state.outPoint = video.currentTime;
  if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null;
  updateMarks();
}

function clearMarks() {
  state.inPoint = null;
  state.outPoint = null;
  updateMarks();
}

// ---------- zoom ----------

function setZoom(z, anchorClientX) {
  if (!state.duration) return;
  const rect = timeline.getBoundingClientRect();
  const anchor = anchorClientX != null ? anchorClientX - rect.left : timeToX(video.currentTime) - timeline.scrollLeft;
  const anchorPx = clamp(anchor, 0, timeline.clientWidth);
  const t = xToTime(timeline.scrollLeft + anchorPx);
  state.zoom = clamp(z, 1, maxZoom());
  layout();
  timeline.scrollLeft = timeToX(t) - anchorPx;
}

const zoomBy = (factor, anchor) => setZoom(state.zoom * factor, anchor);

timeline.addEventListener(
  'wheel',
  (e) => {
    if (!state.duration) return;
    if (e.ctrlKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      timeline.scrollLeft += e.deltaY;
    }
  },
  { passive: false },
);

timeline.addEventListener('scroll', queueVisibleThumbs);

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.duration && layout(), 120);
}).observe(timeline);

// ---------- scrubbing ----------

function scrubTo(clientX) {
  const rect = track.getBoundingClientRect();
  seek(xToTime(clientX - rect.left));
}

track.addEventListener('mousedown', (e) => {
  if (!state.duration || e.button !== 0) return;
  const wasPlaying = isPlaying() && state.shuttle > 0;
  const rate = state.shuttle;
  stopShuttle();
  scrubTo(e.clientX);
  const move = (ev) => scrubTo(ev.clientX);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (wasPlaying) playForward(rate);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---------- export ----------

async function exportClip() {
  const range = selectionRange();
  if (!state.file || !range || state.exporting) return;
  stopShuttle();
  state.exporting = true;
  updateMarks();
  try {
    const res = await window.api.exportClip({ source: state.file.path, start: range.start, end: range.end });
    if (res.canceled) return;
    if (res.error) status(`Export failed:\n${res.error}`, { error: true });
    else status(`Exported to\n${res.output}`);
  } finally {
    state.exporting = false;
    updateMarks();
  }
}

window.api.onExportProgress((p) => {
  if (state.exporting) status(`Exporting… ${Math.round(p * 100)}%`, { sticky: true });
});

// ---------- UI wiring ----------

$('openBtn').addEventListener('click', () => openFile(window.api.openVideo));
exportBtn.addEventListener('click', exportClip);
playBtn.addEventListener('click', togglePlay);
$('zoomIn').addEventListener('click', () => zoomBy(1.5));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.5));
$('helpBtn').addEventListener('click', () => $('help').classList.toggle('hidden'));
$('help').addEventListener('click', () => $('help').classList.add('hidden'));
video.addEventListener('click', togglePlay);

const volume = $('volume');
volume.addEventListener('input', () => {
  video.volume = +volume.value;
  video.muted = false;
});
volume.addEventListener('change', () => volume.blur());

// Keep keyboard shortcuts working after clicking a button.
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) e.target.blur();
});

// Drag & drop
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    stage.classList.add('drag-over');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    stage.classList.remove('drag-over');
  }),
);
window.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) openFile(() => window.api.loadDroppedFile(file));
});

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && key.toLowerCase() === 'o') return e.preventDefault(), openFile(window.api.openVideo);
  if (ctrl && key.toLowerCase() === 'e') return e.preventDefault(), exportClip();
  if (key === '?') return $('help').classList.toggle('hidden');
  if (key === 'Escape') return $('help').classList.add('hidden');
  if (!state.duration) return;

  switch (key) {
    case ' ':
    case 'k':
    case 'K':
      e.preventDefault();
      if (key === ' ') togglePlay();
      else stopShuttle();
      break;
    case 'l':
    case 'L':
      shuttle(1);
      break;
    case 'j':
    case 'J':
      shuttle(-1);
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault();
      const dir = key === 'ArrowRight' ? 1 : -1;
      if (ctrl) seek(video.currentTime + 10 * dir);
      else if (e.shiftKey) seek(video.currentTime + dir);
      else stepFrames(dir);
      break;
    }
    case 'Home':
      e.preventDefault();
      seek(0);
      break;
    case 'End':
      e.preventDefault();
      seek(state.duration);
      break;
    case 'i':
      setIn();
      break;
    case 'o':
      setOut();
      break;
    case 'I':
      if (state.inPoint != null) seek(state.inPoint);
      break;
    case 'O':
      if (state.outPoint != null) seek(state.outPoint);
      break;
    case 'p':
    case 'P':
      playSelection();
      break;
    case 'x':
    case 'X':
      clearMarks();
      break;
    case 'm':
    case 'M':
      video.muted = !video.muted;
      status(video.muted ? 'Muted' : 'Unmuted');
      break;
    case '+':
    case '=':
      zoomBy(1.5);
      break;
    case '-':
    case '_':
      zoomBy(1 / 1.5);
      break;
  }
});
