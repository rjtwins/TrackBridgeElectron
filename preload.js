const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('electronAPI', {
  sendTrackingData: (data) => ipcRenderer.send('send-tracking-data', data),
  onHidDeviceList: (callback) => ipcRenderer.on('hid-device-list', (_event, value) => callback(value)),
  sendDeviceSelection: (data) => ipcRenderer.send('send-device-selection', data),
})