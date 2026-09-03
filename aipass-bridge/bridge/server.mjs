// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
const MAX_BODY = 8 * 1024 * 1024;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// Bind newly created conversations to a custom aipass assistant. The form field
// name is not yet confirmed from a capture, so it is configurable; the default
// is the most likely candidate and is harmless if the server ignores it.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? 'aiAssistantId';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
};

// list-models carries no field separating chat models from image/video/audio
// generators, so exclude those by id. AIPASS_MODEL_FILTER=all keeps them.
const MEDIA_ID = /(seedream|seedance|veo-|lyria|gpt-image|-image$|image-preview)/i;
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'chat';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: MEDIA_ID.test(id),
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return MODEL_FILTER === 'all' ? out : out.filter((m) => !m.media && m.ready);
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
const extClientWaiters = new Set();
let rr = 0;

const pickClient = () => {
  const list = [...extClients];
  return list.length ? list[rr++ % list.length] : null;
};

const CONNECT_WAIT_MS = process.env.NODE_TEST_CONTEXT ? 150 : 4000;

const waitForClient = (timeoutMs = CONNECT_WAIT_MS) => {
  const current = pickClient();
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      extClientWaiters.delete(cb);
      resolve(null);
    }, timeoutMs);
    const cb = (client) => {
      clearTimeout(timer);
      extClientWaiters.delete(cb);
      resolve(client);
    };
    extClientWaiters.add(cb);
  });
};

const sendToClient = (client, event, data) =>
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

class Job {
  constructor({ kind = 'chat', modelId, text, parts, conversationId, url, message, requestId, assistant, assistantField, temporary = false, thinkingLevel, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.temporary = temporary;
    this.thinkingLevel = thinkingLevel;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.parts = parts;
    this.conversationId = conversationId;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for the extension'), this.timeoutMs);
  }
  async dispatch() {
    let client = pickClient();
    if (!client) client = await waitForClient();
    if (!client) return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
    this.client = client;
    sendToClient(client, 'job', this.kind === 'loader'
      ? { jobId: this.id, kind: 'loader', url: this.url }
      : this.kind === 'create'
      ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField }
      : {
          jobId: this.id,
          kind: 'chat',
          conversationId: this.conversationId,
          modelId: this.modelId,
          text: this.text,
          parts: this.parts,
          ...(this.temporary ? { temporary: true } : {}),
          ...(this.thinkingLevel ? { thinkingLevel: this.thinkingLevel } : {}),
        });
  }
  delta(part) { if (!this.settled) { this.touch(); this.onDelta(part); } }
  done(value) { if (this.settled) return; this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) { if (this.settled) return; this.cleanup(); this.onError(message); }
  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); jobs.delete(this.id); }
}

const fetchLoader = (url, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });

/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, thinking: null }));

