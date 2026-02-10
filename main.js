const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const path = require("path");
const dgram = require("dgram");

const FTNIR_HOST = "127.0.0.1";
const FTNIR_PORT = 5550;
const udp = dgram.createSocket("udp4");

let selectedDevice = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // easier for now
      nodeIntegration: false     // keep renderer clean
    }
  });

  win.setContentSize(400, 400);
  win.maximizable = false;
  win.minimizable = true;
  win.resizable = false;

  win.menuBarVisible = false;

  win.webContents.session.on('select-hid-device', async (event, data, callback) => {
    event.preventDefault();
    //console.log("Device list:", data);

    selectedDevice = null;
    
    if (!data.deviceList || data.deviceList.length === 0) {
      console.log("No HID devices found");
      return;
    }

    win.webContents.send('hid-device-list', data.deviceList);

    while(selectedDevice === null) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const deviceId = selectedDevice.deviceId;
    selectedDevice = null;

    console.log("Selected HID device ID:", deviceId);

    callback(deviceId);
  });

  win.loadFile("public/index.html");

  // Optional: DevTools
  //win.webContents.openDevTools();

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(() => {
    ipcMain.on('send-tracking-data', processTrackingData);
    ipcMain.on('send-device-selection', processDeviceSelection);
    createWindow();
});

function processDeviceSelection(event, device) {
  selectedDevice = device;
}

function processTrackingData(event, r) {
    const buffer = new ArrayBuffer(48);
    const view = new DataView(buffer);

    view.setFloat64(0,  r.x,     true);
    view.setFloat64(8,  r.y,     true);
    view.setFloat64(16, r.z,     true);
    view.setFloat64(24, r.yaw,   true);
    view.setFloat64(32, r.pitch, true);
    view.setFloat64(40, r.roll,  true);

    const nodeBuffer = Buffer.from(buffer);

    udp.send(nodeBuffer, 0, nodeBuffer.byteLength, FTNIR_PORT, FTNIR_HOST);
}