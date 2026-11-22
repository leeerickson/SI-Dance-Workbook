// Recital Show Player: Electron main process.
// Owns the window, the media protocol, show files, autosave, crash recovery,
// the WordPress status sender and the system-utilization numbers.
// Built to keep a live show running: nothing here waits on the network, and a
// crashed page is reloaded and picks up where it was.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, powerSaveBlocker, powerMonitor, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { spawn, execFileSync } = require('child_process');
const nodeNet = require('net');

const SHOW_EXT = 'recital';
const FORMAT = 1;
const APP_DIR = path.join(__dirname, 'app');
const MEDIA_EXT = /\.(mp3|wav|wave|aif|aiff|flac|ogg|oga|opus|m4a|aac|mp4|m4v|mov|webm|mkv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|svg|gif)$/i; // studio logo for the stream picture
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', woff2: 'font/woff2', png: 'image/png', svg: 'image/svg+xml', json: 'application/json',
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska'
};

// Keep audio and timers running at full speed even when the window is covered or minimised.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// On Windows, a window it thinks is covered (e.g. by full-screen video on a duplicated screen) stops updating. Not for a show controller.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// "Software drawing" (Settings): turns off the graphics card for drawing, for computers whose graphics
// driver flickers, goes black or freezes. Read from a small file before start-up, because it can't change later.
const STARTUP_FILE = path.join(process.env.SHOW_PLAYER_DATA || app.getPath('userData'), 'startup.json');
const startupPrefs = (() => { try { return JSON.parse(fs.readFileSync(STARTUP_FILE, 'utf8')); } catch (_) { return {}; } })();
if (startupPrefs.softwareDrawing) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{ scheme: 'show', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let userDir = null;
let pendingOpen = null;
let liveSnapshot = null;   // latest playback state from the page, kept here so it survives a page crash
let crashedAt = 0;
let crashTimes = [];      // recent page crashes, to stop a crash loop from auto-resuming forever
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

  cleanOldLogs();
  app.on('child-process-gone', (_e, d) => {
    log('helper process stopped', d);
    if (d.type === 'GPU' && win && !win.isDestroyed()) win.webContents.send('gpu:gone');
  });
  protocol.handle('show', handleShowProtocol);
  createWindow();
  startStats();
  // Tell the page when a projector or screen is plugged in or out.
  const changed = () => { if (win && !win.isDestroyed()) win.webContents.send('displays:changed'); };
  screen.on('display-added', (_e, d) => { log('screen connected', d.label || d.id); changed(); });
  screen.on('display-removed', (_e, d) => { log('screen disconnected', d.label || d.id); changed(); });
}

