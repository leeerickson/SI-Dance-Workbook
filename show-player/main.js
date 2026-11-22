// Recital Show Player: Electron main process.
// Owns the window, the media protocol, show files, autosave, crash recovery,
// the WordPress status sender and the system-utilization numbers.
// Built to keep a live show running: nothing here waits on the network, and a
// crashed page is reloaded and picks up where it was.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, powerSaveBlocker, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');

const SHOW_EXT = 'recital';
const FORMAT = 1;
const APP_DIR = path.join(__dirname, 'app');
const MEDIA_EXT = /\.(mp3|wav|wave|aif|aiff|flac|ogg|oga|opus|m4a|aac|mp4|m4v|mov|webm|mkv)$/i;
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', woff2: 'font/woff2', png: 'image/png', svg: 'image/svg+xml', json: 'application/json',
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska'
};

// Keep audio and timers running at full speed even when the window is covered or minimised.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// On Windows, a window it thinks is covered (e.g. by full-screen video on a duplicated screen) stops updating. Not for a show controller.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

protocol.registerSchemesAsPrivileged([{ scheme: 'show', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let userDir = null;
let pendingOpen = null;
let liveSnapshot = null;   // latest playback state from the page, kept here so it survives a page crash
let crashedAt = 0;
let isPlaying = false;
let blockerId = null;
let outputDisplayId = null;
let videoWin = null;      // the video output window, while it's open

/* ---------- logging ---------- */
let logStream = null;
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  try { if (logStream) logStream.write(line); } catch (_) { /* never let logging stop the show */ }
}
process.on('uncaughtException', err => log('main uncaughtException', String(err && err.stack || err)));
process.on('unhandledRejection', err => log('main unhandledRejection', String(err && err.stack || err)));

/* ---------- files ---------- */
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, file);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
const friendly = err => (err && err.message) ? err.message : String(err);
const extOf = p => (path.extname(p).slice(1) || '').toLowerCase();

/* ---------- single instance ---------- */
const findShowArg = argv => argv.find(a => typeof a === 'string' && a.toLowerCase().endsWith('.' + SHOW_EXT) && fs.existsSync(a));
app.on('open-file', (e, p) => { e.preventDefault(); if (win && !win.webContents.isLoading()) win.webContents.send('show:incoming', p); else pendingOpen = p; });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = findShowArg(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) win.webContents.send('show:incoming', f); }
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function start() {
  userDir = process.env.SHOW_PLAYER_DATA || app.getPath('userData');
  fs.mkdirSync(path.join(userDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'backups'), { recursive: true });
  logStream = fs.createWriteStream(path.join(userDir, 'logs', `show-${new Date().toISOString().slice(0, 10)}.log`), { flags: 'a' });
  log('start', app.getVersion(), process.platform, os.release());
  const prev = readJson(path.join(userDir, 'live.json'));
  if (prev && prev.state === 'playing') log('previous run ended while playing', prev);
  liveSnapshot = prev ? { ...prev, fromLastRun: true } : null;
  pendingOpen = pendingOpen || findShowArg(process.argv);

  protocol.handle('show', handleShowProtocol);
  createWindow();
  startStats();
  // Tell the page when a projector or screen is plugged in or out.
  const changed = () => { if (win && !win.isDestroyed()) win.webContents.send('displays:changed'); };
  screen.on('display-added', (_e, d) => { log('screen connected', d.label || d.id); changed(); });
  screen.on('display-removed', (_e, d) => { log('screen disconnected', d.label || d.id); changed(); });
}

/* ---------- show:// protocol ----------
   show://app/...            the page and its files
   show://media/<b64url>     a media file on disk, with byte ranges so audio and video can seek */
