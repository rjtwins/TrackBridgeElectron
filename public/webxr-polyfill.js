/**
 * Viture WebXR Polyfill
 * Makes Viture glasses appear as a WebXR device
 */

// Debug flag - set to true for verbose logging
var VITURE_DEBUG = false;

function debugLog(...args) {
  if (VITURE_DEBUG) console.log(...args);
}

// import { VitureHID } from './viture-hid.js';

class VitureXRSession {
  constructor(mode, viture) {
    this.mode = mode;
    this.viture = viture;
    this.ended = false;
    this.renderState = {
      baseLayer: null,
      depthFar: 1000,
      depthNear: 0.1,
      inlineVerticalFieldOfView: Math.PI / 2
    };
    this.inputSources = [];
    this._frameCallbacks = [];
    this._animationFrameId = null;
    this._referenceSpaces = new Map();
    this._lastFrameTime = 0;

    // Set isImmersive as a data property (some apps try to set it)
    this.isImmersive = (mode === 'immersive-vr' || mode === 'immersive-ar');

    // Start frame loop
    this._startFrameLoop();
  }

  get visibilityState() {
    return 'visible';
  }

  get frameRate() {
    return 90; // Viture runs at 90Hz
  }

  get supportedFrameRates() {
    return Float32Array.from([60, 90, 120]);
  }

  get environmentBlendMode() {
    return 'opaque';
  }

  get interactionMode() {
    return 'world-space';
  }

  addEventListener(type, listener) {
    // Basic event handling
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    if (!this._listeners || !this._listeners[type]) return;
    const idx = this._listeners[type].indexOf(listener);
    if (idx !== -1) this._listeners[type].splice(idx, 1);
  }

  _dispatchEvent(type, event) {
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type].forEach(l => l(event));
  }

  async requestReferenceSpace(type) {
    if (this._referenceSpaces.has(type)) {
      return this._referenceSpaces.get(type);
    }

    const space = new VitureXRReferenceSpace(type, this.viture);
    this._referenceSpaces.set(type, space);
    return space;
  }

  updateRenderState(newState) {
    Object.assign(this.renderState, newState);
  }

  requestAnimationFrame(callback) {
    const handle = this._frameCallbacks.length;
    this._frameCallbacks.push(callback);
    return handle;
  }

  cancelAnimationFrame(handle) {
    if (handle < this._frameCallbacks.length) {
      this._frameCallbacks[handle] = null;
    }
  }

  _startFrameLoop() {
    const loop = (timestamp) => {
      if (this.ended) return;

      this._animationFrameId = requestAnimationFrame(loop);

      // Create XRFrame
      const frame = new VitureXRFrame(this, timestamp);

      // Call all registered callbacks
      const callbacks = this._frameCallbacks.slice();
      this._frameCallbacks = [];

      callbacks.forEach(cb => {
        if (cb) cb(timestamp, frame);
      });

      this._lastFrameTime = timestamp;
    };

    this._animationFrameId = requestAnimationFrame(loop);
  }

  async end() {
    this.ended = true;
    if (this._animationFrameId) {
      cancelAnimationFrame(this._animationFrameId);
    }
    this._dispatchEvent('end', { session: this });
  }
}

class VitureXRFrame {
  constructor(session, timestamp) {
    this.session = session;
    this._timestamp = timestamp;
  }

  getViewerPose(referenceSpace) {
    if (!referenceSpace) return null;
    return new VitureXRViewerPose(this.session, referenceSpace);
  }

  getPose(space, baseSpace) {
    // Return identity pose for now
    return {
      transform: new VitureXRRigidTransform()
    };
  }
}

class VitureXRViewerPose {
  constructor(session, referenceSpace) {
    this.session = session;
    this.referenceSpace = referenceSpace;

    // Get quaternion from Viture device
    const q = session.viture.connected ? session.viture.getQuaternion() : { x: 0, y: 0, z: 0, w: 1 };

    // Debug: Log quaternion periodically
    if (!VitureXRViewerPose._lastLog || (Date.now() - VitureXRViewerPose._lastLog > 1000)) {
      debugLog('VitureXRViewerPose: quaternion', q, 'connected:', session.viture.connected);
      VitureXRViewerPose._lastLog = Date.now();
    }

    this.transform = new VitureXRRigidTransform(
      { x: 0, y: 0, z: 0, w: 1 },
      q
    );

    // For stereo, create two views
    if (session.mode === 'immersive-vr') {
      this.views = [
        new VitureXRView('left', session),
        new VitureXRView('right', session)
      ];
    } else {
      this.views = [new VitureXRView('none', session)];
    }
  }

  get emulatedPosition() {
    return true; // Position is emulated (3DoF only)
  }
}

