// Choreography Workbook: Electron main process.
// Owns the window, the menu, file dialogs, printing and the .dance share-file format.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const SHARE_EXT = 'dance';
const FORMAT = 1;
let win = null;
let pendingOpen = null; // a .dance path passed on the command line before the page was ready

/* ---------- single instance + file association ---------- */
const findDanceArg = argv => argv.find(a => typeof a === 'string' && a.toLowerCase().endsWith('.' + SHARE_EXT) && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = findDanceArg(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) sendOpen(f); }
  });
  app.whenReady().then(() => {
    pendingOpen = findDanceArg(process.argv);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 640,
    title: 'Choreography Workbook',
    backgroundColor: '#EDF0F5',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Links to websites open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  buildMenu();
}

function sendOpen(filePath) {
  try { win.webContents.send('share:incoming', readShare(filePath)); }
  catch (err) { dialog.showErrorBox('Could not open the file', friendly(err)); }
}

/* ---------- menu ---------- */
function buildMenu() {
  const cmd = name => () => win && win.webContents.send('menu', name);
  const template = [
    { label: 'File', submenu: [
      { label: 'New project from a song…', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
      { label: 'Open share file…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
      { type: 'separator' },
      { label: 'Save share file…', accelerator: 'CmdOrCtrl+S', click: cmd('share') },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd('print') },
      { label: 'Save printout as PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('pdf') },
      { label: 'Make video…', accelerator: 'CmdOrCtrl+Shift+V', click: cmd('video') },
      { type: 'separator' },
      { label: 'Back to library', accelerator: 'CmdOrCtrl+L', click: cmd('library') },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' }
    ]},
    { label: 'Edit', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ] },
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }])
    ]},
    { label: 'Help', submenu: [
      { label: 'Keyboard shortcuts', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Keyboard shortcuts', message: 'Keyboard shortcuts',
          detail: 'Space: play or pause\n← →: back or forward one 8-count\nL: loop this 8-count\nM: mirror video\nCtrl+N: new project\nCtrl+O: open share file\nCtrl+S: save share file\nCtrl+P: print' }) },
      { label: 'About Choreography Workbook', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About', message: `Choreography Workbook ${app.getVersion()}`,
          detail: 'Build, rehearse, print and share choreography. No account needed: your projects stay on this PC.' }) }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- .dance share files ----------
   A .dance file is a zip:
     project.json        counts, sections, notes, dancers, formations (+ format version)
     media/audio.<ext>   optional: the song
     media/video.<ext>   optional: the choreography video
*/
const safeName = s => String(s || 'project').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'project';
const extOf = (name, fallback) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1].toLowerCase() : fallback; };
const friendly = err => (err && err.message) ? err.message : String(err);

function readShare(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('project.json');
  if (!entry) throw new Error("This file wasn't made by Choreography Workbook (no project.json inside).");
  const data = JSON.parse(entry.getData().toString('utf8'));
  if (data.app !== 'choreo-workbook' || !data.project) throw new Error("This file wasn't made by Choreography Workbook.");
  if ((data.format || 1) > FORMAT) throw new Error('This file was made by a newer version of Choreography Workbook. Update the app to open it.');
  const media = {};
  zip.getEntries().forEach(e => {
    const m = /^media\/(audio|video)\.([a-z0-9]+)$/i.exec(e.entryName);
    if (m) { const buf = e.getData(); media[m[1]] = { ext: m[2].toLowerCase(), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }; }
  });
  return { fileName: path.basename(filePath), data, media };
}

ipcMain.handle('share:save', async (_e, { title, data, media }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save share file',
    defaultPath: path.join(app.getPath('documents'), safeName(title) + '.' + SHARE_EXT),
    filters: [{ name: 'Choreography Workbook share file', extensions: [SHARE_EXT] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    const zip = new AdmZip();
    zip.addFile('project.json', Buffer.from(JSON.stringify({ ...data, format: FORMAT }, null, 1), 'utf8'));
    for (const kind of ['audio', 'video']) {
      const m = media && media[kind];
      if (m && m.data) zip.addFile(`media/${kind}.${extOf(m.name, kind === 'audio' ? 'mp3' : 'mp4')}`, Buffer.from(m.data));
    }
    zip.writeZip(res.filePath);
    return { ok: true, path: res.filePath, size: fs.statSync(res.filePath).size };
  } catch (err) { return { ok: false, error: friendly(err) }; }
});

ipcMain.handle('share:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open share file', properties: ['openFile'],
    filters: [{ name: 'Choreography Workbook share file', extensions: [SHARE_EXT] }, { name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try { return { ok: true, ...readShare(res.filePaths[0]) }; }
  catch (err) { return { ok: false, error: friendly(err) }; }
});

ipcMain.handle('share:pending', () => {
  if (!pendingOpen) return null;
  const f = pendingOpen; pendingOpen = null;
  try { return { ok: true, ...readShare(f) }; } catch (err) { return { ok: false, error: friendly(err) }; }
});

/* ---------- printing ---------- */
ipcMain.handle('print', () => new Promise(resolve => {
  win.webContents.print({ printBackground: true }, (ok, reason) => resolve({ ok, reason }));
}));

ipcMain.handle('pdf:save', async (_e, { title }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save printout as PDF',
    defaultPath: path.join(app.getPath('documents'), safeName(title) + ' - count sheet.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { marginType: 'default' } });
    fs.writeFileSync(res.filePath, pdf);
    return { ok: true, path: res.filePath };
  } catch (err) { return { ok: false, error: friendly(err) }; }
});

ipcMain.handle('reveal', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });

/* ---------- video export ----------
   The page renders the MP4 itself (WebCodecs); main only asks where to save it
   and writes the bytes, and only to the path the user just chose. */
let videoPath = null;
ipcMain.handle('video:choose', async (_e, { name }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save video',
    defaultPath: path.join(app.getPath('videos'), safeName(name) + '.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  });
  videoPath = res.canceled || !res.filePath ? null : res.filePath;
  return videoPath;
});
ipcMain.handle('video:write', async (_e, { filePath, data }) => {
  if (!filePath || filePath !== videoPath) return { ok: false, error: 'Choose where to save the video first.' };
  try { fs.writeFileSync(filePath, Buffer.from(data)); videoPath = null; return { ok: true, path: filePath, size: fs.statSync(filePath).size }; }
  catch (err) { return { ok: false, error: friendly(err) }; }
});