// Logs older than 30 days are deleted, so the log folder can't fill the disk.
function cleanOldLogs() {
  const dir = path.join(userDir, 'logs');
  fs.promises.readdir(dir).then(files => files.forEach(f => {
    const full = path.join(dir, f);
    fs.promises.stat(full).then(st => { if (Date.now() - st.mtimeMs > 30 * 86400000) fs.promises.unlink(full).catch(() => {}); }).catch(() => {});
  })).catch(() => {});
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
      if (!MEDIA_EXT.test(file) && !IMAGE_EXT.test(file)) return new Response('Not a media file', { status: 403 });
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
    crashTimes = crashTimes.filter(t => Date.now() - t < 3 * 60 * 1000).concat(Date.now());
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
      { label: 'Copy all files into the show folder…', click: cmd('collect') },
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
    filters: [{ name: 'Music, video and .dance files', extensions: ['dance', 'mp3', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'mp4', 'm4v', 'mov', 'webm', 'mkv'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.filter(p => MEDIA_EXT.test(p) || /\.dance$/i.test(p)).map(mediaInfo));
});
ipcMain.handle('media:stat', (_e, paths) => Promise.all((paths || []).map(mediaInfo)));
// A .dance file from the Choreography Workbook: a zip with project.json and (when shared with "Everything")
// the song. The song is copied into this app's own folder; sections and formations become cues at their times.
ipcMain.handle('dance:import', async (_e, { filePath, withCues }) => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('project.json');
    if (!entry) return { error: "This isn't a Choreography Workbook file." };
    const data = JSON.parse(entry.getData().toString('utf8'));
    const p = data && data.project;
    if (!p || data.app !== 'choreo-workbook') return { error: "This isn't a Choreography Workbook file." };
    const title = String(p.title || path.basename(filePath, path.extname(filePath))).slice(0, 120);
    const audio = zip.getEntries().find(e => /^media\/audio\.[a-z0-9]+$/i.test(e.entryName));
    if (!audio) return { error: 'no-music', title };
    const ext = path.extname(audio.entryName).slice(1).toLowerCase();
    if (!MEDIA_EXT.test('x.' + ext)) return { error: `The music inside is a .${ext} file, which this app can't play.`, title };
    const buf = audio.getData();
    const dir = path.join(userDir, 'dance-imports');
    await fs.promises.mkdir(dir, { recursive: true });
    const hash = require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Dance';
    const dest = path.join(dir, `${safe} ${hash}.${ext}`);
    if (!fs.existsSync(dest)) await fs.promises.writeFile(dest, buf);
    const beat = 60 / (Number(p.bpm) || 120), offset = Number(p.offset) || 0, phrase = Number(p.phrase) || 8;
    const cues = [];
    if (withCues) {
      for (const s of Array.isArray(p.sections) ? p.sections : []) {
        const t = offset + (Math.max(1, Number(s.start) || 1) - 1) * phrase * beat;
        if (s && s.name && isFinite(t)) cues.push({ t: Math.round(t * 10) / 10, type: 'note', text: String(s.name).slice(0, 80) });
      }
      for (const f of Array.isArray(p.formations) ? p.formations : []) {
        const t = offset + (Number(f.at) || 0) * beat;
        if (f && f.name && isFinite(t)) cues.push({ t: Math.round(t * 10) / 10, type: 'stage', text: ('Formation: ' + String(f.name)).slice(0, 80) });
      }
      cues.sort((a, b) => a.t - b.t);
    }
    const props = (Array.isArray(p.props) ? p.props : []).map(x => x && x.name ? String(x.name).slice(0, 60) : '').filter(Boolean);
    log('imported .dance', title, { cues: cues.length, props: props.length });
    return { info: await mediaInfo(dest), meta: { dance: title, cls: String(p.style || '').slice(0, 60), cues, props, title: p.audio && p.audio.name ? String(p.audio.name).replace(/\.[^.]+$/, '').slice(0, 120) : title } };
  } catch (err) { log('.dance import failed', filePath, friendly(err)); return { error: "The file couldn't be read. It may be damaged." }; }
});
ipcMain.handle('image:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the studio logo', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'] }] });
  return r.canceled ? null : r.filePaths[0];
});

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
  // Three crashes in three minutes: stand by instead of carrying on, so a bad file can't crash it over and over.
  const loop = crashTimes.filter(t => Date.now() - t < 3 * 60 * 1000).length >= 3;
  crashedAt = 0;
  if (snap && !snap.fromLastRun) liveSnapshot = { ...snap }; // keep for another crash
  return snap ? { ...snap, crashed: !!crashed, crashLoop: loop, now: Date.now() } : null;
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
ipcMain.handle('startup:get', () => startupPrefs);
ipcMain.handle('startup:set', async (_e, prefs) => { Object.assign(startupPrefs, prefs || {}); await writeAtomic(STARTUP_FILE, JSON.stringify(startupPrefs)); return startupPrefs; });
// Restarts the whole app (used when the sound card stops answering). The page stands by on the song it was on.
ipcMain.handle('app:relaunch', () => { log('relaunch requested'); app.forceQuit = true; app.relaunch(); app.exit(0); });
ipcMain.handle('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

// Copies every music, video and sound file into a folder next to the show file, so the show no longer
// depends on a USB stick, a network drive or someone's Downloads folder. Returns { oldPath: newPath }.
ipcMain.handle('media:collect', async (_e, { showPath, paths }) => {
  if (!showPath) throw new Error('Save the show first.');
  const dir = path.join(path.dirname(showPath), path.basename(showPath, path.extname(showPath)) + ' files');
  await fs.promises.mkdir(dir, { recursive: true });
  const out = {}, used = new Set();
  let copied = 0, skipped = 0;
  for (const src of [...new Set(paths)]) {
    try {
      if (path.dirname(src) === dir) { out[src] = src; skipped++; continue; }
      const st = await fs.promises.stat(src);
      let name = path.basename(src), dest = path.join(dir, name), n = 1;
      // a different file with the same name gets a number added
      while (used.has(dest.toLowerCase()) || (fs.existsSync(dest) && fs.statSync(dest).size !== st.size)) { dest = path.join(dir, `${path.basename(name, path.extname(name))} (${++n})${path.extname(name)}`); }
      used.add(dest.toLowerCase());
      if (!fs.existsSync(dest)) { await fs.promises.copyFile(src, dest); await fs.promises.utimes(dest, st.atime, st.mtime).catch(() => {}); copied++; } else skipped++;
      out[src] = dest;
    } catch (err) { log('collect failed', src, friendly(err)); }
    if (win && !win.isDestroyed()) win.webContents.send('media:collect-progress', { done: Object.keys(out).length, total: paths.length });
  }
  log('collected media', dir, { copied, skipped });
  return { dir, map: out, copied, skipped };
});

/* ---------- live system numbers ----------
   Once a second: CPU for the whole computer and for each core, this app's CPU and memory split by
   process (main, screen, graphics, helpers), memory, graphics-card load where the system reports it,
   how late the main process's own timer fired, free disk space and power. */
let lastCores = null;
function cpuSample() {
  const now = os.cpus().map(c => { const total = Object.values(c.times).reduce((x, y) => x + y, 0); return { total, idle: c.times.idle }; });
  const prev = lastCores; lastCores = now;
  if (!prev || prev.length !== now.length) return { all: 0, cores: now.map(() => 0) };
  const cores = now.map((c, i) => { const dt = c.total - prev[i].total; return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - (c.idle - prev[i].idle) / dt))) : 0; });
  const dTotal = now.reduce((a, c, i) => a + c.total - prev[i].total, 0), dIdle = now.reduce((a, c, i) => a + c.idle - prev[i].idle, 0);
  return { all: dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal))) : 0, cores };
}
// Graphics-card load. Windows reports it per engine and per program through performance counters; one small
// helper (typeperf, part of Windows) prints them every 2 s. Other systems don't offer this, so the page shows
// the graphics process's CPU and memory instead. Never essential: any failure just means "not available".
const gpu = { util: null, source: '', proc: null, cols: null, buf: '', timer: null };
function parseGpuHeader(line) { // column -> engine type, from names like \\PC\GPU Engine(pid_1_luid_..._engtype_3D)\Utilization Percentage
  return line.split('","').map(h => { const m = /engtype_([A-Za-z0-9 ]+)\)/.exec(h); return m ? m[1] : null; });
}
function parseGpuRow(line, cols) { // busiest engine type = what Task Manager shows
  const cells = line.replace(/^"|"$/g, '').split('","'), sums = {};
  for (let i = 1; i < cells.length; i++) { const k = cols[i]; const v = parseFloat(cells[i]); if (k && isFinite(v)) sums[k] = (sums[k] || 0) + v; }
  const vals = Object.values(sums);
  return vals.length ? Math.max(0, Math.min(100, Math.max(...vals))) : null;
}
function startGpuSampler() {
  if (process.platform !== 'win32' || process.env.SHOW_PLAYER_NO_GPU_SAMPLER) return;
  const launch = () => {
    try {
      const proc = spawn('typeperf', ['\\GPU Engine(*)\\Utilization Percentage', '-si', '2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch (_) {}
      gpu.proc = proc; gpu.cols = null; gpu.buf = '';
      proc.stdout.on('data', d => {
        gpu.buf += d.toString();
        let i;
        while ((i = gpu.buf.indexOf('\n')) >= 0) {
          const line = gpu.buf.slice(0, i).trim(); gpu.buf = gpu.buf.slice(i + 1);
          if (!line.startsWith('"')) continue;
          if (!gpu.cols) { if (/GPU Engine/i.test(line)) gpu.cols = parseGpuHeader(line); continue; }
          const v = parseGpuRow(line, gpu.cols);
          if (v != null) { gpu.util = v; gpu.source = 'windows'; gpu.at = Date.now(); }
        }
        if (gpu.buf.length > 1e6) gpu.buf = '';
      });
      proc.on('error', () => { gpu.proc = null; });
      proc.on('exit', () => { if (gpu.proc === proc) gpu.proc = null; });
    } catch (_) { gpu.proc = null; }
  };
  launch();
  // The list of programs using the graphics card is fixed when the helper starts, so start it afresh every 2 minutes.
  gpu.timer = setInterval(() => { try { if (gpu.proc) gpu.proc.kill(); } catch (_) {} launch(); }, 120000);
  app.on('before-quit', () => { clearInterval(gpu.timer); try { if (gpu.proc) gpu.proc.kill(); } catch (_) {} });
}
const power = { onBattery: null, thermal: '', lastResume: 0 };
function startPowerWatch() {
  const tell = what => { log('power', what); if (win && !win.isDestroyed()) win.webContents.send('power', { what, onBattery: power.onBattery, thermal: power.thermal }); };
  try { power.onBattery = powerMonitor.isOnBatteryPower(); } catch (_) {}
  powerMonitor.on('on-battery', () => { power.onBattery = true; tell('on-battery'); });
  powerMonitor.on('on-ac', () => { power.onBattery = false; tell('on-ac'); });
  powerMonitor.on('suspend', () => tell('suspend'));
  powerMonitor.on('resume', () => { power.lastResume = Date.now(); tell('resume'); });
  powerMonitor.on('thermal-state-change', e => { power.thermal = e && e.state || ''; tell('thermal ' + power.thermal); });
  powerMonitor.on('speed-limit-change', e => { if (e && e.limit < 100) { power.thermal = `slowed to ${e.limit}%`; tell('cpu ' + power.thermal); } else power.thermal = ''; });
}
let mainLag = 0, lagMark = Date.now(), diskFree = null, diskAt = 0;
setInterval(() => { const n = Date.now(); const late = n - lagMark - 250; lagMark = n; if (late > mainLag) mainLag = late; }, 250);
const PROC_NAMES = { Browser: 'Main', Tab: 'Screen', GPU: 'Graphics', Utility: 'Helpers' };
function startStats() {
  const cores = os.cpus().length || 1;
  startGpuSampler(); startPowerWatch();
  setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      const metrics = app.getAppMetrics();
      const procs = {};
      for (const m of metrics) {
        const k = PROC_NAMES[m.type] || 'Helpers';
        const pr = procs[k] || (procs[k] = { cpu: 0, mem: 0, n: 0 });
        pr.cpu += m.cpu ? m.cpu.percentCPUUsage : 0; pr.mem += (m.memory ? m.memory.workingSetSize : 0) * 1024; pr.n++;
      }
      const appCpuCores = Object.values(procs).reduce((a, x) => a + x.cpu, 0); // percent of ONE core
      const appMem = Object.values(procs).reduce((a, x) => a + x.mem, 0);
      const c = cpuSample();
      if (Date.now() - diskAt > 30000) { diskAt = Date.now(); fs.promises.statfs(userDir).then(st => { diskFree = st.bavail * st.bsize; }).catch(() => {}); }
      const gpuFresh = gpu.util != null && Date.now() - (gpu.at || 0) < 10000;
      win.webContents.send('stats', { t: Date.now(), cpu: c.all, cores: c.cores, coreCount: cores, appCpu: Math.min(100, appCpuCores / cores), appCpuCores, appMem, procs,
        freeMem: os.freemem(), totalMem: os.totalmem(), gpu: gpuFresh ? gpu.util : null, gpuSource: gpuFresh ? gpu.source : '', mainLag, disk: diskFree,
        onBattery: power.onBattery, thermal: power.thermal, uptime: Math.round(process.uptime()), platform: process.platform });
      mainLag = 0;
    } catch (err) { log('stats error', friendly(err)); }
  }, 1000);
}
if (process.env.SHOW_PLAYER_SELFTEST_GPU) { // used by the test: parse a sample of the Windows counter output
  const head = '"(PDH-CSV 4.0)","\\\\PC\\GPU Engine(pid_10_luid_0x0_0x1_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\GPU Engine(pid_22_luid_0x0_0x1_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\GPU Engine(pid_22_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode)\\Utilization Percentage"';
  ipcMain.handle('selftest:gpu', () => parseGpuRow('"11/22/2026 12:00:00.000","12.500000","30.250000","8.000000"', parseGpuHeader(head)));
}

