#!/usr/bin/env node
// @ts-check
// Talk to aipass from the terminal. Streams the reply, renders it as markdown,
// shows server-side tool activity (web_search) as compact gutter lines, and
// lists sources at the end.
//
//   npm run chat                 interactive
//   npm run chat -- "question"   one-shot
//
// Everything that moves the cursor (spinner, the stream-then-reformat trick) is
// gated behind stdout.isTTY, so piped/non-tty output stays plain and stable.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * @typedef {object} BridgeStatus
 * @property {boolean} ok
 * @property {number} extensions
 * @property {number} activeJobs
 * @property {string} defaultModel
 * @property {string | null} conversation
 * @property {string | null} [assistant]
 * @property {Array<{ id: string, name?: string, free?: boolean }>} [models]
 */

/**
 * One `choices[0].delta` from an OpenAI-style chat.completion.chunk. The bridge
 * puts prose in `content` and web_search progress / sources in `reasoning_content`.
 * @typedef {object} ChatDelta
 * @property {string} [role]
 * @property {string} [content]
 * @property {string} [reasoning_content]
 */

/**
 * A single SSE frame from `POST /v1/chat/completions` (stream mode).
 * @typedef {object} SSEChunk
 * @property {{ message: string }} [error]
 * @property {Array<{ delta?: ChatDelta, finish_reason?: string | null }>} [choices]
 */

const argv = process.argv.slice(2);

/**
 * @param {string} name
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787') ?? '').replace(/\/+$/, '');
const CONVERSATION = flag('conversation', null);
// `--new` / `/new` don't create a conversation up front — that would seed the
// account's chat list with a throwaway "New chat." entry. Instead we defer:
// the next message the user actually sends becomes the seed, so the entry is
// titled by real text, exactly like the web UI's "new chat".
let pendingNew = argv.includes('--new');
let model = flag('model', '') ?? '';
const question = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();

/* ------------------------------------------------------------------- styling */

const TTY = Boolean(stdout.isTTY);

/**
 * Build an ANSI SGR wrapper. On a non-tty it is the identity, so piped output
 * stays clean.
 * @param {number} code
 * @returns {(s: string) => string}
 */
const sgr = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = sgr(2);
const bold = sgr(1);
const italic = sgr(3);
const underline = sgr(4);
const red = sgr(31);
const green = sgr(32);
const cyan = sgr(36);
const gray = sgr(90);

/** @param {string} s */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** @param {string} s */
const visLen = (s) => stripAnsi(s).length;
const termWidth = () => stdout.columns || 80;                    // real wrap point
const fmtWidth = () => Math.max(40, Math.min(termWidth(), 100)); // reading width
/** @param {string} [s] */
const out = (s = '') => stdout.write(s + '\n');
/** @param {string} s @param {number} n */
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…');

/** Compact "2h ago" / "3d ago" from an ISO timestamp. @param {string} [iso] */
function relative(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/**
 * Wrap a (possibly styled) string to `w` visible columns, breaking on spaces
 * and hard-splitting any single token longer than the line.
 * @param {string} text
 * @param {number} w
 * @returns {string[]}
 */
function wrap(text, w) {
  /** @type {string[]} */
  const lines = [];
  let cur = '';
  for (let tok of text.split(' ')) {
    while (visLen(tok) > w) {
      const head = tok.slice(0, w);
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(head);
      tok = tok.slice(w);
    }
    if (!cur) cur = tok;
    else if (visLen(cur) + 1 + visLen(tok) <= w) cur += ' ' + tok;
    else { lines.push(cur); cur = tok; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * First line gets `firstPrefix`, the rest get `contPrefix` (hanging indent).
 * @param {string} firstPrefix
 * @param {string} contPrefix
 * @param {string} body
 */
function emitWrapped(firstPrefix, contPrefix, body) {
  const lines = wrap(body, fmtWidth() - visLen(contPrefix));
  out(firstPrefix + lines[0]);
  for (let i = 1; i < lines.length; i++) out(contPrefix + lines[i]);
}

/* ---------------------------------------------------------- markdown, inline */

/** @param {string} s @returns {string} */
function inline(s) {
  s = s.replace(/`([^`]+)`/g, (_, c) => cyan(c));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `${underline(t)} ${dim('(' + u + ')')}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => bold(c));
  s = s.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, (_, c) => italic(c));
  return s;
}

/**
 * Block-level markdown, one source line at a time, holding fenced-code state
 * across calls. Answer text carries a two-space left margin.
 * @returns {(raw: string) => void}
 */
function makeRenderer() {
  const g = '  ';
  let inFence = false;

  return function line(raw) {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) { inFence = !inFence; out(g + gray('```' + (inFence ? fence[1].trim() : ''))); return; }
    if (inFence) { out(g + gray('│ ') + raw.replace(/\t/g, '    ')); return; }

    if (raw.trim() === '') { out(''); return; }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out(''); out(g + bold(cyan(inline(h[2])))); return; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { out(g + gray('─'.repeat(Math.min(fmtWidth() - 2, 48)))); return; }

    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) { emitWrapped(g + b[1] + gray('• '), g + b[1] + '  ', inline(b[2])); return; }

    const n = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (n) { emitWrapped(g + n[1] + gray(n[2] + '. '), g + n[1] + '   ', inline(n[3])); return; }

    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) { for (const l of wrap(inline(q[1]), fmtWidth() - 4)) out(g + gray('│ ') + dim(l)); return; }

    for (const l of wrap(inline(raw), fmtWidth() - 2)) out(g + l);
  };
}

