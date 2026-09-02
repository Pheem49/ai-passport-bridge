// MAIN world. Runs as ordinary page JavaScript, so the fetch below is a real
// first-party request and the browser attaches the session cookie itself —
// nothing here ever reads or forwards a credential.
(() => {
  // Reloading the extension leaves this script running with stale code, and a
  // plain "already loaded" guard would block the replacement forever. Each
  // injection claims a higher generation; older copies stand down.
  const GEN = (window.__aipassBridgeGen ?? 0) + 1;
  window.__aipassBridgeGen = GEN;

  const TAG = '__aipass_bridge';
  const inflight = new Map();

  const reply = (msg) => window.postMessage({ [TAG]: 'res', ...msg }, window.location.origin);

  // Read-only GET against one of the app's own loaders. Confined to /loaders/
  // so a compromised bridge cannot turn this into a general request forwarder.
  async function runLoader(job) {
    try {
      if (!/^\/loaders\/[A-Za-z0-9._~-]+(\.data)?(\?|$)/.test(job.url)) {
        throw new Error(`refusing non-loader path: ${job.url}`);
      }
      const res = await fetch(job.url, { credentials: 'include', headers: { accept: '*/*' } });
      if (!res.ok) throw new Error(`aipass returned ${res.status} ${res.statusText}`);
      reply({ jobId: job.jobId, kind: 'loader', raw: await res.text() });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  // Creating a conversation is a form post to the route the chat page itself
  // uses. The server derives the id from clientCreateRequestId, taking its
  // first sixteen hex characters.
  async function runCreate(job) {
    try {
      const params = new URLSearchParams({
        message: job.message,
        folderId: '',
        modelId: job.modelId,
        intent: 'create-conversation',
        clientCreateRequestId: job.requestId,
      });
      // Bind to a custom assistant when one is configured. The field name comes
      // from the bridge so it can be corrected without touching the extension.
      if (job.assistant && job.assistantField) params.set(job.assistantField, job.assistant);
      const res = await fetch('/chat.data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', accept: '*/*' },
        body: params.toString(),
      });
      if (!res.ok) throw new Error(`aipass returned ${res.status} ${res.statusText}`);
      reply({ jobId: job.jobId, kind: 'loader', raw: await res.text() });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  async function run(job) {
    const controller = new AbortController();
    inflight.set(job.jobId, controller);

    // Deltas arrive in tiny pieces; batching keeps the hop back to the bridge
    // from turning into hundreds of POSTs per response.
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      reply({ jobId: job.jobId, kind: 'chunk', parts: buffer });
      buffer = [];
    };
    const ticker = setInterval(flush, 40);
    const push = (kind, text) => {
      if (!text) return;
      buffer.push({ kind, text });
      if (buffer.length >= 10) flush();
    };

    try {
      // One user message, matching what the web UI sends. The server holds the
      // conversation history.
      const body = JSON.stringify({
        modelId: job.modelId,
        imageAspectRatio: '1:1',
        messages: [{
          id: crypto.randomUUID(),
          role: 'user',
          metadata: { modelId: job.modelId },
          parts: [{ type: 'text', text: job.text }],
        }],
      });

      const res = await fetch(`/actions/send-message/${encodeURIComponent(job.conversationId)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: '*/*' },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        // A bare HTML error means an edge proxy blocked us before the app saw
        // the request; these headers say which one.
        const forensics = ['server', 'via', 'cf-ray', 'retry-after']
          .map((h) => [h, res.headers.get(h)])
          .filter(([, v]) => v)
          .map(([h, v]) => `${h}=${v}`)
          .join(' ');
        throw new Error(
          `aipass returned ${res.status} ${res.statusText} [${body.length} bytes]` +
          `${forensics ? ` {${forensics}}` : ''}${detail ? ` — ${detail}` : ''}`
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let finishReason = 'stop';
      const toolNames = new Map();
      const sources = [];

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let cut;
        while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
          const frame = pending.slice(0, cut);
          pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data || data === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(data); } catch { continue; }

          // Server-side tools (web_search, media generation) run upstream and
          // stream their progress here. Dropping these frames silently makes a
          // long search look like a hang.
          switch (evt.type) {
            case 'text-delta':
              push('text', evt.delta);
              break;
            case 'reasoning-delta':
              push('reasoning', evt.delta ?? evt.text);
              break;
            case 'tool-input-start':
              toolNames.set(evt.toolCallId, evt.toolName);
              break;
            case 'tool-input-available':
              toolNames.set(evt.toolCallId, evt.toolName);
              push('status', `[${evt.toolName}] ${JSON.stringify(evt.input ?? {})}`);
              break;
            case 'tool-output-available': {
              const name = toolNames.get(evt.toolCallId) ?? 'tool';
              const size = typeof evt.output === 'string' ? evt.output.length : JSON.stringify(evt.output ?? '').length;
              push('status', `[${name}] returned ${size} chars`);
              break;
            }
            case 'source-url':
              if (evt.url && !sources.some((x) => x.url === evt.url)) sources.push({ url: evt.url, title: evt.title });
              break;
            case 'error':
              throw new Error(evt.errorText ?? evt.message ?? 'stream error');
            case 'finish':
              finishReason = evt.finishReason ?? finishReason;
              break;
            default:
              break; // start-step, text-start/end, tool-input-delta, data-*, finish-step
          }
        }
      }

      if (sources.length) {
        push('status', `sources:\n${sources.map((x) => `  - ${x.title ?? ''} ${x.url}`).join('\n')}`);
      }
      flush();
      reply({ jobId: job.jobId, kind: 'done', finishReason });
    } catch (err) {
      flush();
      if (err?.name === 'AbortError') reply({ jobId: job.jobId, kind: 'done', finishReason: 'stop' });
      else reply({ jobId: job.jobId, kind: 'error', message: String(err?.message ?? err) });
    } finally {
      clearInterval(ticker);
      inflight.delete(job.jobId);
    }
  }

  window.addEventListener('message', (event) => {
    if (window.__aipassBridgeGen !== GEN) return; // superseded by a newer injection
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg[TAG] === 'req') {
      const fn = msg.job.kind === 'loader' ? runLoader : msg.job.kind === 'create' ? runCreate : run;
      fn(msg.job);
    }
    else if (msg[TAG] === 'abort') inflight.get(msg.jobId)?.abort();
  });

  reply({ kind: 'page-ready' });
})();
