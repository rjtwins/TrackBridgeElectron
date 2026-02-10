/**
 * Viture HID Driver for WebXR Extension
 * Handles WebHID communication with Viture XR glasses
 */

// Debug flag - set to true for verbose logging
var VITURE_DEBUG = false;

function debugLog(...args) {
  if (VITURE_DEBUG) console.log(...args);
}

function debugWarn(...args) {
  if (VITURE_DEBUG) console.warn(...args);
}

// CRC-16-CCITT lookup table (polynomial 0x1021)
const CRC_TABLE = new Uint16Array(256);
(function initCrcTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
    CRC_TABLE[i] = crc & 0xFFFF;
  }
})();

function calcCrc16(data, start, length) {
  let crc = 0xFFFF;
  for (let i = start; i < start + length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ data[i]) & 0xFF]) & 0xFFFF;
  }
  return crc;
}

class VitureHID {
  // Viture USB identifiers
  static VENDOR_ID = 0x35ca;
  static PRODUCT_IDS = {
    ONE: [0x1011, 0x1013, 0x1017],
    ONE_LITE: [0x1015, 0x101b],
    PRO: [0x1019, 0x101d],
    LUMA_PRO: [0x1121, 0x1141],
    LUMA: [0x1131]
  };

  static get ALL_PRODUCT_IDS() {
    return [
      ...this.PRODUCT_IDS.ONE,
      ...this.PRODUCT_IDS.ONE_LITE,
      ...this.PRODUCT_IDS.PRO,
      ...this.PRODUCT_IDS.LUMA_PRO,
      ...this.PRODUCT_IDS.LUMA
    ];
  }

  constructor() {
    this.device = null;        // Primary device (for IMU data)
    this.mcuDevice = null;     // MCU device (for commands)
    this.imuDevice = null;     // IMU device (for orientation data)
    this.connected = false;
    this.quaternion = { w: 1, x: 0, y: 0, z: 0 };
    this.calibrationOffset = { w: 1, x: 0, y: 0, z: 0 };
    this.rotation = { yaw: 0, pitch: 0, roll: 0 };
    this.callbacks = new Set();
    this.callbacksRot = new Set();
    this._animationFrame = null;
    this._msgCounter = 0;
  }

  /**
   * Build a command packet for Viture MCU
   * Packet structure:
   * - Header: 0xFF 0xFE (MCU)
   * - CRC: 2 bytes at offset 2
   * - Length: 2 bytes at offset 4 (little-endian)
   * - Reserved: 8 bytes at offset 6
   * - Command ID: 2 bytes at offset 14 (little-endian)
   * - Data: variable length at offset 16
   * - End marker: 0x03
   */
  _buildMcuCommand(cmdId, dataBytes) {
    const dataLen = dataBytes ? dataBytes.length : 0;
    const packetLen = 18 + dataLen + 1; // header(2) + crc(2) + len(2) + reserved(8) + cmd(2) + msg_counter(2) + data + end(1)
    const packet = new Uint8Array(packetLen);

    // Header
    packet[0] = 0xFF;
    packet[1] = 0xFE;

    // Length (little-endian, includes everything from reserved onwards)
    const payloadLen = 8 + 2 + 2 + dataLen + 1; // reserved + cmd + msg_counter + data + end
    packet[4] = payloadLen & 0xFF;
    packet[5] = (payloadLen >> 8) & 0xFF;

    // Reserved bytes (offset 6-13): zeros
    // Already zero from Uint8Array initialization

    // Command ID (little-endian, offset 14-15)
    packet[14] = cmdId & 0xFF;
    packet[15] = (cmdId >> 8) & 0xFF;

    // Message counter (offset 16-17) - not strictly needed but included
    this._msgCounter = (this._msgCounter + 1) & 0xFFFF;
    packet[16] = this._msgCounter & 0xFF;
    packet[17] = (this._msgCounter >> 8) & 0xFF;

    // Data (offset 18+)
    if (dataBytes && dataLen > 0) {
      packet.set(dataBytes, 18);
    }

    // End marker
    packet[packetLen - 1] = 0x03;

    // Calculate CRC over everything from offset 4 onwards (excluding header and CRC itself)
    const crc = calcCrc16(packet, 4, packetLen - 4);
    packet[2] = (crc >> 8) & 0xFF;
    packet[3] = crc & 0xFF;

    return packet;
  }