async function handleShowProtocol(req) {
  try {
    const u = new URL(req.url);
    if (u.host === 'app') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(APP_DIR, rel));
      if (!file.startsWith(APP_DIR)) return new Response('Not found', { status: 404 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'Content-Type': MIME[extOf(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
    }
    if (u.host === 'media') {
      const file = Buffer.from(u.pathname.slice(1), 'base64url').toString('utf8');
      if (!MEDIA_EXT.test(file)) return new Response('Not a media file', { status: 403 });
      return await serveMedia(file, req);
    }
  } catch (err) {
    log('protocol error', req.url.slice(0, 200), friendly(err));
    return new Response('Not found', { status: 404 });
  }
  return new Response('Not found', { status: 404 });
}

async function serveMedia(file, req) {
  const st = await fs.promises.stat(file);
  const size = st.size;
  const type = MIME[extOf(file)] || 'application/octet-stream';
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  const range = req.headers.get('range');
  let start = 0, end = size - 1, status = 200;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...head, 'Content-Range': `bytes */${size}` } });
      status = 206;
      head['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  head['Content-Length'] = String(end - start + 1);
  if (size === 0) return new Response(null, { status: 200, headers: head });
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  stream.on('error', e => log('media read error', file, friendly(e)));
  return new Response(Readable.toWeb(stream), { status, headers: head });
}

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: 'Recital Show Player',
    backgroundColor: '#0E1119',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true
    }
  });
  win.once('ready-to-show', () => { win.show(); if (process.env.SHOW_PLAYER_MAXIMIZE !== '0') win.maximize(); });
  win.loadURL('show://app/index.html');

  // The video output window is opened by the page (so it can share the video picture directly).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('show://app/output.html')) {
      return { action: 'allow', overrideBrowserWindowOptions: { ...outputPlacement(outputDisplayId), autoHideMenuBar: true, backgroundColor: '#000000', title: 'Video output',
        webPreferences: { backgroundThrottling: false } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    child.setMenu(null);
    if (String(details.url).startsWith('show://app/output.html')) { videoWin = child; child.on('closed', () => { if (videoWin === child) videoWin = null; }); }
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('show://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });

  // A crashed page is reloaded straight away; the page asks for the snapshot and resumes.
  win.webContents.on('render-process-gone', (_e, details) => {
    log('page crashed', details);
    crashedAt = Date.now();
    if (details.reason !== 'clean-exit') setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL('show://app/index.html'); }, 300);
  });
  let hangTimer = null;
  win.on('unresponsive', () => {
    log('page unresponsive');
    hangTimer = setTimeout(async () => {
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Keep waiting', 'Reload and resume'], defaultId: 0, title: 'Not responding',
        message: 'Recital Show Player has stopped responding.', detail: 'Reloading picks up the show where it was.' });
      if (r.response === 1) { crashedAt = Date.now(); win.webContents.forcefullyCrashRenderer(); }
    }, 8000);
  });
  win.on('responsive', () => { log('page responsive again'); clearTimeout(hangTimer); });

  win.on('close', e => {
    if (isPlaying && !app.forceQuit) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep playing', 'Quit'], defaultId: 0, cancelId: 0, title: 'Show is playing',
        message: 'Music is playing. Quit anyway?' });
      if (r === 0) e.preventDefault();
    }
  });
  buildMenu();
}

/* ---------- menu ---------- */
function buildMenu() {
  const cmd = name => () => win && win.webContents.send('menu', name);
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'New show', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
      { label: 'Open show…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
      { label: 'Save show', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: 'Save show as…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveas') },
      { type: 'separator' },
      { label: 'Add music or video…', accelerator: 'CmdOrCtrl+I', click: cmd('add') },
      { type: 'separator' },
      { label: 'Show log folder', click: () => shell.openPath(path.join(userDir, 'logs')) },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }])
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Show', submenu: [
      { label: 'Preflight check…', accelerator: 'CmdOrCtrl+K', click: cmd('preflight') },
      { label: 'Test and calibrate…', accelerator: 'CmdOrCtrl+T', click: cmd('test') },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
      { label: 'Video output window', accelerator: 'CmdOrCtrl+Shift+O', click: cmd('video') }
    ] },
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }])
    ] },
    { label: 'Help', submenu: [
      { label: 'Keyboard shortcuts', click: cmd('keys') },
      { label: 'About Recital Show Player', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About', message: `Recital Show Player ${app.getVersion()}`,
        detail: 'Runs a recital\'s music and video, with cues, props, hot sounds and live status for phones.' }) }
    ] }
  ]));
}

/* ---------- IPC: show files ---------- */
const mediaInfo = async p => {
  try { const st = await fs.promises.stat(p); await fs.promises.access(p, fs.constants.R_OK); return { path: p, name: path.basename(p), exists: true, size: st.size, mtime: Math.round(st.mtimeMs) }; }
  catch (_) { return { path: p, name: path.basename(p), exists: false }; }
};

