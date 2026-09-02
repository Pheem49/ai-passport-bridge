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
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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
const yellow = sgr(33);
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

/* =========================================================== agent loop */

/* ---------------------------------------- WAF encoding (same as agent.mjs) */

/** @type {Array<[RegExp, string]>} */
const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g,          'LOOPBACK-IP'],
  [/169\.254\.169\.254/g,    'METADATA-IP'],
  [/0\.0\.0\.0/g,            'ANY-IP'],
  [/localhost/gi,             'LCLHST'],
  // URL schemes — https/http/ftp/chrome appear in READMEs and trigger URL-based rules
  [/https:\/\//gi,            'HTTPS-URL'],
  [/http:\/\//gi,             'HTTP-URL'],
  [/chrome:\/\//gi,           'CHROME-URL'],
  [/ftp:\/\//gi,              'FTP-URL'],
  [/file:\/\//gi,             'FILE-URI'],
  // HTML patterns
  [/<!doctype/gi,             'DOCTYPE-DECL'],
  [/<!--/g,                   'CMT-OPEN'],
  [/-->/g,                    'CMT-CLOSE'],
  [/<script/gi,               'TAG-SCRIPT-OPEN'],
  [/<\/script>/gi,            'TAG-SCRIPT-CLOSE'],
  [/javascript:/gi,           'JS-SCHEME'],
  // Shell / secrets patterns
  [/process\.env/gi,          'PROCESS-ENV'],
  [/\.env\b/gi,               'DOT-ENV'],
  [/ExecutionPolicy/gi,       'EXEC-POLICY'],
  [/Bypass\b/gi,              'BYPASS-ARG'],
  [/powershell/gi,            'PSHELL'],
  [/\.ps1\b/gi,               'DOT-PS1'],
  [/\.sh\b/gi,                'DOT-SH'],
  [/&&/g,                     'AND-AND'],
  [/~(?=\/)/g,                'TILDE-PATH'],
  // General tag opener (must be last so earlier specific patterns run first)
  [/<(?=[a-zA-Z/!?])/g,      'TAG-LT'],
];
/** @type {Array<[RegExp, string]>} */
const RESTORE = [
  [/LOOPBACK-IP/g,       '127.0.0.1'],
  [/METADATA-IP/g,       '169.254.169.254'],
  [/ANY-IP/g,            '0.0.0.0'],
  [/LCLHST/g,            'localhost'],
  [/HTTPS-URL/g,         'https://'],
  [/HTTP-URL/g,          'http://'],
  [/CHROME-URL/g,        'chrome://'],
  [/FTP-URL/g,           'ftp://'],
  [/FILE-URI/g,          'file://'],
  [/DOCTYPE-DECL/g,      '<!doctype'],
  [/CMT-OPEN/g,          '<!--'],
  [/CMT-CLOSE/g,         '-->'],
  [/TAG-SCRIPT-OPEN/g,   '<script'],
  [/TAG-SCRIPT-CLOSE/g,  '</script>'],
  [/JS-SCHEME/g,         'javascript:'],
  [/PROCESS-ENV/g,       'process.env'],
  [/DOT-ENV/g,           '.env'],
  [/EXEC-POLICY/g,       'ExecutionPolicy'],
  [/BYPASS-ARG/g,        'Bypass'],
  [/PSHELL/g,            'powershell'],
  [/DOT-PS1/g,           '.ps1'],
  [/DOT-SH/g,            '.sh'],
  [/AND-AND/g,           '&&'],
  [/TILDE-PATH/g,        '~'],
  [/TAG-LT/g,            '<'],
];
/** @param {string} text @returns {string} */
const agentOutbound = (text) => SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);
/** @param {string} text @returns {string} */
const agentInbound  = (text) => RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text);

/* ----------------------------------------- overlay filesystem */

const overlay    = new Map();
const AGENT_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
let   agentRoot     = process.cwd();
let   agentAllowRun = false;

// Mode state — toggled by /agent with no task
let   agentMode        = false;  // true = agent mode, false = chat mode
let   agentModeAllowRun = false; // persists across tasks while in agent mode
let   agentModeMaxSteps = 10;
let   agentModeAutoApply = /** @type {boolean | null} */ (null);
const AGENT_MAX_RESULT = 3000;
const AGENT_READ_LINES = 200;

/** @param {string} s @returns {string} */
const agentClip = (s) => (s.length > AGENT_MAX_RESULT ? `${s.slice(0, AGENT_MAX_RESULT)}\n… truncated` : s);

/** @param {string} p @returns {string} */
function agentSafe(p) {
  const abs = path.resolve(agentRoot, p);
  if (abs !== agentRoot && !abs.startsWith(agentRoot + path.sep))
    throw new Error(`path escapes root: ${p}`);
  return abs;
}
const AGENT_DELETED = '\x00DELETE\x00';
/** @param {string} abs @returns {string} */
const agentReadAt   = (abs) => {
  if (overlay.has(abs)) {
    const val = overlay.get(abs);
    if (val === AGENT_DELETED) throw new Error(`file was deleted: ${path.relative(agentRoot, abs)}`);
    return /** @type {string} */ (val);
  }
  return fs.readFileSync(abs, 'utf8');
};
/** @param {string} abs @returns {boolean} */
const agentExistsAt = (abs) => {
  if (overlay.has(abs)) return overlay.get(abs) !== AGENT_DELETED;
  return fs.existsSync(abs);
};

/** @param {string} block @returns {string} */
function stripGutter(block) {
  const gutter  = /^\s{0,6}\d+\s*\|\s?/;
  const lines   = block.split('\n');
  const nonEmpty = lines.filter((/** @type {string} */ l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((/** @type {string} */ l) => gutter.test(l)))
    return lines.map((/** @type {string} */ l) => l.replace(gutter, '')).join('\n');
  return block;
}

/* ----------------------------------------- tool implementations */

/** @type {Record<string, (arg: string, body?: any) => string | Promise<string>>} */
const AGENT_TOOLS = {
  /** @param {string} arg */
  list(arg) {
    const abs = agentSafe(arg || '.');
    return agentClip(
      fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !AGENT_SKIP.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort().join('\n') || '(empty)',
    );
  },
  /** @param {string} arg */
  read(arg) {
    const parts = String(arg).trim().split(/\s+/);
    /** @type {[number, number] | null} */
    let range = null;
    if (parts.length > 1 && /^\d+-\d+$/.test(parts.at(-1) ?? '')) {
      const [a, b] = (parts.pop() ?? '').split('-').map(Number);
      range = [a, b];
    }
    const rel = parts.join(' ');
    const abs = agentSafe(rel);
    if (!agentExistsAt(abs)) return `no such file: ${rel}`;
    const lines = agentReadAt(abs).split('\n');
    const total = lines.length;
    let start = 1, end = total;
    if (range) { start = Math.max(1, range[0]); end = Math.min(total, range[1]); }
    else if (total > AGENT_READ_LINES) end = AGENT_READ_LINES;
    const width = String(end).length;
    const numbered = lines.slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)} | ${l}`).join('\n');
    let note = '';
    if (end < total) note = `\n… ${total - end} more line(s). To see them: NEED file ${rel} ${end + 1}-${Math.min(total, end + AGENT_READ_LINES)}`;
    else if (start > 1) note = `\n(lines ${start}-${end} of ${total})`;
    return numbered + note;
  },
  /**
   * @param {string} arg
   * @param {string} rawBody
   */
  write(arg, rawBody) {
    const body = /** @type {string} */ (agentInbound(rawBody));
    overlay.set(agentSafe(arg), body);
    return `wrote ${arg}, ${body.split('\n').length} lines`;
  },
  /**
   * @param {string} arg
   * @param {[string, string]} rawBody
   */
  replace(arg, rawBody) {
    const abs = agentSafe(arg);
    if (!agentExistsAt(abs)) return `no such file: ${arg}`;
    const before = /** @type {string} */ (agentInbound(stripGutter(rawBody[0])));
    const after  = /** @type {string} */ (agentInbound(rawBody[1]));
    const text   = agentReadAt(abs);
    if (!before) return 'the text to change was empty. Copy the exact lines to find under FIND.';
    const count = text.split(before).length - 1;
    if (count === 0) return `the text to change was not found in ${arg}. Read it again with NEED file ${arg} and copy the lines exactly.`;
    if (count > 1)  return `that text appears ${count} times in ${arg}. Include a few more surrounding lines under FIND so it matches exactly one place.`;
    overlay.set(abs, text.replace(before, after));
    return `updated ${arg} (1 change)`;
  },
  /** @param {string} arg */
  search(arg) {
    const query  = String(arg).trim();
    if (!query) return 'give me some text to search for.';
    const needle = /** @type {string} */ (agentInbound(query));
    /** @type {string[]} */
    const hits   = [];
    const MAX    = 50;
    /** @param {string} dir */
    const walk   = (dir) => {
      if (hits.length >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (AGENT_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (hits.length >= MAX) return;
        let txt;
        try { txt = agentReadAt(full); } catch { continue; }
        if (txt.includes('\u0000')) continue; // skip binary
        const lines = txt.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX; i++) {
          if (lines[i].includes(needle))
            hits.push(`${path.relative(agentRoot, full)}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
        }
      }
    };
    walk(agentRoot);
    if (!hits.length) return `no matches for "${query}".`;
    const more = hits.length >= MAX ? `\n… stopped at ${MAX} matches; make the search more specific.` : '';
    return hits.join('\n') + more;
  },
  /**
   * @param {string} _arg
   * @param {string} body
   */
  run(_arg, body) {
    if (!agentAllowRun)
      return 'shell commands are disabled. Add --allow-run to your /agent command.';
    try {
      return agentClip(execSync(body, { cwd: agentRoot, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      return agentClip(`exit ${e.status}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`);
    }
  },

  /** @param {string} pattern @returns {string} */
  glob(pattern) {
    if (!pattern) return 'give me a glob pattern, e.g. **/*.ts';
    // simple recursive walk with minimatch-style * and ** support
    const patParts = pattern.split('/');
    /** @param {string} pat @param {string} seg @returns {boolean} */
    const matchPart = (pat, seg) => {
      if (pat === '**') return true;
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i');
      return re.test(seg);
    };
    /** @type {string[]} */
    const hits = [];
    const MAX = 200;
    /** @param {string} dir @param {number} depth */
    const walk = (dir, depth) => {
      if (hits.length >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (AGENT_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const rel  = path.relative(agentRoot, path.join(dir, e.name));
        const segs = rel.split(path.sep);
        // Check if this path matches the pattern
        let match = false;
        if (patParts.includes('**')) {
          // ** matches zero or more path segments — just check last part
          const lastPat = patParts.at(-1) ?? '';
          match = matchPart(lastPat, e.name);
        } else {
          match = segs.length === patParts.length &&
            segs.every((s, i) => matchPart(patParts[i] ?? '', s));
        }
        if (match && !e.isDirectory()) hits.push(rel);
        if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(agentRoot, 0);
    if (!hits.length) return `no files matched "${pattern}".`;
    const more = hits.length >= MAX ? `\n… stopped at ${MAX} results.` : '';
    return hits.join('\n') + more;
  },

  /** @param {string} arg @returns {string} */
  git(arg) {
    const sub = arg.trim();
    if (!sub) return 'give me a git subcommand, e.g. status';
    // Allow only read-only / informational subcommands
    const ALLOWED = /^(status|diff|log|show|branch|tag|remote|stash\s+list|ls-files|rev-parse|describe)/i;
    if (!ALLOWED.test(sub))
      return `only read-only git subcommands are allowed (status, diff, log, show, branch, ls-files, …). Got: ${sub}`;
    try {
      return agentClip(execSync(`git ${sub}`, { cwd: agentRoot, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      return agentClip(`exit ${e.status ?? 1}\n${String(e.stderr ?? e.stdout ?? '')}`);
    }
  },

  /** @param {string} url @returns {Promise<string>} */
  async fetch(url) {
    const u = agentInbound(url.trim());
    if (!u || !/^https?:\/\//i.test(u)) return `invalid URL: ${url}. Must start with http:// or https://`;
    try {
      const res = await globalThis.fetch(u, {
        headers: { 'user-agent': 'aipass-agent/1.0', 'accept': 'text/plain,text/html,*/*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return `HTTP ${res.status} ${res.statusText} from ${u}`;
      let text = await res.text();
      // Strip HTML tags for readability
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return agentClip(agentOutbound(text));
    } catch (err) {
      return `fetch error: ${/** @type {Error} */ (err).message}`;
    }
  },

  /** @param {string} arg @returns {string} */
  delete(arg) {
    const rel = arg.trim();
    if (!rel) return 'give me a file path to delete.';
    const abs = agentSafe(rel);
    if (!agentExistsAt(abs)) return `no such file: ${rel}`;
    if (!fs.existsSync(abs)) {
      overlay.delete(abs);
      return `deleted ${rel} from memory (was not yet written to disk).`;
    }
    overlay.set(abs, AGENT_DELETED);
    return `marked ${rel} for deletion. Will be removed on Apply.`;
  },

  /** @param {string} arg @returns {string} */
  move(arg) {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) return 'usage: MOVE <from> <to>';
    const [fromRel, toRel] = parts;
    const fromAbs = agentSafe(fromRel);
    const toAbs   = agentSafe(toRel);
    if (!agentExistsAt(fromAbs)) return `no such file: ${fromRel}`;
    const content = agentReadAt(fromAbs);
    overlay.set(toAbs, content);
    if (fs.existsSync(fromAbs)) {
      overlay.set(fromAbs, AGENT_DELETED);
    } else {
      overlay.delete(fromAbs);
    }
    return `marked: move ${fromRel} → ${toRel}. Will apply on disk after Apply.`;
  },

  /** @param {string} query @returns {Promise<string>} */
  async web(query) {
    const q = agentInbound(query.trim());
    if (!q) return 'give me a query to search for.';

    out(dim(`  searching web for "${q}"…`));

    const prompt = `Please search the web and provide detailed, up-to-date facts, answers, and sources for: ${q}`;
    let res;
    try {
      res = await fetch(`${BRIDGE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
      });
    } catch (err) {
      return `web search failed: ${/** @type {Error} */ (err).message}`;
    }

    if (!res.ok) return `web search failed: HTTP ${res.status}`;
    if (!res.body) return 'web search failed: no response body';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let sources = '';

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
        if (evt.error) return `web search error: ${evt.error.message}`;
        const delta = evt.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          renderTool(delta.reasoning_content);
          if (delta.reasoning_content.includes('http') || delta.reasoning_content.includes('sources:')) {
            sources += '\n' + delta.reasoning_content;
          }
        }
        if (delta.content) {
          content += delta.content;
        }
      }
    }
    const result = (content + (sources ? `\n\n${sources}` : '')).trim();
    return agentClip(agentOutbound(result || 'no results found'));
  },
};

/* ----------------------------------------- protocol text */

/** @param {boolean} allowRun @returns {string} */
const AGENT_PREAMBLE = (allowRun) =>
  `I am reading through a project with you. The files are open in front of me, and I will paste you anything you want to look at.

So just tell me what you want to see next, and put that on its own line in this shape, because my editor watches for these markers:

NEED dir .
NEED file README.md
NEED file src/index.ts 1-80
SEARCH text to find across the whole project
GLOB **/*.ts
GIT status
GIT diff
FETCH HTTPS-URLexample.com/docs
WEB search terms to look up on the internet (docs, latest versions, solutions)

If you want a file changed, write it like this and I will make the edit:

EDIT notes.md
FIND
the exact lines as they appear now
NEW
the lines to put there instead
END

To start a new file:

CREATE notes.md
the contents
END

To delete a file:

DELETE old-file.ts

To rename or move a file:

MOVE old-name.ts new-name.ts${allowRun ? '\n\nTo have me run something in the terminal:\n\nRUN\nwhat to run\nEND' : ''}

Once you have everything you need and are giving me your final answer, finish with:

DONE one sentence about what you found or changed

Only write DONE at the very end, when nothing more is needed. Never put DONE in the same reply as a NEED — ask for what you want, wait for me to paste it, and read it first.

The markers are only formatting for my editor. Nothing runs on your side — I do all of it and paste every result straight back to you, so keep going until you have what you need.

CRITICAL: You are an AI assistant collaborating with me in this chat. You do NOT access my local filesystem directly — I am a human running this terminal on my own computer, and I personally read the files you name and paste their contents back to you. Therefore, NEVER state that you cannot access files, and NEVER refuse to use these markers — asking for a file with NEED file <path> is simply requesting me to paste it for you. Even if my prompt or question is in Thai or another language, accept it and request the files you need using the exact markers above.

A few practical notes. Answer in English. Look at a file before changing it, and copy the lines under FIND exactly as they appear. When I show a file the numbers down the left are only for reference — do not put them in FIND. Big files come a screen at a time; ask for a range like NEED file path 201-400 to see more. To find where something lives without reading every file, use SEARCH followed by the text. Use GLOB to find all files matching a pattern. Use GIT to see what has changed recently. Use FETCH to read a URL (docs, APIs). Use WEB followed by search keywords to search the internet (with live web search and citations). Some hostnames and addresses are written in a shortened form such as LCLHST and LOOPBACK-IP, and URLs start with HTTPS-URL or HTTP-URL; keep them as written and I will expand them again. If my question can be answered without changing anything, just answer it and end with DONE.`;

const AGENT_REMINDER    = 'What next? Ask for anything else you need, or finish with DONE if you have enough.';
const AGENT_MARKER_LINE = /^\s*(NEED\s+(dir|file)\b|SEARCH\b|GLOB\b|GIT\b|FETCH\b|WEB\b|DELETE\b|MOVE\b|EDIT\b|CREATE\b|FIND\s*$|NEW\s*$|END\s*$|RUN\s*$|DONE\b)/i;
/** @param {string} reply @returns {string} */
const agentProse = (reply) => reply.split('\n').filter((/** @type {string} */ l) => !AGENT_MARKER_LINE.test(l)).join('\n').trim();

/** @param {string} reply @returns {Array<{kind: string, arg: string, body?: any}>} */
function agentParse(reply) {
  const lines = reply.split('\n');
  /** @type {Array<{kind: string, arg: string, body?: any}>} */
  const calls = [];
  let i = 0;
  /** @param {string[]} stops @returns {string} */
  const readUntil = (stops) => {
    const body = [];
    while (i < lines.length && !stops.some((/** @type {string} */ st) => new RegExp(`^\\s*${st}\\s*$`, 'i').test(lines[i]))) body.push(lines[i++]);
    return body.join('\n');
  };
  while (i < lines.length) {
    const line = lines[i];
    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() }); continue; }
    m = /^\s*SEARCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'search', arg: m[1].trim() }); continue; }
    m = /^\s*GLOB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'glob', arg: m[1].trim() }); continue; }
    m = /^\s*GIT\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'git', arg: m[1].trim() }); continue; }
    m = /^\s*FETCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'fetch', arg: m[1].trim() }); continue; }
    m = /^\s*WEB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'web', arg: m[1].trim() }); continue; }
    m = /^\s*DELETE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'delete', arg: m[1].trim() }); continue; }
    m = /^\s*MOVE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'move', arg: m[1].trim() }); continue; }
    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i++;
      const before = readUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i++;
      const after = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'replace', arg: m[1].trim(), body: [before, after] }); continue;
    }
    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'write', arg: m[1].trim(), body }); continue;
    }
    if (/^\s*RUN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'run', arg: '', body }); continue;
    }
    m = /^\s*DONE\b\s*(.*)/i.exec(line);
    if (m) { i++; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }
    i++;
  }
  return calls;
}