// The thinking level a model will actually accept, or undefined. Falls back to
// the common three when the model list has not been fetched yet.
function thinkingLevelFor(modelId, level) {
  const known = cachedModels().find((m) => m.id === modelId)?.thinking;
  const allowed = Array.isArray(known) && known.length ? known : ['low', 'medium', 'high'];
  return allowed.includes(level) ? level : undefined;
}

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  if (!extClients.size) return cachedModels();
  if (modelRefresh) return modelRefresh; // several callers can race; only one should hit the API
  modelRefresh = (async () => {
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        const free = models.filter((m) => m.free).map((m) => m.id);
        log(`${models.length} models${free.length ? ` (free credit: ${free.join(', ')})` : ''}`);
      }
    } catch (err) {
      log('model refresh failed:', err.message);
    } finally {
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
let conversationCache = null;
let conversationList = [];
let conversationIndex = 0;

async function loadConversations() {
  if (!extClients.size) await waitForClient();
  if (!extClients.size) throw new Error('no extension connected — cannot look up a conversation');
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  conversationList = list;
  return list;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
async function createConversation({ modelId = defaultModel, message = 'Hello', assistant } = {}) {
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const id = findValue(decodeTurboStream(raw), 'conversationId');
  if (!id) throw new Error(`could not read a conversation id from the response: ${raw.slice(0, 200)}`);
  conversationCache = id;
  conversationIndex = 0;
  conversationList = [];
  log(`created conversation ${id}`);
  return id;
}

async function resolveConversation() {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  if (conversationCache) return conversationCache;
  if (!conversationList.length) await loadConversations();
  const pick = conversationList[conversationIndex];
  if (!pick) {
    throw new Error('no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {"conversation":null}');
  }
  conversationCache = pick.id;
  log(`conversation ${conversationCache} (${pick.title ?? 'untitled'})`);
  return conversationCache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ modelId, text, parts, temporary = false, thinkingLevel, onDelta, onDone, onError }) {
  let attempts = 0;
  let delivered = 0;
  let current = null;

  const attempt = async () => {
    attempts++;
    let conversationId;
    try { conversationId = await resolveConversation(); }
    catch (err) { return onError(err.message); }

    current = new Job({
      modelId, text, parts, conversationId, temporary, thinkingLevel,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !PINNED_CONVERSATION) {
          log(`conversation ${conversationId} rejected, trying the next one`);
          conversationIndex++;
          conversationCache = null;
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

// What may be attached to a message. Images go to vision models; the document
// types are what the web UI's own file picker offers.
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const isAllowedAttachment = (type, kind) =>
  kind === 'image' ? type.startsWith('image/') : type.startsWith('image/') || DOCUMENT_TYPES.has(type);

// Fetch a remote attachment and convert it to a Base64 data URI, with SSRF guard.
async function fetchRemoteAsDataUri(urlStr, kind = 'image') {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.16.') || host.startsWith('172.17.') || host.startsWith('172.18.') || host.startsWith('172.19.') || host.startsWith('172.2') || host.startsWith('172.30.') || host.startsWith('172.31.')) {
    throw new Error(`refusing private/internal network fetch: ${host}`);
  }

  const res = await fetch(urlStr, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`remote fetch failed with status ${res.status}`);
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!isAllowedAttachment(contentType, kind)) {
    throw new Error(`unsupported content-type: ${contentType}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${arrayBuffer.byteLength} bytes`);
  }
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

const dataUriType = (s) => (s.match(/^data:([^;,]+)/)?.[1] || '').toLowerCase();

function defaultFilename(mediaType) {
  const ext = ({
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
  })[mediaType] || (mediaType.split('/')[1] || 'bin').replace(/^jpeg$/, 'jpg');
  return `attachment.${ext}`;
}

// Extract multimodal parts (text, images, files) from OpenAI formatted messages
async function extractUserParts(messages) {
  const lastUser = (messages ?? []).filter((m) => m.role === 'user').at(-1);
  if (!lastUser) return { text: '', parts: [] };

  if (typeof lastUser.content === 'string') {
    const text = lastUser.content.trim();
    return {
      text,
      parts: text ? [{ type: 'text', text }] : []
    };
  }

  if (Array.isArray(lastUser.content)) {
    const parts = [];
    const textPieces = [];

    for (const item of lastUser.content) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'text' && typeof item.text === 'string') {
        const t = item.text.trim();
        if (t) {
          textPieces.push(t);
          parts.push({ type: 'text', text: t });
        }
      } else if (item.type === 'image_url' || item.type === 'image') {
        const rawUrl = item.image_url?.url || item.url || item.image || item.data || null;
        if (typeof rawUrl === 'string' && rawUrl.trim()) {
          const urlStr = rawUrl.trim();
          let dataUri = '';
          if (urlStr.startsWith('data:image/')) {
            dataUri = urlStr;
          } else if (/^https?:\/\//i.test(urlStr)) {
            try {
              dataUri = await fetchRemoteAsDataUri(urlStr, 'image');
            } catch (err) {
              log(`warning: failed to fetch remote image ${urlStr}: ${err.message}`);
            }
          }
          if (dataUri) {
            parts.push({
              type: 'image',
              image: dataUri
            });
          }
        }
      } else if (item.type === 'file') {
        const raw = item.file?.file_data || item.file?.url || item.url || item.data || '';
        if (typeof raw === 'string' && raw.trim()) {
          const str = raw.trim();
          let dataUri = '';
          if (str.startsWith('data:')) {
            const declared = dataUriType(str);
            if (isAllowedAttachment(declared, 'file')) dataUri = str;
            else log(`warning: refusing attachment of type ${declared || 'unknown'}`);
          } else if (/^https?:\/\//i.test(str)) {
            try {
              dataUri = await fetchRemoteAsDataUri(str, 'file');
            } catch (err) {
              log(`warning: failed to fetch remote file ${str}: ${err.message}`);
            }
          }
          if (dataUri) {
            const mediaType = dataUriType(dataUri) || 'application/octet-stream';
            if (mediaType.startsWith('image/')) {
              parts.push({ type: 'image', image: dataUri });
            } else {
              parts.push({
                type: 'file',
                mediaType,
                filename: item.file?.filename || item.filename || defaultFilename(mediaType),
                data: dataUri,
              });
            }
          }
        }
      }
    }

    const named = parts.find((p) => p.type === 'file')?.filename;
    const text = textPieces.join('\n').trim();
    return {
      text: text || (named ? `[${named}]` : parts.length ? '[Image]' : ''),
      parts: parts.length ? parts : (text ? [{ type: 'text', text }] : [])
    };
  }

  return { text: '', parts: [] };
}

/* ------------------------------------------------------------ http plumbing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error') =>
  json(res, status, { error: { message, type } });

/* ---------------------------------------------------------- chat completions */

async function chatCompletions(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }

  const model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  const thinking = String(payload.thinking_level ?? payload.thinkingLevel ?? '').trim().toLowerCase();
  const thinkingLevel = thinking ? thinkingLevelFor(model, thinking) : undefined;
  if (thinking && !thinkingLevel) log(`warning: ${model} does not offer thinking level ${thinking}`);
  const temporary = Boolean(payload.temporary);

  const { text, parts } = await extractUserParts(payload.messages);
  if (!text && (!parts || parts.length === 0)) return oaiError(res, 400, 'no user message');

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const imageCount = (parts ?? []).filter(p => p.type === 'image').length;
  const fileCount = (parts ?? []).filter(p => p.type === 'file').length;
  log(`chat -> ${model} (${Buffer.byteLength(text)} bytes text${imageCount ? `, ${imageCount} image(s)` : ''}${fileCount ? `, ${fileCount} file(s)` : ''}${thinkingLevel ? `, thinking: ${thinkingLevel}` : ''})`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    const job = startChat({
      modelId: model, text, parts, temporary, thinkingLevel,
      onDelta: (part) => {
        if (part.kind === 'status') {
          if (TOOL_VISIBILITY === 'off') return;
          if (TOOL_VISIBILITY === 'text') emit({ content: `\n${part.text}\n` });
          else emit({ reasoning_content: `${part.text}\n` });
          return;
        }
        if (part.kind === 'reasoning') emit({ reasoning_content: part.text });
        else emit({ content: part.text });
      },
      onDone: (finishReason) => {
        emit({}, finishReason === 'length' ? 'length' : 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text, parts, temporary, thinkingLevel,
      onDelta: (p) => {
        if (p.kind === 'status') { if (TOOL_VISIBILITY !== 'off') reasoning += `${p.text}\n`; return; }
        if (p.kind === 'reasoning') reasoning += p.text;
        else out += p.text;
      },
      onDone: (finishReason) => {
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: finishReason === 'length' ? 'length' : 'stop',
          }],
          // Estimates: the upstream stream reports no token counts, but some
          // clients refuse a response without a usage block.
          usage: {
            prompt_tokens: Math.ceil(text.length / 4),
            completion_tokens: Math.ceil(out.length / 4),
            total_tokens: Math.ceil((text.length + out.length) / 4),
          },
        });
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- extension channel */

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
  });
  const client = { id: randomUUID(), res };
  extClients.add(client);
  log(`extension connected (${extClients.size} total)`);
  sendToClient(client, 'ready', { clientId: client.id });
  for (const waiter of extClientWaiters) {
    try { waiter(client); } catch { /* ignore */ }
  }
  extClientWaiters.clear();
  setTimeout(() => listModels({ force: true }).catch(() => {}), 500);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    extClients.delete(client);
    log(`extension disconnected (${extClients.size} left)`);
    // Do NOT fail in-flight jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    for (const job of jobs.values()) if (job.client === client) job.client = null;
  });
}