ipcMain.handle('media:choose', async (_e, { title } = {}) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Add music or video', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Music and video', extensions: ['mp3', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'mp4', 'm4v', 'mov', 'webm', 'mkv'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.filter(p => MEDIA_EXT.test(p)).map(mediaInfo));
});
ipcMain.handle('media:stat', (_e, paths) => Promise.all((paths || []).map(mediaInfo)));

// Looks for missing files by name in a folder the user picks (searches subfolders too).
ipcMain.handle('media:find', async (_e, names) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder with the music', properties: ['openDirectory'] });
  if (r.canceled) return null;
  const want = new Map((names || []).map(n => [n.toLowerCase(), null]));
  let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > 6 || seen > 50000) return;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      seen++;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && !ent.name.startsWith('.')) await walk(full, depth + 1);
      else if (ent.isFile() && want.has(ent.name.toLowerCase()) && !want.get(ent.name.toLowerCase())) want.set(ent.name.toLowerCase(), full);
    }
  };
  await walk(r.filePaths[0], 0);
  const out = {};
  for (const [k, v] of want) if (v) out[k] = v;
  return out;
});

ipcMain.handle('show:open', async (_e, filePath) => {
  if (!filePath) {
    const r = await dialog.showOpenDialog(win, { title: 'Open show', properties: ['openFile'], filters: [{ name: 'Recital show', extensions: [SHOW_EXT] }] });
    if (r.canceled) return null;
    filePath = r.filePaths[0];
  }
  const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  if (data.app !== 'recital-show-player' || !data.show) throw new Error("This file wasn't made by Recital Show Player.");
  if ((data.format || 1) > FORMAT) throw new Error('This show was saved by a newer version of Recital Show Player. Update the app to open it.');
  // Files are stored with full paths and paths relative to the show file, so a show folder can be moved to another computer.
  const dir = path.dirname(filePath);
  const fix = t => { if (t && t.path && !fs.existsSync(t.path) && t.rel) { const alt = path.resolve(dir, t.rel); if (fs.existsSync(alt)) t.path = alt; } };
  (data.show.tracks || []).forEach(fix); (data.show.filler || []).forEach(fix); (data.show.hotCues || []).forEach(fix);
  return { path: filePath, show: data.show };
});

ipcMain.handle('show:save', async (_e, { filePath, show, saveAs }) => {
  if (!filePath || saveAs) {
    const r = await dialog.showSaveDialog(win, { title: 'Save show', defaultPath: (show.name || 'Recital').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.' + SHOW_EXT,
      filters: [{ name: 'Recital show', extensions: [SHOW_EXT] }] });
    if (r.canceled) return null;
    filePath = r.filePath;
  }
  const dir = path.dirname(filePath);
  const rel = t => t && t.path ? { ...t, rel: path.relative(dir, t.path).split(path.sep).join('/') } : t;
  const out = { ...show, tracks: (show.tracks || []).map(rel), filler: (show.filler || []).map(rel), hotCues: (show.hotCues || []).map(rel) };
  if (fs.existsSync(filePath)) { try { await fs.promises.copyFile(filePath, filePath + '.bak'); } catch (_) {} }
  await writeAtomic(filePath, JSON.stringify({ app: 'recital-show-player', format: FORMAT, saved: new Date().toISOString(), show: out }, null, 1));
  log('saved show', filePath);
  return { path: filePath };
});
ipcMain.handle('show:pending', () => { const p = pendingOpen; pendingOpen = null; return p; });