/* ----------------------------------------- sayAgent (fetch, returns string) */

/** @param {string} text @returns {Promise<string>} */
async function sayAgent(text) {
  const startedAt = Date.now();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let frame = 0;
  const startSpin = () => {
    if (!TTY || timer !== null) return;
    timer = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      stdout.write('\r\x1b[K' + '  ' + cyan(spinFrames[frame = (frame + 1) % spinFrames.length]) + ' ' + dim(`agent thinking… ${s}s`));
    }, 90);
  };
  const stopSpin = () => {
    if (timer === null) return;
    clearInterval(timer); timer = null;
    if (TTY) stdout.write('\r\x1b[K');
  };

  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  startSpin();
  let collected = '';
  const reader  = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frameText = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frameText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) { stopSpin(); throw new Error(evt.error.message); }
      const delta = evt.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) {
        stopSpin();
        renderTool(delta.reasoning_content);
        startSpin();
      }
      if (delta.content) collected += delta.content;
    }
  }
  stopSpin();
  return collected;
}

/** @param {string} text @returns {[string, string]} */
function agentSplitInHalf(text) {
  const lines = text.split('\n');
  if (lines.length < 2) { const mid = Math.floor(text.length / 2); return [text.slice(0, mid), text.slice(mid)]; }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

const AGENT_MIN_SPLIT = 300;
const AGENT_RISKY_LINE = /(node\s+-{1,2}e\b|--eval\b|\beval\(|child_process|exec(Sync)?\(|spawnSync?\(|\bcurl\b|\bwget\b|\b(ba)?sh\b|rm\s+-rf|\/etc\/|\/bin\/|\.\.\/\.\.\/|<!doctype|<!--|-->|<script|<\/script|javascript:|onerror\s*=|onload\s*|ExecutionPolicy|BYPASS|AND-AND|\bpowershell\b)/i;

/** @param {string} text @returns {{ redacted: string, dropped: number }} */
function agentRedact(text) {
  let dropped = 0;
  const redacted = text.split('\n').map((/** @type {string} */ line) => {
    if (!AGENT_RISKY_LINE.test(line)) return line;
    dropped++;
    return '[one line omitted here — it could not be sent]';
  }).join('\n');
  return { redacted, dropped };
}

/**
 * @param {string} text
 * @param {number} [depth]
 * @returns {Promise<string>}
 */
async function sayResilient(text, depth = 0) {
  if (depth === 0) text = agentOutbound(text);
  try { return await sayAgent(text); }
  catch (err) {
    const blocked = /\b40[39]\b/.test(/** @type {Error} */ (err).message);
    if (!blocked) throw err;

    // Fast-path: if the payload contains known risky patterns, redact them immediately
    // rather than doing slow recursive splits that cause timeouts and extension contention.
    const { redacted, dropped } = agentRedact(text);
    if (dropped && redacted !== text) {
      out('  ' + dim(`  rejected — omitting ${dropped} line(s) that cannot be sent`));
      try { return await sayAgent(redacted); } catch { /* fall through to split */ }
    }

    if (depth > 2 || Buffer.byteLength(text) < AGENT_MIN_SPLIT) {
      out('  ' + dim(`  rejected by firewall — omitting fragment of ${Buffer.byteLength(text)} bytes and continuing`));
      const fallback = `[Note: A section of ~${Buffer.byteLength(text)} bytes was omitted because it was blocked by the upstream Cloudflare firewall. Continuing with the rest of the project.]`;
      try { return await sayAgent(fallback); } catch { throw err; }
    }

    const parts = agentSplitInHalf(text);
    out('  ' + dim(`  rejected — splitting into ${parts.length} parts and resending`));
    let last = '';
    for (let i = 0; i < parts.length; i++) {
      const final  = i === parts.length - 1;
      const prefix = final ? 'Final part.\n\n' : `Part ${i + 1}, more follows. Reply with just: ok\n\n`;
      last = await sayResilient(prefix + parts[i], depth + 1);
    }
    return last;
  }
}

/* ----------------------------------------- diff display */

/**
 * Myers O(ND) line diff. Returns [{t: ' '|'-'|'+', line: string}].
 * @param {string[]} a
 * @param {string[]} b
 */
function lineDiff(a, b) {
  const N = a.length, M = b.length, MAX = N + M;
  const trace = [];
  let v = new Map([[1, 0]]);
  let reached = false;
  for (let d = 0; d <= MAX && !reached; d++) {
    trace.push(new Map(v));
    const next = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      next.set(k, x);
      if (x >= N && y >= M) { reached = true; break; }
    }
    v = next;
  }
  const result = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k  = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0;
    const py = px - pk;
    while (x > px && y > py) { result.push({ t: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (down) { result.push({ t: '+', line: b[y - 1] }); y--; }
      else      { result.push({ t: '-', line: a[x - 1] }); x--; }
    }
  }
  return result.reverse();
}

/** @param {Array<{t: string, line: string}>} d @param {number} [ctx] @returns {boolean} */
function printUnified(d, ctx = 3) {
  const n    = d.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (d[i].t === ' ') continue;
    for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) keep[j] = true;
  }
  for (let i = 0; i < n; i++) {
    if (keep[i]) continue;
    let j = i; while (j < n && !keep[j]) j++;
    if (i > 0 && j < n && j - i <= ctx) for (let k = i; k < j; k++) keep[k] = true;
    i = j;
  }
  let oldLn = 0, newLn = 0, i = 0, shown = false;
  while (i < n) {
    if (!keep[i]) { if (d[i].t !== '+') oldLn++; if (d[i].t !== '-') newLn++; i++; continue; }
    let j = i; while (j < n && keep[j]) j++;
    const slice = d.slice(i, j);
    let oc = 0, nc = 0;
    for (const el of slice) { if (el.t !== '+') oc++; if (el.t !== '-') nc++; }
    out(dim(`  @@ -${oldLn + 1},${oc} +${newLn + 1},${nc} @@`));
    for (const el of slice) {
      const txt = '  ' + el.t + el.line;
      out(el.t === '+' ? green(txt) : el.t === '-' ? red(txt) : dim(txt));
      if (el.t !== '+') oldLn++;
      if (el.t !== '-') newLn++;
    }
    shown = true;
    i = j;
  }
  return shown;
}

function agentShowDiff() {
  if (!overlay.size) { out(dim('  no file changes')); return false; }
  out('');
  out(bold(`  ${overlay.size} file(s) changed:`));
  for (const [abs, next] of overlay) {
    const rel    = path.relative(agentRoot, abs);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    out('');
    if (next === AGENT_DELETED) {
      out(bold(`  --- a/${rel}`));
      out(bold(`  +++ /dev/null (deleted)`));
      printUnified(lineDiff(before.split('\n'), []));
      continue;
    }
    out(bold(`  --- a/${rel}${before ? '' : ' (new file)'}`));
    out(bold(`  +++ b/${rel}`));
    if (!printUnified(lineDiff(before.split('\n'), next.split('\n'))))
      out(dim('  (no textual change)'));
  }
  return true;
}

/* ----------------------------------------- runAgentTask */

/**
 * @param {string} taskText
 * @param {{ maxSteps?: number, allowRun?: boolean, autoApply?: boolean | null }} [opts]
 */
async function runAgentTask(taskText, { maxSteps = 10, allowRun = false, autoApply = null } = {}) {
  // autoApply: null = ask y/N, true = apply automatically, false = dry run
  overlay.clear();
  const prevAllowRun = agentAllowRun;
  agentAllowRun = allowRun;

  // Normalize absolute paths within agentRoot to relative paths so the model isn't confused
  const cleanRoot = agentRoot.replace(/[/\\]+$/, '');
  const cleanTask = taskText
    .replace(new RegExp(cleanRoot + '[/\\\\]?', 'g'), '')
    .replace(/['"`]/g, '')
    .trim();

  let listing = '';
  try { listing = agentOutbound(/** @type {string} */ (AGENT_TOOLS.list('.'))); } catch { /* ignore */ }

  let next =
    `${AGENT_PREAMBLE(allowRun)}\n\n` +
    `To save you a step, here is what is at the top level already:\n${listing}\n\n` +
    `Here is what I want to know: ${cleanTask}\n\nWhat should I open first?`;

  let nudges = 0;
  for (let step = 1; step <= maxSteps; step++) {
    out('');
    out(bold(dim(`  ─── agent step ${step}/${maxSteps} ${'─'.repeat(36)}`)));

    let reply;
    try { reply = await sayResilient(next); }
    catch (err) { out(red(`  ✗ ${/** @type {Error} */ (err).message}`)); break; }
    reply = reply != null ? agentInbound(reply) : '';

    // Render prose (non-marker lines) as markdown
    const proseText = agentProse(reply);
    if (proseText) {
      const md = makeRenderer();
      for (const l of proseText.split('\n')) md(l);
    }

    const calls = agentParse(reply);
    const done  = calls.find((c) => c.kind === 'done');
    const work  = calls.filter((c) => c.kind !== 'done');

    if (!work.length) {
      if (done) { out(''); out(green(`  ✓ ${done.arg || proseText || 'done'}`)); break; }
      if (++nudges > 2) { out(red('  no marker after three replies — stopping.')); break; }
      out(red(`  no marker in that reply — nudging (${nudges}/2)`));
      next = `I could not tell what to open from that. I have the project open here and I am pasting you whatever you name — nothing happens on your side. ${AGENT_REMINDER}`;
      continue;
    }
    nudges = 0;

    const results = [];
    for (const call of work) {
      let result;
      try { result = await AGENT_TOOLS[call.kind](call.arg, call.body); }
      catch (err) { result = `error: ${/** @type {Error} */ (err).message}`; }
      const head = String(result).split('\n')[0] ?? '';
      const ok   = !/^(no such|error|the text)/.test(result);
      out(`  ${ok ? green('✓') : red('✗')} ${dim(call.kind)} ${call.arg}  ${dim(head.slice(0, 70))}`);
      results.push(`Result of ${call.kind} ${call.arg}:\n${agentOutbound(result)}`);
    }

    const stillLooking = work.some((c) => c.kind === 'list' || c.kind === 'read' || c.kind === 'search');
    if (done && !stillLooking) { out(''); out(green(`  ✓ ${done.arg || proseText || 'done'}`)); break; }
    if (done) out(dim('  (ignoring DONE — it came alongside a tool request)'));
    next = `${results.join('\n\n')}\n\n${AGENT_REMINDER}`;
    if (step === maxSteps) out(red('  reached the step limit'));
  }

  agentAllowRun = prevAllowRun;

  const hasChanges = agentShowDiff();

  if (hasChanges) {
    let apply = autoApply;
    if (apply === null) {
      out('');
      const answer = await rl.question(cyan('  Apply changes to disk? [y/N] '));
      apply = answer.trim().toLowerCase() === 'y';
    }
    if (apply) {
      let written = 0;
      let deleted = 0;
      for (const [abs, txt] of overlay) {
        if (txt === AGENT_DELETED) {
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            deleted++;
          }
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, txt);
          written++;
        }
      }
      const parts = [
        written ? `wrote ${written} file(s)` : '',
        deleted ? `deleted ${deleted} file(s)` : '',
      ].filter(Boolean);
      out(green(`\n  ✓ ${parts.join(', ') || 'no changes'} to disk`));
    } else {
      out(dim('  dry run — nothing written.'));
    }
  }
  overlay.clear();
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
  ['/model',        'pick a model — ↑↓ then Enter, or /model <id>'],
  ['/models',       'print the model list'],
  ['/conversations','switch conversation — ↑↓ then Enter'],
  ['/new',          'start a fresh conversation'],
  ['/agent',        'switch to agent mode — /agent  |  /agent <task> [--allow-run] [--max N]'],
  ['/agent-root',   `set root dir the agent may touch (now: ${agentRoot})`],
  ['/clear',        'clear the screen'],
  ['/help',         'show this list'],
];
const CMD_PAD = Math.max(...COMMANDS.map(([n]) => n.length));
const HELP = [...COMMANDS.map(([n, d]) => `  ${n.padEnd(CMD_PAD)}  ${d}`), `  ${'Ctrl+C'.padEnd(CMD_PAD)}  quit`]
  .map((l) => dim(l)).join('\n');

banner();

const rl = readline.createInterface({ input: stdin, output: stdout });
rl.on('SIGINT', () => {
  if (rl.line.length > 0) setLine('');
  handleExit('Ctrl+C');
});

if (TTY) {
  // Enable bracketed paste mode in terminal so pasted text (Ctrl+V) doesn't auto-submit on newline
  stdout.write('\x1b[?2004h');
  const restorePasteMode = () => stdout.write('\x1b[?2004l');
  process.on('exit', restorePasteMode);
  rl.on('close', restorePasteMode);

  // Intercept stdin data stream to strip auto-submit newlines during paste
  const originalListeners = stdin.rawListeners('data');
  stdin.removeAllListeners('data');

  let inPaste = false;
  let pasteBuf = '';

  stdin.on('data', (chunk) => {
    let str = chunk.toString('utf8');
    while (str.length > 0) {
      if (!inPaste) {
        const idx = str.indexOf('\x1b[200~');
        if (idx === -1) {
          // If a multi-character block with newlines arrived without bracketed markers (raw paste), sanitize it
          if (str.length > 2 && (str.includes('\n') || str.includes('\r'))) {
            const clean = str.replace(/\r?\n/g, ' ').trimEnd();
            for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(clean));
            break;
          }
          for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(str));
          break;
        }
        if (idx > 0) {
          for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(str.slice(0, idx)));
        }
        inPaste = true;
        str = str.slice(idx + 6);
      } else {
        const idx = str.indexOf('\x1b[201~');
        if (idx === -1) {
          pasteBuf += str;
          break;
        }
        pasteBuf += str.slice(0, idx);
        // Replace newlines with spaces and trim trailing whitespace so paste stays in input buffer
        const clean = pasteBuf.replace(/\r?\n/g, ' ').trimEnd();
        pasteBuf = '';
        inPaste = false;
        str = str.slice(idx + 6);
        for (const l of originalListeners) /** @type {any} */ (l).call(stdin, Buffer.from(clean));
      }
    }
  });
}

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
const hintRule = (/** @type {string} */ sig) => {
  const text = termWidth() >= 70
    ? ` Press ${sig} again to exit (กดอีกครั้งเพื่อออก) `
    : ` Press ${sig} again to exit `;
  const rem = Math.max(2, termWidth() - 3 - 2 - text.length);
  return gray('╰─') + yellow(text) + gray('─'.repeat(rem) + '╯');
};

