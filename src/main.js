const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// ffmpeg-static points inside app.asar when packaged; the binary lives in app.asar.unpacked.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#16181c',
    title: 'VideoSplit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Run ffmpeg -i to read stream info (fps, codecs) from its stderr banner.
function probe(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', () => {
      const fps = err.match(/Video:.*?([\d.]+) fps/);
      const video = err.match(/Video: (\w+)/);
      const audio = err.match(/Audio: (\w+)/);
      const size = err.match(/Video:.*?, (\d{2,5})x(\d{2,5})/);
      resolve({
        fps: fps ? parseFloat(fps[1]) : 30,
        videoCodec: video ? video[1] : null,
        audioCodec: audio ? audio[1] : null,
        width: size ? parseInt(size[1], 10) : null,
        height: size ? parseInt(size[2], 10) : null,
      });
    });
    proc.on('error', () => resolve({ fps: 30 }));
  });
}

async function loadFile(filePath) {
  const info = await probe(filePath);
  return { path: filePath, name: path.basename(filePath), url: pathToFileURL(filePath).href, info };
}

ipcMain.handle('open-video', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [{ name: 'MP4 video', extensions: ['mp4', 'm4v', 'mov'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return loadFile(res.filePaths[0]);
});

ipcMain.handle('load-path', (_e, filePath) => loadFile(filePath));

ipcMain.handle('export-clip', async (_e, { source, start, end }) => {
  const parsed = path.parse(source);
  const stamp = (t) => t.toFixed(2).replace('.', '_');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export clip',
    defaultPath: path.join(parsed.dir, `${parsed.name}_${stamp(start)}-${stamp(end)}.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  if (path.resolve(res.filePath) === path.resolve(source)) {
    return { error: 'Cannot overwrite the source file.' };
  }

  const duration = end - start;
  // Input seeking + stream copy: fast and lossless, but the start snaps to the
  // keyframe at or before `start`.
  const args = [
    '-hide_banner', '-y',
    '-ss', start.toFixed(3),
    '-i', source,
    '-t', duration.toFixed(3),
    '-map', '0:v?', '-map', '0:a?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    res.filePath,
  ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args);
    let log = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      log += s;
      const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && duration > 0) {
        const t = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
        win.webContents.send('export-progress', Math.min(1, t / duration));
      }
    });
    proc.on('error', (err) => resolve({ error: err.message }));
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, output: res.filePath });
      else resolve({ error: log.split('\n').filter(Boolean).slice(-4).join('\n') });
    });
  });
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