/* ---------- IPC: autosave, settings, recovery ---------- */
let backupTimer = 0;
ipcMain.handle('autosave:write', async (_e, data) => {
  await writeAtomic(path.join(userDir, 'autosave.json'), JSON.stringify(data));
  // A rolling backup every 5 minutes, keeping the last 12.
  if (Date.now() - backupTimer > 5 * 60 * 1000) {
    backupTimer = Date.now();
    const dir = path.join(userDir, 'backups');
    await writeAtomic(path.join(dir, `autosave-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(data));
    const old = (await fs.promises.readdir(dir)).filter(f => f.startsWith('autosave-')).sort().slice(0, -12);
    for (const f of old) fs.promises.unlink(path.join(dir, f)).catch(() => {});
  }
  return true;
});
ipcMain.handle('autosave:read', () => readJson(path.join(userDir, 'autosave.json')));
ipcMain.handle('settings:read', () => readJson(path.join(userDir, 'settings.json')));
ipcMain.handle('settings:write', (_e, s) => writeAtomic(path.join(userDir, 'settings.json'), JSON.stringify(s, null, 1)));

let liveWrite = 0;
ipcMain.on('live:snapshot', (_e, snap) => {
  liveSnapshot = snap;
  isPlaying = snap && snap.state === 'playing';
  if (Date.now() - liveWrite > 2000) { liveWrite = Date.now(); writeAtomic(path.join(userDir, 'live.json'), JSON.stringify(snap)).catch(() => {}); }
});
ipcMain.handle('live:recovery', () => {
  const snap = liveSnapshot;
  const crashed = crashedAt && Date.now() - crashedAt < 60000;
  crashedAt = 0;
  if (snap && !snap.fromLastRun) liveSnapshot = { ...snap }; // keep for another crash
  return snap ? { ...snap, crashed: !!crashed, now: Date.now() } : null;
});
ipcMain.on('log', (_e, parts) => log('page', ...(Array.isArray(parts) ? parts : [parts])));

/* ---------- IPC: power, displays, system ---------- */
ipcMain.handle('power:block', (_e, on) => {
  if (on && (blockerId === null || !powerSaveBlocker.isStarted(blockerId))) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
});
ipcMain.handle('displays:list', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: d.label || `Display ${i + 1}`, width: d.size.width, height: d.size.height, primary: d.id === primary }));
});
ipcMain.handle('displays:choose', (_e, id) => { outputDisplayId = id; return true; });

/* ---------- video output screen ----------
   On a separate screen the video fills it (full screen, no frame). On the main screen it opens
   as a normal window so it doesn't cover the controls. */
function outputDisplay(id) {
  const all = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
  return all.find(x => x.id === id) || all.find(x => x.id !== primary.id) || primary;
}
function outputPlacement(id) {
  const d = outputDisplay(id), separate = d.id !== screen.getPrimaryDisplay().id;
  return { x: d.bounds.x + (separate ? 0 : 60), y: d.bounds.y + (separate ? 0 : 60), width: separate ? d.bounds.width : 960, height: separate ? d.bounds.height : 540,
    fullscreen: separate, frame: !separate, displayId: d.id };
}
const outputWindow = () => (videoWin && !videoWin.isDestroyed() ? videoWin : null);
// Moves the open video window to another screen without closing it, so the picture keeps going.
ipcMain.handle('video:move', async (_e, id) => {
  outputDisplayId = id;
  const w = outputWindow(); if (!w) return false;
  const p = outputPlacement(id);
  if (w.isFullScreen()) { w.setFullScreen(false); await new Promise(r => setTimeout(r, 400)); }
  w.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height });
  if (p.fullscreen) { await new Promise(r => setTimeout(r, 150)); w.setFullScreen(true); }
  log('video output moved', screen.getAllDisplays().find(d => d.id === p.displayId)?.label || p.displayId);
  return true;
});
ipcMain.handle('video:screen', () => { const w = outputWindow(); return w ? screen.getDisplayMatching(w.getBounds()).id : null; });
// Shows a big number on every screen for a few seconds so you can tell which is which.
ipcMain.handle('displays:identify', () => {
  const primary = screen.getPrimaryDisplay().id;
  screen.getAllDisplays().forEach((d, i) => {
    const w = new BrowserWindow({ x: d.bounds.x + Math.round(d.bounds.width / 2 - 260), y: d.bounds.y + Math.round(d.bounds.height / 2 - 170), width: 520, height: 340,
      frame: false, transparent: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, backgroundColor: '#161A25', show: false });
    const q = new URLSearchParams({ n: String(i + 1), label: d.label || `Display ${i + 1}`, size: `${d.size.width}×${d.size.height}`, main: d.id === primary ? '1' : '' });
    w.loadURL(`show://app/identify.html?${q}`);
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 3500);
  });
  return true;
});
ipcMain.handle('system:info', async () => {
  let disk = null;
  try { const s = await fs.promises.statfs(userDir); disk = s.bavail * s.bsize; } catch (_) {}
  return { platform: process.platform, version: app.getVersion(), cpus: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem(), disk, userDir,
    powerBlocked: blockerId !== null && powerSaveBlocker.isStarted(blockerId), onBattery: (() => { try { return require('electron').powerMonitor.isOnBatteryPower(); } catch (_) { return null; } })() };
});
ipcMain.handle('log:folder', () => shell.openPath(path.join(userDir, 'logs')));