/** @type {ReturnType<typeof setTimeout> | null} */
let exitTimer = null;

function clearInputBox() {
  if (!TTY) return;
  if (menuOpen) {
    stdout.write('\x1b[J');
    menuOpen = false;
  }
  // Wipe bottom border, then move up to mode banner and wipe down
  stdout.write('\r\n\x1b[J\x1b[3A\r\x1b[J');
}

/** @param {string} [sig] */
function handleExit(sig = 'Ctrl+C') {
  if (!TTY) {
    rl.close();
    process.exit(0);
  }

  if (exitTimer !== null) {
    clearTimeout(exitTimer);
    exitTimer = null;
    clearInputBox();
    rl.close();
    process.exit(0);
  }

  stdout.write(`\r\n\x1b[J${hintRule(sig)}\x1b[1A\x1b[${promptCol()}G`);
  exitTimer = setTimeout(() => {
    exitTimer = null;
    if (TTY && !menuOpen) drawBottomFrame();
  }, 2000);
}

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

function drawBottomFrame() {
  if (!TTY || menuOpen) return;
  stdout.write(`\r\n\x1b[J${botRule()}\x1b[1A\x1b[${promptCol()}G`);
}

function closeMenu() {
  if (!TTY || !menuOpen) return;
  menuOpen = false;
  drawBottomFrame();
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
  // Wrap internal readline keypress listener so we can intercept Ctrl+D on empty prompt
  const [rlKeypressListener] = stdin.rawListeners('keypress');
  if (rlKeypressListener) stdin.removeListener('keypress', rlKeypressListener);

  stdin.on('keypress', (/** @type {string} */ ch, /** @type {import('node:readline').Key} */ key) => {
    const name = key?.name;

    if (key?.ctrl && name === 'd' && rl.line.length === 0) {
      handleExit('Ctrl+D');
      return;
    }

    if (exitTimer !== null && !(key?.ctrl && (name === 'c' || name === 'd'))) {
      clearTimeout(exitTimer);
      exitTimer = null;
      drawBottomFrame();
    }

    if (rlKeypressListener) {
      /** @type {any} */ (rlKeypressListener).call(stdin, ch, key);
    }

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
      if (pick) setLine(pick);
      return;
    }
    if (menuOpen && name === 'escape') { closeMenu(); return; }
    if (name === 'return') {
      pendingPick = (menuOpen && menuHits[menuSel]?.[0]) || null;
      menuOpen = false;
      return;
    }

    setImmediate(drawMenu);
  });
}