async function extPost(req, res, kind) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { ok: false }); }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') for (const part of body.parts ?? []) job.delta(part);
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else job.fail(body.message ?? 'loader fetch failed');
  } else job.fail(body.message ?? 'extension reported an error');
  return json(res, 200, { ok: true });
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  try {
    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);

    if (path === '/v1/models') {
      const models = await listModels({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
        })),
      });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = await createConversation({ modelId: body.model, message: body.message, assistant: body.assistant });
      return json(res, 200, { id });
    }
    if (path === '/conversations') {
      await loadConversations().catch(() => {});
      return json(res, 200, {
        current: PINNED_CONVERSATION || conversationCache,
        conversations: conversationList.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        defaultModel = body.defaultModel.trim();
        log(`default model ${defaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); log(assistantId ? `assistant ${assistantId}` : 'assistant cleared'); }
      if (body.conversation === null || typeof body.conversation === 'string') {
        conversationCache = body.conversation || null;
        conversationIndex = 0;
        if (!conversationCache) conversationList = [];
        log(conversationCache ? `conversation ${conversationCache}` : 'conversation cleared');
      }
      return json(res, 200, { ok: true, defaultModel, assistant: assistantId || null, conversation: PINNED_CONVERSATION || conversationCache });
    }

    if (path === '/restart' && req.method === 'POST') {
      json(res, 200, { ok: true, message: 'restarting bridge server' });
      setTimeout(() => process.exit(0), 50);
      return;
    }

    if (path === '/logs') {
      const fs = await import('node:fs');
      const target = url.searchParams.get('file') || 'bridge';
      const logFile = `/var/log/${target}.log`;
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        return json(res, 200, { ok: true, file: logFile, lines: content.slice(-4000) });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    if (path === '/browser/restart' && req.method === 'POST') {
      import('node:child_process').then(({ exec }) => {
        exec('pkill -f chromium || pkill -f chrome || true');
      });
      return json(res, 200, { ok: true, message: 'restarting browser' });
    }

    if (path === '/ext/reload' && req.method === 'POST') {
      for (const client of extClients) sendToClient(client, 'reload_extension', {});
      return json(res, 200, { ok: true, message: 'reloading extension' });
    }

    if (path === '/tab/reload' && req.method === 'POST') {
      for (const client of extClients) sendToClient(client, 'reload_tab', {});
      return json(res, 200, { ok: true, message: 'reloading tab' });
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path === '/ext/chunk' && req.method === 'POST') return await extPost(req, res, 'chunk');
    if (path === '/ext/done' && req.method === 'POST') return await extPost(req, res, 'done');
    if (path === '/ext/error' && req.method === 'POST') return await extPost(req, res, 'error');
    if (path === '/ext/loader' && req.method === 'POST') return await extPost(req, res, 'loader');

    if (path === '/status' || path === '/health') {
      return json(res, 200, {
        ok: true,
        extensions: extClients.size,
        activeJobs: jobs.size,
        defaultModel,
        conversation: PINNED_CONVERSATION || conversationCache,
        assistant: assistantId || null,
        models: cachedModels(),
      });
    }

    return oaiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
  } catch (err) {
    log('unhandled', err);
    if (!res.headersSent) oaiError(res, 500, String(err?.message ?? err), 'server_error');
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\x1b[31m✗ Port ${PORT} is already in use.\x1b[0m`);
    console.error(`  Another bridge process is running. You can kill it with:\n  \x1b[36mfuser -k ${PORT}/tcp\x1b[0m  or  \x1b[36mpkill -f "bridge/server.mjs"\x1b[0m\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  log(`aipass bridge on http://${HOST}:${PORT}`);
  log(`  default model : ${defaultModel}`);
  log(`  conversation  : ${PINNED_CONVERSATION || 'most recent on the account'}`);
  log('  waiting for the Chrome extension…');
});