/* ---------- WordPress status sender ----------
   Keeps only the newest program and status, sends them one at a time with a short timeout,
   and backs off when the site can't be reached. The page never waits for any of this. */
const wp = { chatAfter: 0, cfg: null, program: null, status: null, busy: false, fails: 0, nextTry: 0, lastOk: 0, lastError: '', latency: 0 };
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
    // Crew chat rides on the status reply: tell the site the newest message we have, get back anything newer.
    const reply = await wpRequest('POST', `/shows/${encodeURIComponent(wp.cfg.show)}/${kind}`, kind === 'status' ? { ...body, chat_after: wp.chatAfter } : body);
    wp.fails = 0; wp.lastOk = Date.now(); wp.lastError = '';
    if (kind === 'status' && reply) wpChatIn(reply.chat, reply.chat_on);
  } catch (err) {
    if (!wp[kind]) wp[kind] = body; // retry the same data unless newer data arrived
    wp.fails++; wp.lastError = friendly(err);
    wp.nextTry = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(4, wp.fails));
    if (wp.fails === 1 || wp.fails % 10 === 0) log('wordpress send failed', wp.lastError);
  } finally { wp.busy = false; wpReport(); }
}
setInterval(wpPump, 250);
function wpChatIn(list, on) {
  const fresh = (Array.isArray(list) ? list : []).filter(m => m && typeof m.id === 'number' && m.id > wp.chatAfter);
  if (fresh.length) wp.chatAfter = Math.max(...fresh.map(m => m.id));
  if (win && !win.isDestroyed()) win.webContents.send('wp:chat', { on: !!on, messages: fresh });
}
ipcMain.handle('wp:chat-send', async (_e, payload) => {
  if (!wp.cfg || !wp.cfg.url) return { ok: false, error: 'Phones are off. Turn them on in Settings → Phones.' };
  try {
    const r = await wpRequest('POST', `/shows/${encodeURIComponent(wp.cfg.show)}/chat`, payload);
    if (payload.clear) { wp.chatAfter = Date.now(); return { ok: true }; }
    if (r && r.message) wpChatIn([r.message], true);
    return { ok: true };
  } catch (err) { return { ok: false, error: /refused the desktop key/.test(friendly(err)) ? 'Chat needs a crew code on the show (set one in WordPress under Recital Live).' : friendly(err) }; }
});
ipcMain.handle('wp:configure', (_e, cfg) => { const same = wp.cfg && cfg && wp.cfg.url === cfg.url && wp.cfg.show === cfg.show; if (!same) wp.chatAfter = 0; wp.cfg = cfg && cfg.url ? cfg : null; wp.fails = 0; wp.nextTry = 0; wp.lastError = ''; wpReport(); return true; });
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