class VitureXRView {
  constructor(eye, session) {
    this.eye = eye;
    this.session = session;

    // Viture FOV is approximately 46 degrees
    const fov = 46 * Math.PI / 180;
    const aspect = 16 / 9;

    this.projectionMatrix = new Float32Array(16);
    this._makePerspective(this.projectionMatrix, fov, aspect, 0.1, 1000);

    // View transform includes eye offset for stereo
    const q = session.viture.connected ? session.viture.getQuaternion() : { x: 0, y: 0, z: 0, w: 1 };
    const eyeOffset = eye === 'left' ? -0.032 : (eye === 'right' ? 0.032 : 0);

    this.transform = new VitureXRRigidTransform(
      { x: eyeOffset, y: 0, z: 0, w: 1 },
      q
    );

    // recommendedViewportScale is used by some apps
    this.recommendedViewportScale = 1.0;
  }

  _makePerspective(out, fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = 2 * far * near * nf;
    out[15] = 0;
  }
}

class VitureXRReferenceSpace {
  constructor(type, viture) {
    this.type = type;
    this.viture = viture;
  }

  getOffsetReferenceSpace(originOffset) {
    return new VitureXRReferenceSpace(this.type, this.viture);
  }

  addEventListener() {}
  removeEventListener() {}
}

class VitureXRRigidTransform {
  constructor(position = { x: 0, y: 0, z: 0, w: 1 }, orientation = { x: 0, y: 0, z: 0, w: 1 }, isInverse = false) {
    this.position = new DOMPointReadOnly(position.x, position.y, position.z, position.w || 1);
    this.orientation = new DOMPointReadOnly(orientation.x, orientation.y, orientation.z, orientation.w);

    // Build 4x4 transformation matrix
    this.matrix = new Float32Array(16);
    this._buildMatrix();

    // Compute inverse (but don't recurse infinitely)
    if (!isInverse) {
      this._inverse = null; // Lazy compute
    } else {
      this._inverse = null; // Inverse of inverse would be the original, but we don't need it
    }
    this._isInverse = isInverse;
  }

  get inverse() {
    if (this._inverse === null && !this._isInverse) {
      // Compute the inverse transform
      // Inverse rotation = conjugate quaternion
      const invOrientation = {
        x: -this.orientation.x,
        y: -this.orientation.y,
        z: -this.orientation.z,
        w: this.orientation.w
      };

      // Inverse position = -R^T * position
      // Apply inverse rotation to negated position
      const p = this.position;
      const q = invOrientation;

      // Rotate -position by inverse quaternion
      const px = -p.x, py = -p.y, pz = -p.z;

      // Quaternion rotation: q * p * q^-1
      // Since q is already the inverse rotation, we just apply it
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

      // p' = q * (px, py, pz, 0) * q^-1
      // Simplified quaternion-vector multiplication
      const ix = qw * px + qy * pz - qz * py;
      const iy = qw * py + qz * px - qx * pz;
      const iz = qw * pz + qx * py - qy * px;
      const iw = -qx * px - qy * py - qz * pz;

      const invPx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
      const invPy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
      const invPz = iz * qw + iw * -qz + ix * -qy - iy * -qx;

      this._inverse = new VitureXRRigidTransform(
        { x: invPx, y: invPy, z: invPz, w: 1 },
        invOrientation,
        true // Mark as inverse to prevent recursion
      );
    }
    return this._inverse;
  }

  _buildMatrix() {
    const q = this.orientation;
    const p = this.position;

    // Quaternion to rotation matrix
    const x2 = q.x + q.x;
    const y2 = q.y + q.y;
    const z2 = q.z + q.z;

    const xx = q.x * x2;
    const xy = q.x * y2;
    const xz = q.x * z2;
    const yy = q.y * y2;
    const yz = q.y * z2;
    const zz = q.z * z2;
    const wx = q.w * x2;
    const wy = q.w * y2;
    const wz = q.w * z2;

    this.matrix[0] = 1 - (yy + zz);
    this.matrix[1] = xy + wz;
    this.matrix[2] = xz - wy;
    this.matrix[3] = 0;
    this.matrix[4] = xy - wz;
    this.matrix[5] = 1 - (xx + zz);
    this.matrix[6] = yz + wx;
    this.matrix[7] = 0;
    this.matrix[8] = xz + wy;
    this.matrix[9] = yz - wx;
    this.matrix[10] = 1 - (xx + yy);
    this.matrix[11] = 0;
    this.matrix[12] = p.x;
    this.matrix[13] = p.y;
    this.matrix[14] = p.z;
    this.matrix[15] = 1;
  }
}

/**
 * XRWebGLLayer polyfill for Viture sessions
 */
class VitureXRWebGLLayer {
  constructor(session, context, options = {}) {
    this.session = session;
    this.context = context;
    this._options = options;

    // Get canvas dimensions
    const canvas = context.canvas;
    this._framebufferWidth = canvas.width;
    this._framebufferHeight = canvas.height;

    // Store original framebuffer (null = default)
    this._framebuffer = null;

    // Mark session with this layer
    if (session.updateRenderState) {
      // Will be called by the app
    }

    debugLog('VitureXRWebGLLayer created:', this._framebufferWidth, 'x', this._framebufferHeight);
  }

  get framebuffer() {
    return this._framebuffer;
  }

  get framebufferWidth() {
    return this._framebufferWidth;
  }

  get framebufferHeight() {
    return this._framebufferHeight;
  }

  get antialias() {
    return this._options.antialias !== false;
  }