let lastCpu = null;
function systemCpu() {
  const t = os.cpus().reduce((a, c) => { const tt = Object.values(c.times).reduce((x, y) => x + y, 0); a.total += tt; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
  const prev = lastCpu; lastCpu = t;
  if (!prev || t.total === prev.total) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - (t.idle - prev.idle) / (t.total - prev.total))));
}
function startStats() {
  const cores = os.cpus().length || 1;
  setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      const metrics = app.getAppMetrics();
      const appCpu = Math.min(100, metrics.reduce((a, m) => a + (m.cpu ? m.cpu.percentCPUUsage : 0), 0) / cores);
      const appMem = metrics.reduce((a, m) => a + (m.memory ? m.memory.workingSetSize : 0), 0) * 1024;
      win.webContents.send('stats', { cpu: systemCpu(), appCpu, appMem, freeMem: os.freemem(), totalMem: os.totalmem(), t: Date.now() });
    } catch (err) { log('stats error', friendly(err)); }
  }, 1000);
}

/* ---------- WordPress status sender ----------
   Keeps only the newest program and status, sends them one at a time with a short timeout,
   and backs off when the site can't be reached. The page never waits for any of this. */
const wp = { cfg: null, program: null, status: null, busy: false, fails: 0, nextTry: 0, lastOk: 0, lastError: '', latency: 0 };
function wpReport() { if (win && !win.isDestroyed()) win.webContents.send('wp:state', { configured: !!(wp.cfg && wp.cfg.url), lastOk: wp.lastOk, fails: wp.fails, error: wp.lastError, latency: wp.latency }); }
async function wpRequest(method, route, body, timeout = 5000) {
  const base = wp.cfg.url.replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await net.fetch(`${base}/wp-json/recital-live/v1${route}`, { method, signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Recital-Key': wp.cfg.key || '' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) throw new Error(res.status === 403 ? 'The site refused the desktop key. Paste the connection code again.' : res.status === 404 ? 'The site has no show with that name, or Recital Live isn\'t installed.' : `The site answered ${res.status}.`);
    wp.latency = Date.now() - t0;
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The site took too long to answer.');
    throw err;
  } finally { clearTimeout(timer); }
}
async function wpPump() {
  if (wp.busy || !wp.cfg || !wp.cfg.url || !wp.cfg.show || Date.now() < wp.nextTry) return;
  const kind = wp.program ? 'program' : wp.status ? 'status' : null;
  if (!kind) return;
  const body = wp[kind]; wp[kind] = null; wp.busy = true;
  try {
    await wpRequest('POST', `/shows/${encodeURIComponent(wp.cfg.show)}/${kind}`, body);
    wp.fails = 0; wp.lastOk = Date.now(); wp.lastError = '';
  } catch (err) {
    if (!wp[kind]) wp[kind] = body; // retry the same data unless newer data arrived
    wp.fails++; wp.lastError = friendly(err);
    wp.nextTry = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(4, wp.fails));
    if (wp.fails === 1 || wp.fails % 10 === 0) log('wordpress send failed', wp.lastError);
  } finally { wp.busy = false; wpReport(); }
}
setInterval(wpPump, 250);
ipcMain.handle('wp:configure', (_e, cfg) => { wp.cfg = cfg && cfg.url ? cfg : null; wp.fails = 0; wp.nextTry = 0; wp.lastError = ''; wpReport(); return true; });
ipcMain.on('wp:program', (_e, p) => { wp.program = p; });
ipcMain.on('wp:status', (_e, s) => { wp.status = s; });
ipcMain.handle('wp:test', async (_e, cfg) => {
  const saved = wp.cfg; wp.cfg = cfg;
  try {
    const ping = await wpRequest('GET', '/ping');
    if (!ping || ping.plugin !== 'recital-live') throw new Error('The site answered, but Recital Live isn\'t installed or active.');
    await wpRequest('POST', `/shows/${encodeURIComponent(cfg.show)}/status`, { state: 'idle', sent_at: Date.now(), message: 'Connected from the desk' });
    return { ok: true, version: ping.version, latency: wp.latency };
  } catch (err) { return { ok: false, error: friendly(err) }; }
  finally { wp.cfg = saved; }
});