/* ---------- live streaming ----------
   The page records the show's sound and a picture (the video, or a title card) and sends the recording
   here in small pieces. ffmpeg turns it into a live stream (H.264 + AAC over RTMP) for StreamingIdiot or
   any service that takes an RTMP address. ffmpeg runs at low priority, so streaming can never starve the
   show, and if the connection drops the page starts it again. */
function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p && app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* not bundled */ }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}
const stream = { proc: null, gen: 0, startedAt: 0, bytes: 0, lastStats: '', queued: 0, wanted: false, error: '', audio: null };
// Sound goes to ffmpeg over its own local connection as raw samples, separate from the picture (which comes on stdin),
// so a busy moment drawing or compressing the picture can never drop or click the sound.
function audioPipe() {
  const a = { server: null, sock: null, pending: [], pendingBytes: 0, port: 0 };
  a.server = nodeNet.createServer(sock => {
    if (a.sock) { sock.destroy(); return; }
    a.sock = sock; sock.setNoDelay(true);
    sock.on('error', err => log('stream audio connection error', friendly(err)));
    for (const b of a.pending) sock.write(b);
    a.pending = []; a.pendingBytes = 0;
  });
  a.server.on('error', err => log('stream audio server error', friendly(err)));
  return new Promise(res => a.server.listen(0, '127.0.0.1', () => { a.port = a.server.address().port; res(a); }));
}
function closeAudioPipe(a) { if (!a) return; try { a.sock && a.sock.end(); } catch (_) {} try { a.server.close(); } catch (_) {} }
function streamReport(extra = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('stream:state', { gen: stream.gen, live: !!stream.proc, startedAt: stream.startedAt, bytes: stream.bytes, stats: stream.lastStats, error: stream.error, queued: stream.queued, ...extra });
}
ipcMain.handle('stream:check', () => {
  try { const out = execFileSync(ffmpegPath(), ['-hide_banner', '-version'], { timeout: 8000 }).toString(); return { ok: true, version: (out.split('\n')[0] || '').slice(0, 80) }; }
  catch (err) { return { ok: false, error: 'ffmpeg, which streaming needs, could not be found.' }; }
});
ipcMain.handle('stream:start', async (_e, cfg) => {
  if (stream.proc) return { ok: true, gen: stream.gen };
  const target = process.env.SHOW_PLAYER_STREAM_OUT || (String(cfg.url || '').replace(/\/+$/, '') + (cfg.key ? '/' + cfg.key : ''));
  if (!process.env.SHOW_PLAYER_STREAM_OUT && !/^rtmps?:\/\//i.test(target)) return { ok: false, error: 'The stream address must start with rtmp:// or rtmps://' };
  const kbps = cfg.quality === '480' ? 1200 : 2500, size = cfg.quality === '480' ? '854:480' : '1280:720';
  const rate = Math.round(+cfg.audioRate || 48000);
  const audio = await audioPipe();
  const args = ['-hide_banner', '-loglevel', 'error', '-stats',
    '-thread_queue_size', '512', '-fflags', '+genpts', '-i', 'pipe:0',
    '-thread_queue_size', '4096', '-f', 's16le', '-ar', String(rate), '-ac', '2', '-i', `tcp://127.0.0.1:${audio.port}`,
    '-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000:first_pts=0',
    '-vf', `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-f', 'flv', target];
  try {
    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
    const gen = ++stream.gen;
    closeAudioPipe(stream.audio); stream.audio = audio;
    stream.proc = proc; stream.startedAt = Date.now(); stream.bytes = 0; stream.queued = 0; stream.error = ''; stream.wanted = true;
    proc.stdin.on('error', err => log('stream input error', friendly(err)));
    proc.stderr.on('data', d => {
      const txt = d.toString();
      const m = /frame=\s*\d+.*?bitrate=\s*([\d.]+\S*).*?speed=\s*([\d.]+x)/.exec(txt);
      if (m) stream.lastStats = `${m[1]} · ${m[2]}`;
      else if (txt.trim()) { stream.error = txt.trim().split('\n').pop().slice(0, 200); log('stream', stream.error); }
    });
    proc.on('error', err => { stream.error = /ENOENT/.test(String(err)) ? 'ffmpeg, which streaming needs, could not be found.' : friendly(err); log('stream failed to start', stream.error); });
    proc.on('exit', (code, signal) => {
      log('stream ended', { code, signal });
      if (stream.proc === proc) { stream.proc = null; closeAudioPipe(stream.audio); stream.audio = null; }
      if (gen === stream.gen) streamReport({ ended: true, code, gen });
    });
    log('stream started', process.env.SHOW_PLAYER_STREAM_OUT ? 'test file' : target.replace(/\/[^/]*$/, '/•••'), `${cfg.quality || '720'}p`);
    streamReport();
    return { ok: true, gen };
  } catch (err) { return { ok: false, error: friendly(err) }; }
});
ipcMain.on('stream:data', (_e, buf) => {
  const p = stream.proc; if (!p || !p.stdin.writable) return;
  const b = Buffer.from(buf);
  stream.bytes += b.length;
  stream.queued = p.stdin.writableLength;
  // If ffmpeg (or the internet connection) can't keep up, stop rather than let memory grow. The page restarts it.
  if (p.stdin.writableLength > 64 * 1024 * 1024) { log('stream backed up; restarting'); stream.error = 'The connection is too slow for this quality.'; p.kill('SIGKILL'); return; }
  p.stdin.write(b);
});
ipcMain.on('stream:pcm', (_e, buf) => {
  const a = stream.audio; if (!a || !stream.proc) return;
  const b = Buffer.from(buf);
  if (a.sock && a.sock.writable) {
    if (a.sock.writableLength > 8 * 1024 * 1024) { log('stream audio backed up; restarting'); stream.error = 'The connection is too slow for this quality.'; stream.proc.kill('SIGKILL'); return; }
    a.sock.write(b);
  } else if (a.pendingBytes < 4 * 1024 * 1024) { a.pending.push(b); a.pendingBytes += b.length; } // until ffmpeg connects (about a second)
});
ipcMain.handle('stream:stop', () => {
  stream.wanted = false;
  const p = stream.proc; if (!p) return true;
  stream.proc = null; stream.gen++; // anything this ffmpeg says from now on is ignored
  const a = stream.audio; stream.audio = null;
  try { p.stdin.end(); } catch (_) {}
  closeAudioPipe(a);
  setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 4000);
  streamReport();
  return true;
});
setInterval(() => { if (stream.proc) streamReport(); }, 1000);
app.on('before-quit', () => { if (stream.proc) { try { stream.proc.kill('SIGKILL'); } catch (_) {} } });