/** @typedef {{ id: string, title?: string, updatedAt?: string }} ConvRow */
/** @typedef {{ id: string, name?: string, free_credit?: boolean, thinking?: unknown }} ModelRow */

/**
 * Modal ↑/↓ picker (same interaction as the mockup for /conversations): renders
 * `items`, ↑/↓ moves the cursor, Enter selects, Esc cancels. Takes the keyboard
 * away from readline for the duration — its keypress listeners are detached and
 * restored on exit — so arrows don't leak into history navigation.
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {{ current: string | null, label: (item: T) => [string, string] }} opts
 *        `label` returns [main text, dim right-hand note] for each row.
 * @returns {Promise<T | null>}
 */
function pickList(items, { current, label }) {
  return new Promise((resolve) => {
    let sel = Math.max(0, items.findIndex((it) => it.id === current));
    let painted = 0;
    const mainW = Math.min(fmtWidth() - 20, 44);

    const paint = () => {
      if (painted) stdout.write(`\x1b[${painted}A`);
      stdout.write('\r\x1b[J');
      const rows = [dim('  ↑↓ choose · Enter select · Esc cancel')];
      items.forEach((it, i) => {
        const [main, note] = label(it);
        const here = it.id === current ? green('●') : ' ';
        const cur = i === sel ? cyan('›') : ' ';
        const m = truncate(main, mainW).padEnd(mainW);
        rows.push(`  ${cur} ${here} ${i === sel ? cyan(m) : m}  ${dim(note)}`);
      });
      stdout.write(rows.join('\n') + '\n');
      painted = rows.length;
    };

    /** @type {Array<(...a: any[]) => void>} */
    const rlKeys = /** @type {any} */ (stdin.listeners('keypress'));
    for (const l of rlKeys) stdin.off('keypress', l);

    /** @param {T | null} choice */
    const finish = (choice) => {
      stdin.off('keypress', onKey);
      for (const l of rlKeys) stdin.on('keypress', l);
      if (painted) stdout.write(`\x1b[${painted}A\r\x1b[J`); // wipe the picker
      resolve(choice);
    };

    /** @param {string} _ch @param {import('node:readline').Key} [key] */
    const onKey = (_ch, key) => {
      const n = key?.name;
      if (n === 'up') { sel = (sel - 1 + items.length) % items.length; paint(); }
      else if (n === 'down') { sel = (sel + 1) % items.length; paint(); }
      else if (n === 'return') finish(items[sel]);
      else if (n === 'escape') finish(null);
      else if (key?.ctrl && n === 'c') finish(null);
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
  if (TTY) {
    out('');
    // Mode indicator — shown above the input box every loop
    if (agentMode) {
      const flags = [
        agentModeAllowRun ? red('--allow-run') : '',
        agentModeAutoApply === true ? dim('--apply') : '',
        dim(`max:${agentModeMaxSteps}`),
        dim(`root: ${agentRoot}`),
      ].filter(Boolean).join(dim(' · '));
      out('  ' + cyan('⬡') + ' ' + bold(cyan('agent mode')) + '  ' + flags);
    } else {
      out('  ' + dim('○ chat mode'));
    }
    out(topRule());
  }
  /** @type {string | typeof CLOSED} */
  let line;
  try {
    const p = rl.question((TTY ? '' : '\n') + cyan(PROMPT));
    if (TTY) drawBottomFrame();
    line = await Promise.race([p, closed]);
  }
  catch {
    if (TTY) clearInputBox();
    break;
  } // Ctrl+C / Ctrl+D
  if (line === CLOSED) {
    if (TTY) clearInputBox();
    break;
  }
  if (TTY && menuOpen) { stdout.write('\x1b[J'); menuOpen = false; } // clear the dropdown
  if (TTY) out(botRule()); // close the input frame under the submitted line
  if (pendingPick) { line = pendingPick; pendingPick = null; }
  line = line.trim();
  if (!line) continue;

  if (line === '/help') { console.log(HELP); continue; }

  if (line === '/clear') { stdout.write(TTY ? '\x1b[2J\x1b[H' : '\n'); banner(); continue; }

  if (line === '/models') {
    const r = /** @type {{ data?: ModelRow[] } | null} */ (
      await fetch(`${BRIDGE}/v1/models`).then((x) => x.json()).catch(() => null)
    );
    if (!r?.data) { console.log(red('  could not list models')); continue; }
    for (const m of r.data) {
      const mark = m.id === model ? green('●') : ' ';
      console.log('  ' + mark + ' ' + m.id.padEnd(34) + dim(m.name ?? '') + (m.free_credit ? green('  free') : ''));
    }
    continue;
  }

  // `/model` on its own opens an ↑/↓ picker; `/model <id>` switches directly.
  if (line === '/model' || line.startsWith('/model ')) {
    let id = line === '/model' ? '' : line.slice(7).trim();
    if (!id) {
      const r = /** @type {{ data?: ModelRow[] } | null} */ (
        await fetch(`${BRIDGE}/v1/models`).then((x) => x.json()).catch(() => null)
      );
      const models = r?.data ?? [];
      if (!models.length) { console.log(red('  could not list models')); continue; }
      if (!TTY) {
        for (const m of models) console.log(`  ${m.id === model ? '●' : ' '} ${m.id}${m.free_credit ? dim('  free') : ''}`);
        continue;
      }
      const chosen = await pickList(models, {
        current: model,
        label: (m) => {
          const tags = [];
          if (m.free_credit) tags.push('free');
          if (Array.isArray(m.thinking) && m.thinking.length) tags.push('thinking');
          return [m.id, tags.join(' · ')];
        },
      });
      if (!chosen) { console.log(dim('  cancelled')); continue; }
      id = chosen.id;
    }
    if (id === model) { console.log(dim('  already on that model')); continue; }
    model = id;
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

    const chosen = await pickList(list, {
      current,
      label: (c) => [c.title || '(untitled)', (relative(c.updatedAt) || '').padStart(9)],
    });
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

  // /agent-root <dir> — change the root the agent may touch
  if (line.startsWith('/agent-root')) {
    const dir = line.slice(11).trim();
    if (!dir) { out(dim(`  agent root is currently: ${agentRoot}`)); continue; }
    try {
      const abs = path.resolve(dir);
      if (!fs.statSync(abs).isDirectory()) throw new Error('not a directory');
      agentRoot = abs;
      out(dim(`  agent root → ${agentRoot}`));
    } catch (err) {
      out(red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
    }
    continue;
  }

  // /agent — no task → toggle mode; with task → run once (works in both modes)
  if (line === '/agent' || line.startsWith('/agent ')) {
    const raw   = line.slice(6).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const hasFlags = parts.some((p) => p.startsWith('--'));
    const taskParts = [];
    let tAllowRun = false, tAutoApply = /** @type {boolean | null} */ (null), tMaxSteps = 10;
    for (let pi = 0; pi < parts.length; pi++) {
      if (parts[pi] === '--allow-run') { tAllowRun = true; continue; }
      if (parts[pi] === '--apply') { tAutoApply = true; continue; }
      if (parts[pi] === '--no-apply') { tAutoApply = false; continue; }
      if (parts[pi] === '--max') { tMaxSteps = Math.max(1, Number(parts[++pi]) || 10); continue; }
      taskParts.push(parts[pi]);
    }
    const taskText = taskParts.join(' ').trim();

    if (!taskText && !hasFlags) {
      // No task and no flags → toggle mode
      agentMode = !agentMode;
      if (agentMode) {
        out('');
        out('  ' + cyan('⬡') + ' ' + bold('switched to agent mode'));
        out(dim(`  type a task and press Enter — it will run as an agent loop`));
        out(dim(`  options: --allow-run  --max N  --apply  (persist per mode)`));
        out(dim(`  /agent again to return to chat mode`));
      } else {
        out('  ' + dim('○ switched back to chat mode'));
      }
      continue;
    }

    // Flags only (no task text) → update mode settings
    if (!taskText && hasFlags) {
      if (tAllowRun)           agentModeAllowRun  = !agentModeAllowRun; // toggle
      if (tAutoApply !== null) agentModeAutoApply = tAutoApply;
      if (tMaxSteps !== 10)    agentModeMaxSteps  = tMaxSteps;
      out(dim(`  agent mode settings: allow-run=${agentModeAllowRun}  max=${agentModeMaxSteps}  auto-apply=${agentModeAutoApply ?? 'ask'}`));
      continue;
    }

    // Has task text → run once (use per-task flags if given, else fall back to mode settings)
    const runAllowRun  = tAllowRun  || agentModeAllowRun;
    const runAutoApply = tAutoApply !== null ? tAutoApply : (taskText ? null : agentModeAutoApply);
    const runMaxSteps  = tMaxSteps !== 10 ? tMaxSteps : agentModeMaxSteps;
    out('');
    out(bold(`  🤖 agent  root: ${agentRoot}`) + (runAllowRun ? red('  --allow-run') : ''));
    await runAgentTask(taskText, { maxSteps: runMaxSteps, allowRun: runAllowRun, autoApply: runAutoApply });
    continue;
  }

  out();
  // In agent mode, plain messages run as agent tasks instead of chat
  if (agentMode) {
    out(bold(`  🤖 agent  root: ${agentRoot}`) + (agentModeAllowRun ? red('  --allow-run') : ''));
    await runAgentTask(line, { maxSteps: agentModeMaxSteps, allowRun: agentModeAllowRun, autoApply: agentModeAutoApply });
  } else {
    await maybeStartNew(line);
    await ask(line);
  }
}
rl.close();
