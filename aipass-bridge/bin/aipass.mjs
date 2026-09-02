#!/usr/bin/env node
// aipass — one command for the bridge, the chat client, and the file agent.
// Zero dependencies; every subcommand just spawns one of the sibling *.mjs
// files. `aipass` on its own starts the bridge in the background if it isn't
// already up, then opens the chat.
//
//   aipass                 open the chat TUI
//   aipass "question"      one-shot
//   aipass dev             run the bridge in the foreground (Ctrl+C to stop)
//   aipass agent "task"    run the file agent against the current directory
//   aipass models          list models
//   aipass conversations   list conversations
//   aipass status          check node / bridge / extension
//   aipass stop            stop a bridge that `aipass` started
//
//   env: AIPASS_PORT (8787), AIPASS_HOST (127.0.0.1)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const sibling = (name) => join(HERE, '..', name);          // aipass-bridge/<name>
const HOST = process.env.AIPASS_HOST || '127.0.0.1';
const PORT = process.env.AIPASS_PORT || '8787';
const BRIDGE = `http://${HOST}:${PORT}`;
const STATE = join(homedir(), '.aipass');
const PIDFILE = join(STATE, 'bridge.pid');
const LOGFILE = join(STATE, 'bridge.log');

const tty = Boolean(process.stdout.isTTY);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : String(s));
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : String(s));

const [cmd, ...rest] = process.argv.slice(2);

/** Run one of the sibling CLIs, inheriting stdio so the TUI works. */
const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [sibling(file), ...args], { stdio: 'inherit', ...opts });
    c.on('close', (code) => resolve(code ?? 0));
  });

const bridgeUp = () =>
  fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);

/** Start the bridge detached and wait for it to answer. No-op if it's up. */
async function ensureBridge() {
  if (await bridgeUp()) return;
  mkdirSync(STATE, { recursive: true });
  const fd = openSync(LOGFILE, 'a');
  const child = spawn(process.execPath, [sibling('bridge/server.mjs')], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,   // no console flash on Windows
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  if (child.pid) writeFileSync(PIDFILE, String(child.pid));
  process.stderr.write(dim(`  started the bridge (pid ${child.pid}) — logs: ${LOGFILE}\n`));
  for (let i = 0; i < 40; i++) {
    if (await bridgeUp()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stderr.write(red(`  the bridge did not come up within 4s — check ${LOGFILE}\n`));
}

function stopBridge() {
  if (!existsSync(PIDFILE)) {
    console.log('no bridge to stop (aipass has not started one; a `npm run dev` / `aipass dev` bridge you stop with Ctrl+C)');
    return;
  }
  const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
  try { process.kill(pid); console.log(`stopped the bridge (pid ${pid})`); }
  catch { console.log(`bridge pid ${pid} was not running`); }
  rmSync(PIDFILE, { force: true });
}

async function status() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`node          ${process.versions.node}${major >= 18 ? '' : red('  ✗ need >= 18')}`);

  const up = await bridgeUp();
  console.log(`bridge        ${up ? `${BRIDGE}  ok` : `${BRIDGE}  ${red('not reachable')} — run \`aipass\` (auto-starts it) or \`aipass dev\``}`);
  if (!up) return;

  const s = await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null);
  const ext = s && typeof s.extensions === 'number' ? s.extensions : 0;
  console.log(`extension     ${ext ? `${ext} connected` : red('0') + ' — load aipass-bridge/extension in Chrome and open a https://de.aipass.net/chat tab'}`);
  console.log(`model         ${s?.defaultModel ?? '?'}`);
  console.log(`conversation  ${s?.conversation ?? dim('(resolves on first message)')}`);
  console.log(`active jobs   ${s?.activeJobs ?? 0}`);
}

const HELP = `aipass — de.aipass.net from your terminal

  aipass                 open the chat (starts the bridge if needed)
  aipass "question"      one-shot
  aipass dev             run the bridge in the foreground
  aipass agent "task"    run the file agent against the current directory
  aipass models          list models
  aipass conversations   list conversations
  aipass status          check node / bridge / extension
  aipass stop            stop a bridge that aipass started

  env: AIPASS_PORT (${PORT}), AIPASS_HOST (${HOST})`;

switch (cmd) {
  case undefined:
  case 'chat':
    await ensureBridge();
    process.exit(await run('chat.mjs', ['--bridge', BRIDGE, ...rest]));
    break;

  case 'dev':
    process.exit(await run('bridge/server.mjs', rest));
    break;

  case 'agent':
    await ensureBridge();
    // agent.mjs already defaults --root to the current directory.
    process.exit(await run('agent.mjs', [...rest, '--bridge', BRIDGE]));
    break;

  case 'models':
  case 'conversations':
    await ensureBridge();
    process.exit(await run('list.mjs', [cmd], { env: { ...process.env, AIPASS_BRIDGE: BRIDGE } }));
    break;

  case 'status':
    await status();
    process.exit(0);
    break;

  case 'stop':
    stopBridge();
    process.exit(0);
    break;

  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    process.exit(0);
    break;

  default:
    // Anything else is treated as a one-shot question.
    await ensureBridge();
    process.exit(await run('chat.mjs', ['--bridge', BRIDGE, cmd, ...rest]));
}