  get ignoreDepthValues() {
    return this._options.ignoreDepthValues || false;
  }

  getViewport(view) {
    // For stereo, split viewport left/right
    const width = this._framebufferWidth;
    const height = this._framebufferHeight;

    if (view.eye === 'left') {
      return { x: 0, y: 0, width: width / 2, height: height };
    } else if (view.eye === 'right') {
      return { x: width / 2, y: 0, width: width / 2, height: height };
    } else {
      // Mono view
      return { x: 0, y: 0, width: width, height: height };
    }
  }
}

class VitureXRSystem {
  constructor(viture) {
    this.viture = viture;
    this._sessions = [];
  }

  async isSessionSupported(mode) {
    // Support inline and immersive-vr modes
    return mode === 'inline' || mode === 'immersive-vr';
  }

  async requestSession(mode, options = {}) {
    debugLog('VitureXRSystem: requestSession called', mode, 'connected:', this.viture.connected);

    if (mode === 'immersive-vr' && !this.viture.connected) {
      // Try to connect
      debugLog('VitureXRSystem: Attempting to connect to Viture glasses...');
      try {
        await this.viture.connect();
        debugLog('VitureXRSystem: Connected successfully');
      } catch (e) {
        debugLog('VitureXRSystem: Connection failed:', e);
        throw new DOMException('Failed to connect to Viture glasses: ' + e.message, 'NotSupportedError');
      }
    }

    const session = new VitureXRSession(mode, this.viture);
    this._sessions.push(session);
    debugLog('VitureXRSystem: Session created', session);
    return session;
  }
}

// Global Viture instance
let globalViture = null;
let globalXRSystem = null;

function initVitureWebXR() {
  if (globalViture) return globalXRSystem;

  globalViture = new VitureHID();
  globalXRSystem = new VitureXRSystem(globalViture);

  // Check for existing connection
  globalViture.checkExistingConnection().catch(() => {});

  // Store original XR if exists
  const originalXR = navigator.xr;

  // Create proxy XR system
  const proxyXR = {
    async isSessionSupported(mode) {
      // Check Viture first
      const vitureSupported = await globalXRSystem.isSessionSupported(mode);
      if (vitureSupported && globalViture.connected) {
        return true;
      }

      // Fall back to original WebXR if available
      if (originalXR) {
        return originalXR.isSessionSupported(mode);
      }

      // For immersive-vr, we support it even if not connected (will connect on request)
      if (mode === 'immersive-vr' && VitureHID.isSupported()) {
        return true;
      }

      return mode === 'inline';
    },

    async requestSession(mode, options) {
      debugLog('Viture WebXR proxy: requestSession', mode, options);

      // Prefer Viture for immersive-vr
      if (mode === 'immersive-vr') {
        debugLog('Viture WebXR proxy: Using Viture for immersive-vr');
        return globalXRSystem.requestSession(mode, options);
      }

      // For inline, use original if available
      if (originalXR && mode === 'inline') {
        try {
          debugLog('Viture WebXR proxy: Trying original XR for inline');
          return await originalXR.requestSession(mode, options);
        } catch (e) {
          debugLog('Viture WebXR proxy: Original XR failed, falling back to Viture');
          return globalXRSystem.requestSession(mode, options);
        }
      }

      return globalXRSystem.requestSession(mode, options);
    },

    addEventListener(type, listener) {
      if (originalXR) {
        originalXR.addEventListener(type, listener);
      }
    },

    removeEventListener(type, listener) {
      if (originalXR) {
        originalXR.removeEventListener(type, listener);
      }
    },

    // Expose Viture-specific methods
    get viture() {
      return globalViture;
    }
  };

  // Replace navigator.xr
  Object.defineProperty(navigator, 'xr', {
    get: () => proxyXR,
    configurable: true
  });

  // Override XRWebGLLayer to handle Viture sessions
  const OriginalXRWebGLLayer = window.XRWebGLLayer;

  window.XRWebGLLayer = function(session, context, options) {
    // Check if this is a Viture session
    if (session instanceof VitureXRSession) {
      debugLog('Creating VitureXRWebGLLayer for Viture session');
      return new VitureXRWebGLLayer(session, context, options);
    }

    // Fall back to original for real XR sessions
    if (OriginalXRWebGLLayer) {
      return new OriginalXRWebGLLayer(session, context, options);
    }

    // No original XRWebGLLayer, create our polyfill
    return new VitureXRWebGLLayer(session, context, options);
  };

  // Copy static properties
  if (OriginalXRWebGLLayer) {
    window.XRWebGLLayer.getNativeFramebufferScaleFactor = OriginalXRWebGLLayer.getNativeFramebufferScaleFactor;
  } else {
    window.XRWebGLLayer.getNativeFramebufferScaleFactor = function(session) {
      return 1.0;
    };
  }

  debugLog('Viture WebXR polyfill initialized');
  return globalXRSystem;
}

// Expose for manual control
window.VitureWebXR = {
  init: initVitureWebXR,
  getViture: () => globalViture,
  getXRSystem: () => globalXRSystem
};
