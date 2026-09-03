// Service worker: holds the long-lived connection to the local bridge and
// routes each job into a de.aipass.net tab.
//
// The connection lives here rather than in the content script because an
// https:// page talking to http://127.0.0.1 runs into mixed-content and
// Private Network Access checks; an extension request with host_permissions
// does not.
const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
const RECONNECT_MS = 500;

let controller = null;
let connected = false;
let lastError = '';
const jobTabs = new Map();

const bridgeUrl = async () => {
  try {
    const res = await chrome.storage.local.get('bridgeUrl');
    return res?.bridgeUrl || DEFAULT_BRIDGE;
  } catch {
    return DEFAULT_BRIDGE;
  }
};

async function post(path, body) {
  try {
    await fetch(`${await bridgeUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    lastError = String(err?.message ?? err);
    console.warn('[aipass-bg] POST error:', path, lastError);
  }
}

let postQueue = Promise.resolve();
function queuePost(path, body) {
  postQueue = postQueue.then(() => post(path, body)).catch(() => {});
  return postQueue;
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aipass.net/*', 'https://aipass.net/*'] });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  const pool = live.length ? live : tabs;
  // Prefer a tab already sitting on a chat route.
  return pool.find((t) => t.url?.includes('/chat')) ?? pool[0];
}

function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('tab did not finish loading')); }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// A tab opened before the extension was loaded or reloaded has no content
// script in it, and Chrome's memory saver can discard one entirely. Rather
// than telling the user to reload, put the scripts back.
async function ensureContentScript(tab) {
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  let ok = false;
  try { await ping(); ok = true; } catch { /* not there yet */ }

  if (!ok && (tab.discarded || tab.status === 'unloaded')) {
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id);
  }

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page.js'] }).catch(() => {});
  if (!ok) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content.js'] }).catch(() => {});
    await ping();
  }
}

async function handleJob(job) {
  const tab = await findChatTab();
  if (!tab) {
    await post('/ext/error', { jobId: job.jobId, message: 'no de.aipass.net tab is open' });
    return;
  }
  jobTabs.set(job.jobId, tab.id);
  try {
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'run', job });
  } catch (err) {
    jobTabs.delete(job.jobId);
    await post('/ext/error', {
      jobId: job.jobId,
      message: `could not reach the de.aipass.net tab (${tab.url ?? tab.id}): ${err?.message ?? err}`,
    });
  }
}

function handleEvent(name, data) {
  if (name === 'job') handleJob(data);
  else if (name === 'abort') {
    const tabId = jobTabs.get(data.jobId);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'abort', jobId: data.jobId }).catch(() => {});
    jobTabs.delete(data.jobId);
  } else if (name === 'reload_extension') {
    try { chrome.runtime.reload(); } catch { /* ignore */ }
  } else if (name === 'reload_tab') {
    (async () => {
      const tab = await findChatTab();
      if (tab) chrome.tabs.reload(tab.id).catch(() => {});
    })();
  }
}

async function connect() {
  if (connected) return;
  if (controller) {
    try { controller.abort(); } catch { /* ignore */ }
    controller = null;
  }
  controller = new AbortController();
  const signal = controller.signal;

  try {
    const res = await fetch(`${await bridgeUrl()}/ext/events`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`bridge responded ${res.status}`);

    connected = true;
    lastError = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let cut;
      while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // comment / keepalive
        try { handleEvent(name, JSON.parse(dataLines.join('\n'))); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') lastError = String(err?.message ?? err);
  } finally {
    connected = false;
    controller = null;
    setTimeout(connect, RECONNECT_MS);
  }
}

// A content script holds this port open so Chrome does not evict the worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  if (!connected) connect(); // a de.aipass.net tab just appeared (or the worker just woke)
  port.onMessage.addListener(() => {
    if (!connected) connect();
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'from-page') {
    const p = msg.payload;
    if (p.kind === 'chunk') queuePost('/ext/chunk', { jobId: p.jobId, parts: p.parts });
    else if (p.kind === 'done') {
      queuePost('/ext/done', { jobId: p.jobId, finishReason: p.finishReason })
        .then(() => { jobTabs.delete(p.jobId); });
    }
    else if (p.kind === 'error') {
      queuePost('/ext/error', { jobId: p.jobId, message: p.message })
        .then(() => { jobTabs.delete(p.jobId); });
    }
    else if (p.kind === 'loader') {
      queuePost('/ext/loader', { jobId: p.jobId, raw: p.raw, message: p.message })
        .then(() => { jobTabs.delete(p.jobId); });
    }
    return;
  }
  if (msg?.type === 'status') {
    (async () => {
      const tab = await findChatTab();
      sendResponse({
        connected,
        lastError,
        bridgeUrl: await bridgeUrl(),
        tab: tab ? { id: tab.id, url: tab.url } : null,
        activeJobs: jobTabs.size,
      });
    })();
    return true;
  }
  if (msg?.type === 'reconnect') { controller?.abort(); connect(); sendResponse({ ok: true }); return true; }
});

// The worker can be evicted at any time; the alarm brings it back and the
// connect() guard makes a duplicate call harmless.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!connected) connect(); });
chrome.runtime.onStartup.addListener(() => { if (!connected) connect(); });
chrome.runtime.onInstalled.addListener(() => { if (!connected) connect(); });
connect();