  static isSupported() {
    return 'hid' in navigator;
  }

  async connect() {
    if (!VitureHID.isSupported()) {
      throw new Error('WebHID not supported');
    }

    const filters = VitureHID.ALL_PRODUCT_IDS.map(productId => ({
      vendorId: VitureHID.VENDOR_ID,
      productId: productId
    }));

    // Request device (user picks one)
    const selectedDevices = await navigator.hid.requestDevice({ filters });

    if (selectedDevices.length === 0) {
      throw new Error('No Viture device selected');
    }

    console.log('Viture: User selected', selectedDevices.length, 'device(s)');

    // After user authorizes, get ALL authorized Viture devices
    const allAuthorized = await navigator.hid.getDevices();
    const vitureDevices = allAuthorized.filter(d =>
      d.vendorId === VitureHID.VENDOR_ID &&
      VitureHID.ALL_PRODUCT_IDS.includes(d.productId)
    );

    console.log(`Viture: Found ${vitureDevices.length} authorized Viture device(s)`);

    // Open and listen on ALL Viture devices
    for (let i = 0; i < vitureDevices.length; i++) {
      const device = vitureDevices[i];
      try {
        if (!device.opened) {
          console.log(`Viture: Opening device ${i + 1}/${vitureDevices.length}...`);
          await device.open();
        }
        device.addEventListener('inputreport', (event) => this._handleInputReport(event, i));
        console.log(`Viture: Device ${i + 1} ready`);
      } catch (e) {
        console.warn(`Viture: Failed to open device ${i + 1}:`, e.message);
      }
    }

    this.device = vitureDevices[0];
    this._allDevices = vitureDevices;
    this.connected = true;

    // Try to start IMU data stream
    await this._startIMU();

    // Notify extension
    window.postMessage({
      type: 'VITURE_DEVICE_CONNECTED',
      deviceInfo: this._getDeviceInfo()
    }, '*');

    return this._getDeviceInfo();
  }

  async _startIMU() {
    const devices = this._allDevices || (this.device ? [this.device] : []);
    if (devices.length === 0) return;

    // Log info for all devices
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      console.log(`Viture: Device ${i + 1} info:`);
      console.log('  Product name:', device.productName);
      console.log('  VID:', device.vendorId.toString(16), 'PID:', device.productId.toString(16));
      console.log('  Collections:', device.collections?.length || 0);
      if (device.collections) {
        device.collections.forEach((collection, idx) => {
          console.log(`  Collection ${idx}: usagePage=0x${collection.usagePage?.toString(16)}, usage=0x${collection.usage?.toString(16)}`);
        });
      }
    }

    try {
      console.log('Viture: Sending IMU enable command (cmd 0x15, data 0x01) to all devices...');

      // Build the proper MCU command packet for IMU enable
      const imuEnableCmd = this._buildMcuCommand(0x15, new Uint8Array([0x01]));
      console.log('Viture: IMU enable packet:', Array.from(imuEnableCmd).map(b => b.toString(16).padStart(2, '0')).join(' '));

      // Send to ALL devices
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        if (!device.opened) continue;

        console.log(`Viture: Sending commands to device ${i + 1}...`);

        // Try sending with report ID 0
        try {
          await device.sendReport(0x00, imuEnableCmd);
          console.log(`Viture: Device ${i + 1}: Sent IMU enable command`);
        } catch (e) {
          debugLog(`Viture: Device ${i + 1}: sendReport failed:`, e.message);
        }

        // Also try simpler commands
        const simpleCommands = [
          new Uint8Array([0xFF, 0xFE, 0x15, 0x01]),
          new Uint8Array([0x15, 0x01]),
          new Uint8Array([0x01]),
        ];

        for (const cmd of simpleCommands) {
          try {
            await device.sendReport(0x00, cmd);
          } catch (e) {
            // Ignore
          }
        }
      }

