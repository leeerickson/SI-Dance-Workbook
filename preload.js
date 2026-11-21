// The only bridge between the page and Windows. The page gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbook', {
  isDesktop: true,
  saveShare: payload => ipcRenderer.invoke('share:save', payload),
  openShare: () => ipcRenderer.invoke('share:open'),
  pendingShare: () => ipcRenderer.invoke('share:pending'),
  print: () => ipcRenderer.invoke('print'),
  savePdf: title => ipcRenderer.invoke('pdf:save', { title }),
  reveal: p => ipcRenderer.invoke('reveal', p),
  onIncomingShare: fn => ipcRenderer.on('share:incoming', (_e, share) => fn(share)),
  onMenu: fn => ipcRenderer.on('menu', (_e, name) => fn(name))
});
