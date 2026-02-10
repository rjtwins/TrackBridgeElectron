/**
 * Viture WebXR Extension - Injected Script
 * This runs in the page context and initializes the WebXR polyfill
 */

// import { VitureHID } from './viture-hid.js';
// import { initVitureWebXR } from './webxr-polyfill.js';

// Initialize immediately
const xrSystem = initVitureWebXR();

// Listen for state changes from extension
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const data = event.data;

  if (data.type === 'VITURE_STATE_RESPONSE') {
    console.log('Viture extension state:', data.state);
  }

  if (data.type === 'VITURE_STATE_CHANGED') {
    if (data.state && !data.state.enabled) {
      console.log('Viture WebXR disabled');
    }
  }

  if (data.type === 'VITURE_CONNECT_REQUEST') {
    console.log('Viture connect request received');
    try {
      await window.connectViture();
    } catch (e) {
      console.error('Failed to connect Viture:', e);
    }
  }

  if (data.type === 'VITURE_RECENTER_REQUEST') {
    console.log('Viture recenter request received');
    window.recenterViture();
  }
});

// Request initial state
window.postMessage({ type: 'VITURE_GET_STATE' }, '*');

// Expose manual connect function for debugging
window.connectViture = async function() {
  const viture = window.VitureWebXR.getViture();
  if (!viture) {
    console.error('Viture not initialized');
    return;
  }

  try {
    const info = await viture.connect();
    console.log('Connected to Viture:', info);
    return info;
  } catch (e) {
    console.error('Failed to connect:', e);
    throw e;
  }
};

// Expose recenter function
window.recenterViture = function() {
  const viture = window.VitureWebXR.getViture();
  if (viture && viture.connected) {
    viture.recenter();
    console.log('Viture recentered');
  } else {
    console.error('Viture not connected');
  }
};

// Log availability
console.log('Viture WebXR ready. WebHID supported:', VitureHID.isSupported());

// Dispatch event for pages that want to know when Viture is ready
window.dispatchEvent(new CustomEvent('viture-webxr-ready', {
  detail: {
    supported: VitureHID.isSupported(),
    connect: window.connectViture,
    recenter: window.recenterViture
  }
}));