/* ----------------------------------------------------------- tool activity */

/**
 * Render one `reasoning_content` block — a tool call/result line, or a
 * `sources:` list — compact and dim, never mixed into the prose.
 * @param {string} block
 */
function renderTool(block) {
  const lines = block.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const w = fmtWidth();
  let sources = false;
  let shown = 0;
  let hidden = 0;

  for (const l of lines) {
    if (/^sources:?\s*$/i.test(l)) { sources = true; out(''); out('  ' + dim('sources')); continue; }

    if (sources) {
      const entry = (l.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? l).trim();
      if (shown >= 6) { hidden++; continue; }
      shown++;
      const u = entry.match(/^(.*?)\s+(https?:\/\/\S+)\s*$/);
      if (u) { out('  ' + dim('· ' + truncate(u[1].trim(), w - 6))); out('    ' + gray(truncate(u[2], w - 6))); }
      else out('  ' + dim('· ' + truncate(entry, w - 6)));
      continue;
    }

    const t = l.match(/^\[([a-z0-9_]+)\]\s*(.*)$/i);
    if (t) out('  ' + green('⏺') + ' ' + dim('[' + t[1] + ']') + (t[2] ? ' ' + dim(truncate(t[2], w - 14)) : ''));
    else if (shown < 8) { shown++; out('  ' + dim('⎿ ' + truncate(l.trim(), w - 6))); }
    else hidden++;
  }
  if (hidden) out('  ' + dim('· … +' + hidden + ' more'));
}

/* ---------------------------------------------------------------- the call */

