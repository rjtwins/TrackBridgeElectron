const { app, BrowserWindow, ipcMain, shell, screen } = require("electron");
const path = require("path");
const dgram = require("dgram");

const FTNIR_HOST = "127.0.0.1";
const FTNIR_PORT = 5550;
const udp = dgram.createSocket("udp4");

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 200,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // easier for now
      nodeIntegration: false     // keep renderer clean
    }
  });

  win.setContentSize(400, 200);
  win.maximizable = false;
  win.minimizable = true;
  win.resizable = false;

  win.menuBarVisible = false;

  win.webContents.session.on('select-hid-device', (event, data, callback) => {
    event.preventDefault();
    console.log("Device list:", data);

    if (!data.deviceList || data.deviceList.length === 0) {
      console.log("No HID devices found");
      return;
    }

    var deviceList = data.deviceList;
    var device = deviceList[0];
    callback(device.deviceId);
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
    createWindow();
});

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