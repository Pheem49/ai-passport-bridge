// Offscreen keepalive worker: provides a persistent DOM context that is never
// discarded, preventing Manifest V3 Service Worker idle eviction (30s timeout).

let port = null;

function setupPort() {
  try {
    port = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(setupPort, 1000);
    });
  } catch (err) {
    console.warn('[aipass-offscreen] Connect error:', err);
    setTimeout(setupPort, 2000);
  }
}

// Keep a persistent port connection
setupPort();

// Send regular ping message every 10 seconds to keep service worker active
setInterval(() => {
  if (port) {
    try {
      port.postMessage({ type: 'offscreen-heartbeat', time: Date.now() });
    } catch {
      setupPort();
    }
  } else {
    setupPort();
  }

  // Also send standard runtime message to reset MV3 idle eviction timer
  chrome.runtime.sendMessage({ type: 'offscreen-ping', time: Date.now() }).catch(() => {});
}, 10_000);