const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** @param {string} text */
async function ask(text) {
  const startedAt = Date.now();
  const W = termWidth();
  const md = makeRenderer();

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let frame = 0;
  const startSpin = () => {
    if (!TTY || timer !== null) return;
    timer = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      stdout.write('\r\x1b[K' + '  ' + cyan(spinFrames[frame = (frame + 1) % spinFrames.length]) + ' ' + dim(`thinking… ${s}s`));
    }, 90);
  };
  const stopSpin = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    if (TTY) stdout.write('\r\x1b[K');
  };

  // Live echo of the raw answer, tracking how many terminal rows it spans so we
  // can wipe it and re-print the same text as formatted markdown once complete.
  let raw = '';
  let rows = 0;
  let col = 0;
  /** @param {string} chunk */
  const echo = (chunk) => {
    raw += chunk;
    if (!TTY) { stdout.write(chunk); return; }
    stdout.write(dim(chunk));
    for (const ch of chunk) {
      if (ch === '\n') { rows++; col = 0; }
      else if (++col >= W) { rows++; col = 0; }
    }
  };
  const reformat = () => {
    if (TTY && (rows || col)) {
      stdout.write('\r' + (rows ? `\x1b[${rows}A` : '') + '\x1b[J');
      for (const l of raw.replace(/\n$/, '').split('\n')) md(l);
    } else if (!TTY && raw && !raw.endsWith('\n')) {
      stdout.write('\n');
    }
    raw = ''; rows = 0; col = 0;
  };

  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: text }] }),
  }).catch((/** @type {unknown} */ err) => {
    console.error(red(`\n✗ cannot reach the bridge: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  });
  if (!res) return;
  if (!res.ok) {
    console.error(red(`\n✗ bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`));
    return;
  }
  if (!res.body) { console.error(red('\n✗ bridge sent no response body')); return; }

  startSpin();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  /** @type {'tool' | 'answer' | null} */
  let kind = null;
  let wrote = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frameText = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frameText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      /** @type {SSEChunk} */
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) { stopSpin(); reformat(); console.error(red(`\n✗ ${evt.error.message}`)); return; }
      const delta = evt.choices?.[0]?.delta ?? {};

      if (delta.reasoning_content) {
        stopSpin();
        reformat();                        // commit any answer text seen so far
        renderTool(delta.reasoning_content);
        kind = 'tool';
        wrote = true;
        startSpin();
      }
      if (delta.content) {
        stopSpin();
        if (kind === 'tool') out('');      // keep tool blocks and prose apart
        echo(delta.content);
        kind = 'answer';
        wrote = true;
      }
    }
  }

  stopSpin();
  reformat();
  if (!wrote) out(dim('(no reply)'));
  else if (TTY) out(''); // leave the cursor on a fresh line, not mid-spinner-wipe
}

/* ---------------------------------------------------------------- pre-flight */

// response.json() is `unknown` under @types/node — assert the shape at the edge.
const status = /** @type {BridgeStatus | null} */ (
  await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null)
);
if (!status) {
  console.error(red(`No bridge at ${BRIDGE}. Start it with: npm run dev`));
  process.exit(1);
}
if (!status.extensions) {
  console.error(red('The extension is not connected. Open a https://de.aipass.net/chat tab.'));
  process.exit(1);
}
model ||= status.defaultModel;

if (CONVERSATION) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: CONVERSATION }),
  }).catch(() => {});
}

/**
 * If a fresh conversation is pending (`--new` or `/new`), create it now with
 * `seed` as its first message and point the bridge at it. No-op otherwise, so
 * it is safe to call before every message.
 * @param {string} seed
 */
async function maybeStartNew(seed) {
  if (!pendingNew) return;
  pendingNew = false;
  const made = /** @type {{ id?: string } | null} */ (
    await fetch(`${BRIDGE}/conversations/new`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, message: seed }),
    }).then((r) => r.json()).catch(() => null)
  );
  if (made?.id) {
    if (status) status.conversation = made.id;
    console.log(dim(`  new session ${made.id}`));
  } else {
    console.log(red('  could not start a new conversation — continuing in the current one'));
  }
}

if (question) {
  await maybeStartNew(question);
  await ask(question);
  process.exit(0);
}

/* ------------------------------------------------------------- interactive */

function banner() {
  const w = Math.min(fmtWidth(), 60);
  const inner = w - 2;
  /** @param {string} s */
  const row = (s) => gray('│') + ' ' + s + ' '.repeat(Math.max(0, inner - 2 - visLen(s))) + gray('│');
  out(gray('╭' + '─'.repeat(inner) + '╮'));
  out(row(bold(cyan('✳ aipass')) + dim('  terminal chat')));
  out(row(''));
  out(row(dim('model    ') + model));
  out(row(dim('session  ') + (status?.conversation ?? 'starts on first message')));
  out(row(dim('bridge   ') + BRIDGE.replace(/^https?:\/\//, '')));
  out(gray('╰' + '─'.repeat(inner) + '╯'));
  out(dim('  type /  ·  ↑↓ choose  ·  Tab fill  ·  Enter run  ·  /help  ·  Ctrl+C'));
}

// One source of truth for the slash commands: the /help text and the live menu.
/** @type {Array<[string, string]>} */
const COMMANDS = [
  ['/models', 'list available models'],
  ['/model', 'switch model — /model <id>'],
  ['/conversations', 'switch conversation — ↑↓ then Enter'],
  ['/new', 'start a fresh conversation'],
  ['/clear', 'clear the screen'],
  ['/help', 'show this list'],
];
const CMD_PAD = Math.max(...COMMANDS.map(([n]) => n.length));
const HELP = [...COMMANDS.map(([n, d]) => `  ${n.padEnd(CMD_PAD)}  ${d}`), `  ${'Ctrl+C'.padEnd(CMD_PAD)}  quit`]
  .map((l) => dim(l)).join('\n');

banner();

const rl = readline.createInterface({ input: stdin, output: stdout });
rl.on('SIGINT', () => { out(); rl.close(); process.exit(0); });

/* --- slash-command menu: drops down while you type a "/command" (TTY only).
   ↑/↓ move the highlight, Tab fills it in, Enter runs it, Esc dismisses.       */

const PROMPT = '❯ ';

// A light frame around the input: a rounded rule above the prompt, a matching
// one below once the line is submitted. No side bars — readline owns the line
// width, so we can't reliably close the right edge without redrawing on every
// keystroke.
const boxRule = (/** @type {string} */ l, /** @type {string} */ r) =>
  gray(l + '─'.repeat(Math.max(2, termWidth() - 3)) + r); // full terminal width, -1 col so the corner never wraps
const topRule = () => boxRule('╭', '╮');
const botRule = () => boxRule('╰', '╯');

let menuOpen = false;
/** @type {Array<[string, string]>} rows currently shown (real matches only) */
let menuHits = [];
let menuSel = 0;     // highlighted index into menuHits
let slashBuf = '';   // the "/…" text the user has typed
/** @type {string | null} command chosen with Enter, consumed by the loop */
let pendingPick = null;

const promptCol = () => PROMPT.length + 1 + rl.cursor;

/**
 * Force the readline buffer to a known string via public rl.write, so we never
 * touch its private redraw internals. Used to undo history navigation that
 * fires on ↑/↓ while the menu owns those keys.
 * @param {string} text
 */
function setLine(text) {
  rl.write(null, { ctrl: true, name: 'a' });
  rl.write(null, { ctrl: true, name: 'k' });
  if (text) rl.write(text);
}

function closeMenu() {
  if (!TTY || !menuOpen) return;
  stdout.write(`\r\n\x1b[J\x1b[1A\x1b[${promptCol()}G`);
  menuOpen = false;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.keepSel] keep the current highlight instead of resetting to 0
 */
function drawMenu({ keepSel = false } = {}) {
  if (!TTY) return;
  const buf = rl.line;
  if (!/^\/\S*$/.test(buf)) return closeMenu(); // only while typing the command word
  slashBuf = buf;

  menuHits = COMMANDS.filter(([name]) => name.startsWith(buf.toLowerCase()));
  if (!keepSel) menuSel = 0;
  if (menuSel >= menuHits.length) menuSel = Math.max(0, menuHits.length - 1);

  /** @type {Array<[string, string]>} */
  const shown = menuHits.length ? menuHits : [['', 'no matching command']];
  const rows = shown.map(([name, desc], i) => {
    const on = menuHits.length > 0 && i === menuSel;
    const label = name.padEnd(CMD_PAD);
    return on ? `  ${cyan('›')} ${cyan(label)} ${desc}` : `    ${dim(label)} ${dim(desc)}`;
  });
  // Drop below the input line (the terminal scrolls once to make room), wipe
  // whatever was there, print, then climb back and restore the typing column.
  stdout.write(`\r\n\x1b[J${rows.join('\n')}\x1b[${rows.length}A\x1b[${promptCol()}G`);
  menuOpen = true;
}

if (TTY) {
  stdin.on('keypress', (/** @type {string} */ _ch, /** @type {import('node:readline').Key} */ key) => {
    const name = key?.name;

    if (menuOpen && (name === 'up' || name === 'down')) {
      const n = menuHits.length;
      if (n) menuSel = (menuSel + (name === 'down' ? 1 : n - 1)) % n;
      if (rl.line !== slashBuf) setLine(slashBuf); // readline may have jumped history
      drawMenu({ keepSel: true });
      return;
    }
    if (menuOpen && name === 'tab') {
      const pick = menuHits[menuSel]?.[0];
      closeMenu();
      if (pick) setLine(pick === '/model' ? `${pick} ` : pick);
      return;
    }
    if (menuOpen && name === 'escape') { closeMenu(); return; }
    if (name === 'return') { pendingPick = (menuOpen && menuHits[menuSel]?.[0]) || null; return; }

    setImmediate(drawMenu);
  });
}

/**
 * @typedef {{ id: string, title?: string, updatedAt?: string }} ConvRow
 */

/**
 * Full-screen-ish picker: renders the conversation list, ↑/↓ moves the cursor,
 * Enter selects, Esc cancels. Takes the keyboard away from readline for the
 * duration (its keypress listeners are detached and restored on exit) so arrow
 * keys don't leak into history navigation.
 * @param {ConvRow[]} convs   newest-first
 * @param {string | null} current   id of the active conversation
 * @returns {Promise<ConvRow | null>}
 */
function pickConversation(convs, current) {
  return new Promise((resolve) => {
    let sel = Math.max(0, convs.findIndex((c) => c.id === current));
    let painted = 0;
    const titleW = Math.min(fmtWidth() - 18, 48);

    const paint = () => {
      if (painted) stdout.write(`\x1b[${painted}A`);
      stdout.write('\r\x1b[J');
      const rows = [dim(`  ↑↓ choose · Enter switch · Esc cancel`)];
      convs.forEach((c, i) => {
        const here = c.id === current ? green('●') : ' ';
        const cur = i === sel ? cyan('›') : ' ';
        const title = truncate(c.title || '(untitled)', titleW).padEnd(titleW);
        const when = dim((relative(c.updatedAt) || '').padStart(9));
        const t = i === sel ? cyan(title) : title;
        rows.push(`  ${cur} ${here} ${t}  ${when}`);
      });
      stdout.write(rows.join('\n') + '\n');
      painted = rows.length;
    };

    /** @type {Array<(...a: any[]) => void>} */
    const rlKeys = /** @type {any} */ (stdin.listeners('keypress'));
    for (const l of rlKeys) stdin.off('keypress', l);

    /** @param {ConvRow | null} choice */
    const finish = (choice) => {
      stdin.off('keypress', onKey);
      for (const l of rlKeys) stdin.on('keypress', l);
      if (painted) stdout.write(`\x1b[${painted}A\r\x1b[J`); // wipe the picker
      resolve(choice);
    };

    /** @param {string} _ch @param {import('node:readline').Key} [key] */
    const onKey = (_ch, key) => {
      const n = key?.name;
      if (n === 'up') { sel = (sel - 1 + convs.length) % convs.length; paint(); }
      else if (n === 'down') { sel = (sel + 1) % convs.length; paint(); }
      else if (n === 'return') finish(convs[sel]);
      else if (n === 'escape') finish(null);
      else if (key?.ctrl && n === 'c') { finish(null); process.exit(0); }
    };

    stdin.on('keypress', onKey);
    paint();
  });
}

// Resolve the loop cleanly when the input stream ends, without leaving the
// question() promise as an unsettled top-level await.
const CLOSED = Symbol('closed');
/** @type {Promise<typeof CLOSED>} */
const closed = new Promise((resolve) => rl.once('close', () => resolve(CLOSED)));

for (;;) {
  if (TTY) { out(''); out(topRule()); }
  /** @type {string | typeof CLOSED} */
  let line;
  try { line = await Promise.race([rl.question((TTY ? '' : '\n') + cyan(PROMPT)), closed]); }
  catch { break; } // Ctrl+C / Ctrl+D
  if (line === CLOSED) { if (TTY) out(); break; }
  if (TTY && menuOpen) { stdout.write('\x1b[J'); menuOpen = false; } // clear the dropdown
  if (TTY) out(botRule()); // close the input frame under the submitted line
  if (pendingPick) { line = pendingPick; pendingPick = null; }
  line = line.trim();
  if (!line) continue;

  if (line === '/help') { console.log(HELP); continue; }

  if (line === '/clear') { stdout.write(TTY ? '\x1b[2J\x1b[H' : '\n'); banner(); continue; }

  if (line === '/models') {
    const r = /** @type {{ data?: Array<{ id: string, name?: string, free_credit?: boolean }> } | null} */ (
      await fetch(`${BRIDGE}/v1/models`).then((x) => x.json()).catch(() => null)
    );
    if (!r?.data) { console.log(red('  could not list models')); continue; }
    for (const m of r.data) {
      const mark = m.id === model ? green('●') : ' ';
      console.log('  ' + mark + ' ' + m.id.padEnd(34) + dim(m.name ?? '') + (m.free_credit ? green('  free') : ''));
    }
    continue;
  }

  if (line.startsWith('/model ')) {
    model = line.slice(7).trim();
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: model }),
    }).catch(() => {});
    console.log(dim(`  model → ${model}`));
    continue;
  }

  if (line === '/conversations' || line === '/switch') {
    const r = /** @type {{ current?: string, conversations?: ConvRow[] } | null} */ (
      await fetch(`${BRIDGE}/conversations`).then((x) => x.json()).catch(() => null)
    );
    const all = r?.conversations ?? [];
    if (!all.length) { console.log(dim('  no conversations yet — send a message or /new')); continue; }
    const list = all.slice(0, 12);
    const current = r?.current ?? status?.conversation ?? null;

    if (!TTY) { // no cursor control off a tty — just print the list
      for (const c of list) console.log(`  ${c.id === current ? '●' : ' '} ${c.id}  ${dim(c.title ?? '')}`);
      continue;
    }

    const chosen = await pickConversation(list, current);
    if (all.length > list.length) console.log(dim(`  (showing ${list.length} most recent of ${all.length})`));
    if (!chosen) { console.log(dim('  cancelled')); continue; }
    if (chosen.id === current) { console.log(dim('  already on that one')); continue; }
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: chosen.id }),
    }).catch(() => {});
    if (status) status.conversation = chosen.id;
    pendingNew = false; // an explicit switch overrides a pending /new
    console.log(dim(`  switched to ${chosen.id}${chosen.title ? ` · ${chosen.title}` : ''}`));
    continue;
  }

  if (line === '/new') {
    pendingNew = true;
    console.log(dim('  next message starts a fresh conversation'));
    continue;
  }

  out();
  await maybeStartNew(line);
  await ask(line);
}
rl.close();
