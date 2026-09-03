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

  function dataUrlToBlob(dataUrl) {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  async function uploadFileHelper(blob, filename, contentType, conversationId, modelId, signal) {
    const initRes = await fetch('/actions/upload-file/initiate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        filename,
        contentFilename: filename,
        contentType,
        sizeBytes: blob.size,
        ...(modelId ? { modelId } : {})
      }),
      signal
    });
    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      throw new Error(`upload initiate failed: ${initRes.status} ${errText}`);
    }
    const initData = await initRes.json();
    if (initData.error) throw new Error(initData.error);
    if (!initData.uploadUrl || !initData.uploadToken || !initData.storageKey) {
      throw new Error('invalid upload initiate response');
    }

    const putHeaders = { 'Content-Type': contentType };
    if (initData.sizeBytes != null) {
      putHeaders['x-goog-content-length-range'] = `${initData.sizeBytes},${initData.sizeBytes}`;
      putHeaders['x-goog-if-generation-match'] = '0';
    }
    const putRes = await fetch(initData.uploadUrl, {
      method: 'PUT',
      headers: putHeaders,
      body: blob,
      signal
    });
    if (!putRes.ok && putRes.status !== 412) {
      throw new Error(`direct upload PUT failed: ${putRes.status}`);
    }

    const confirmRes = await fetch('/actions/upload-file/confirm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadToken: initData.uploadToken
      }),
      signal
    });
    if (!confirmRes.ok) {
      const errText = await confirmRes.text().catch(() => '');
      throw new Error(`upload confirm failed: ${confirmRes.status} ${errText}`);
    }
    const confirmData = await confirmRes.json();
    if (confirmData.error) throw new Error(confirmData.error);

    return {
      storageKey: confirmData.storageKey || initData.storageKey,
      downloadUrl: confirmData.downloadUrl || confirmData.url || initData.downloadUrl || initData.url || ''
    };
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
      // Process parts: upload any image blobs and get their storageKey
      const processedParts = [];
      if (Array.isArray(job.parts) && job.parts.length > 0) {
        for (const p of job.parts) {
          if (p.type === 'image' || p.type === 'file') {
            const rawUrl = p.image || p.url || p.data || '';
            let mediaType = p.mediaType || (p.type === 'image' ? 'image/jpeg' : 'application/octet-stream');
            let blob = null;
            // Only data: URIs are accepted here. The bridge resolves remote
            // URLs to data URIs server-side (behind an SSRF guard).
            if (rawUrl.startsWith('data:')) {
              blob = dataUrlToBlob(rawUrl);
              mediaType = blob.type || mediaType;
            }
            if (blob) {
              const ext = (mediaType.split('/')[1] || 'jpeg').replace(/^jpeg$/, 'jpg');
              const filename = p.filename || `${p.type === 'image' ? 'image' : 'attachment'}.${ext}`;
              push('status', `[upload] uploading ${filename} (${(blob.size / 1024).toFixed(1)} KB)...`);
              const uploadRes = await uploadFileHelper(
                blob,
                filename,
                mediaType,
                job.conversationId,
                job.modelId,
                controller.signal
              );
              processedParts.push({
                type: 'file',
                mediaType,
                filename,
                url: uploadRes.storageKey,
                storageKey: uploadRes.storageKey,
              });
            }
          } else {
            processedParts.push({
              type: 'text',
              text: typeof p.text === 'string' ? p.text : String(p),
            });
          }
        }
      } else {
        processedParts.push({ type: 'text', text: job.text });
      }

      const body = JSON.stringify({
        modelId: job.modelId,
        imageAspectRatio: '1:1',
        ...(job.temporary ? { isTemporary: true } : {}),
        ...(job.thinkingLevel ? { thinkingLevel: job.thinkingLevel } : {}),
        messages: [{
          id: crypto.randomUUID(),
          role: 'user',
          metadata: { modelId: job.modelId },
          parts: processedParts,
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