      console.log('Viture: IMU initialization complete, waiting for data from all devices...');

      // Diagnostic timer
      setTimeout(() => {
        const totalReports = this._reportCount || 0;
        if (totalReports === 0) {
          console.warn('Viture: No input reports received after 3 seconds!');
        } else {
          console.log(`Viture: Received ${totalReports} total input reports`);
          if (this._reportCounts) {
            for (const [idx, count] of Object.entries(this._reportCounts)) {
              console.log(`  Device ${parseInt(idx) + 1}: ${count} reports`);
            }
          }
        }
      }, 3000);

    } catch (error) {
      console.warn('Viture: Error during IMU initialization:', error);
    }
  }

  async checkExistingConnection() {
    if (!VitureHID.isSupported()) return false;

    debugLog('Viture: Checking for existing connections...');
    const devices = await navigator.hid.getDevices();
    debugLog('Viture: Found', devices.length, 'previously authorized devices');

    // Collect ALL matching Viture devices (there are typically 2: MCU and IMU interfaces)
    const vitureDevices = [];
    for (const device of devices) {
      debugLog('Viture: Checking device VID:', device.vendorId.toString(16), 'PID:', device.productId.toString(16));

      if (device.vendorId === VitureHID.VENDOR_ID &&
          VitureHID.ALL_PRODUCT_IDS.includes(device.productId)) {
        debugLog('Viture: Found matching device:', device.productName);
        vitureDevices.push(device);
      }
    }

    if (vitureDevices.length === 0) {
      debugLog('Viture: No matching devices found');
      return false;
    }

    console.log(`Viture: Found ${vitureDevices.length} Viture device(s), opening all...`);

    // Open ALL Viture devices and add listeners
    for (let i = 0; i < vitureDevices.length; i++) {
      const device = vitureDevices[i];
      try {
        if (!device.opened) {
          console.log(`Viture: Opening device ${i + 1}/${vitureDevices.length}...`);
          await device.open();
        }

        console.log(`Viture: Device ${i + 1} collections:`, device.collections);

        // Add input report listener to ALL devices
        device.addEventListener('inputreport', (event) => this._handleInputReport(event, i));

      } catch (e) {
        console.warn(`Viture: Failed to open device ${i + 1}:`, e.message);
      }
    }

    // Store all devices
    this.device = vitureDevices[0];  // Primary device for backward compatibility
    this._allDevices = vitureDevices;
    this.connected = true;

    // Try to start IMU (send command to all devices)
    await this._startIMU();

    window.postMessage({
      type: 'VITURE_DEVICE_CONNECTED',
      deviceInfo: this._getDeviceInfo()
    }, '*');

    return true;
  }

  async disconnect() {
    // Close all devices
    if (this._allDevices) {
      for (const device of this._allDevices) {
        if (device && device.opened) {
          try {
            await device.close();
          } catch (e) {
            console.warn('Viture: Error closing device:', e);
          }
        }
      }
    }
    this.device = null;
    this._allDevices = null;
    this.connected = false;

    window.postMessage({ type: 'VITURE_DEVICE_DISCONNECTED' }, '*');
  }

  _handleInputReport(event, deviceIndex = 0) {
    // event.data is a DataView - need to handle byteOffset properly
    const dataView = event.data;
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

    // Debug: log first few reports from each device
    if (!this._reportCounts) this._reportCounts = {};
    if (!this._reportCounts[deviceIndex]) this._reportCounts[deviceIndex] = 0;
    this._reportCounts[deviceIndex]++;
    const count = this._reportCounts[deviceIndex];

    if (count <= 10 || count % 500 === 0) {
      console.log(`Viture device[${deviceIndex}] report #${count}, length: ${bytes.length}`,
        'header:', bytes[0].toString(16), bytes[1].toString(16),
        'bytes:', Array.from(bytes.slice(0, Math.min(32, bytes.length))).map(b => b.toString(16).padStart(2, '0')).join(' '));
    }

    // Track total reports for backward compatibility
    if (!this._reportCount) this._reportCount = 0;
    this._reportCount++;

    // Check for Viture packet format (header 0xFF 0xFC for IMU, 0xFF 0xFE for MCU)
    if (bytes.length >= 30 && bytes[0] === 0xFF && bytes[1] === 0xFC) {
      // Viture IMU packet - payload starts at offset 18 (0x12)
      // Euler: roll at payload+0, pitch at payload+4, yaw at payload+8
      this._parseVitureImuPacket(bytes);
    } else if (bytes.length >= 36) {
      // Try XRLinuxDriver quaternion format (bytes 20-35)
      this._parseQuaternionData(bytes);
    } else if (bytes.length >= 12) {
      // Try simple Euler format (bytes 0-11)
      this._parseEulerData(bytes);
    } else {
      debugLog('Viture: Report too short:', bytes.length);
    }
  }

  /**
   * Parse Viture IMU packet format
   * Header: 0xFF 0xFC
   * Payload at offset 18 (0x12)
   * Euler angles: roll (0-3), pitch (4-7), yaw (8-11) - big-endian floats, byte-swapped
   */
  _parseVitureImuPacket(bytes) {
    const payloadOffset = 18; // 0x12

    // Extract raw Euler angles from payload with byte order swap
    const raw0 = this._floatFromIMUSwapped(bytes, payloadOffset);
    const raw1 = this._floatFromIMUSwapped(bytes, payloadOffset + 4);
    const raw2 = this._floatFromIMUSwapped(bytes, payloadOffset + 8);

    // Remap axes for correct WebXR orientation:
    // Based on testing: raw0 = physical yaw, raw1 = physical roll, raw2 = physical pitch
    const yaw = -raw0;     // Roll
    const roll = -raw1;    // up/Down
    const pitch = raw2;   // Left/right

    this.rotation = { yaw, pitch, roll };

    // Debug: log values periodically
    if (!this._vitureLogCount) this._vitureLogCount = 0;
    this._vitureLogCount++;
    if (this._vitureLogCount <= 5 || this._vitureLogCount % 500 === 0) {
      console.log('Viture IMU: pitch:', pitch.toFixed(2), 'yaw:', yaw.toFixed(2), 'roll:', roll.toFixed(2));
    }

    // Validate values (should be in reasonable range for Euler angles in degrees)
    if (isNaN(roll) || isNaN(pitch) || isNaN(yaw) ||
        Math.abs(roll) > 180 || Math.abs(pitch) > 180 || Math.abs(yaw) > 180) {
      if (this._vitureLogCount <= 10) {
        console.warn('Viture: Invalid Euler angles:', { roll, pitch, yaw });
      }
      return;
    }

    const q = this._eulerToQuaternion(roll, pitch, yaw);

    const calibrated = this._multiplyQuaternions(
      this._conjugateQuaternion(this.calibrationOffset),
      q
    );

    this.quaternion = calibrated;
    this._notifyCallbacks();
  }

  /**
   * Extract float with byte order swap (for Viture packet format)
   * Device sends bytes that need to be reversed before interpreting as float
   */
  _floatFromIMUSwapped(bytes, offset) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);

    // Swap byte order (reverse)
    view.setUint8(0, bytes[offset + 3]);
    view.setUint8(1, bytes[offset + 2]);
    view.setUint8(2, bytes[offset + 1]);
    view.setUint8(3, bytes[offset]);

    // Read as native (little-endian on most systems)
    return view.getFloat32(0, true);
  }

  _parseQuaternionData(bytes) {
    const offset = 20;

    const w = this._floatFromIMU(bytes, offset);
    const x = this._floatFromIMU(bytes, offset + 4);
    const y = this._floatFromIMU(bytes, offset + 8);
    const z = this._floatFromIMU(bytes, offset + 12);

    // Debug: log quaternion values periodically
    if (!this._quatLogCount) this._quatLogCount = 0;
    this._quatLogCount++;
    if (this._quatLogCount <= 3 || this._quatLogCount % 500 === 0) {
      debugLog('Viture quaternion raw:', { w, x, y, z });
      debugLog('  Bytes at offset 20:', Array.from(bytes.slice(20, 36)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    }

    // Validate quaternion (should have magnitude ~1)
    const mag = Math.sqrt(w*w + x*x + y*y + z*z);
    if (mag < 0.5 || mag > 1.5 || isNaN(mag)) {
      if (this._quatLogCount <= 10) {
        debugWarn('Viture: Invalid quaternion magnitude:', mag, { w, x, y, z });
      }
      return; // Skip invalid data
    }

    const calibrated = this._multiplyQuaternions(
      this._conjugateQuaternion(this.calibrationOffset),
      { w, x, y, z }
    );

    this.quaternion = calibrated;
    this._notifyCallbacks();
  }

  _parseEulerData(bytes) {
    const roll = this._floatFromIMU(bytes, 0);
    const pitch = this._floatFromIMU(bytes, 4);
    const yaw = this._floatFromIMU(bytes, 8);

    const q = this._eulerToQuaternion(roll, pitch, yaw);

    const calibrated = this._multiplyQuaternions(
      this._conjugateQuaternion(this.calibrationOffset),
      q
    );

    this.quaternion = calibrated;
    this._notifyCallbacks();
  }

  _floatFromIMU(bytes, offset) {
    // IMU data is big-endian, we can read directly
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);

    // Copy bytes in original order
    view.setUint8(0, bytes[offset]);
    view.setUint8(1, bytes[offset + 1]);
    view.setUint8(2, bytes[offset + 2]);
    view.setUint8(3, bytes[offset + 3]);

    // Read as big-endian float
    return view.getFloat32(0, false);
  }

  _eulerToQuaternion(roll, pitch, yaw) {
    const r = roll * Math.PI / 180;
    const p = pitch * Math.PI / 180;
    const y = yaw * Math.PI / 180;

    const cy = Math.cos(y * 0.5);
    const sy = Math.sin(y * 0.5);
    const cp = Math.cos(p * 0.5);
    const sp = Math.sin(p * 0.5);
    const cr = Math.cos(r * 0.5);
    const sr = Math.sin(r * 0.5);

    return {
      w: cr * cp * cy + sr * sp * sy,
      x: sr * cp * cy - cr * sp * sy,
      y: cr * sp * cy + sr * cp * sy,
      z: cr * cp * sy - sr * sp * cy
    };
  }

  _multiplyQuaternions(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    };
  }

  _conjugateQuaternion(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  }

  recenter() {
    this.calibrationOffset = { ...this.quaternion };
  }

  _getDeviceInfo() {
    if (!this.device) return null;

    let model = 'Unknown';
    const pid = this.device.productId;

    if (VitureHID.PRODUCT_IDS.ONE.includes(pid)) model = 'Viture One';
    else if (VitureHID.PRODUCT_IDS.ONE_LITE.includes(pid)) model = 'Viture One Lite';
    else if (VitureHID.PRODUCT_IDS.PRO.includes(pid)) model = 'Viture Pro';
    else if (VitureHID.PRODUCT_IDS.LUMA_PRO.includes(pid)) model = 'Viture Luma Pro';
    else if (VitureHID.PRODUCT_IDS.LUMA.includes(pid)) model = 'Viture Luma';

    return {
      model,
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      productName: this.device.productName
    };
  }

  onOrientationChange(callback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  onOrientationChangeRot(callback) {
    this.callbacksRot.add(callback);
    return () => this.callbacksRot.delete(callback);
  }

  _notifyCallbacks() {
    const q = this.quaternion;
    const r = this.rotation;
    this.callbacks.forEach(cb => cb(q));
    this.callbacksRot.forEach(cb => cb(r));

    // Also notify extension for cross-tab sync
    window.postMessage({
      type: 'VITURE_ORIENTATION_UPDATE',
      orientation: q,
      rotation: r
    }, '*');
  }

  getQuaternion() {
    return { ...this.quaternion };
  }

  getQuaternionArray() {
    return [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w];
  }
}

// Make available globally in page context
window.VitureHID = VitureHID;
