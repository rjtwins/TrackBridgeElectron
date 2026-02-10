const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('electronAPI', {
  sendTrackingData: (data) => ipcRenderer.send('send-tracking-data', data)
})