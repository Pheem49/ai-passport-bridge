import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startBridge, FakeExtension, scripted, run, CHAT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const chat = (args) => run(CHAT, [...args, '--bridge', bridge.base]);

test('one-shot prints the answer', async (t) => {
  const handler = scripted(['สวัสดีครับ ยินดีช่วยเหลือ']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out, code } = await chat(['สวัสดี']);
  assert.equal(code, 0);
  assert.match(out, /ยินดีช่วยเหลือ/);
  assert.equal(handler.sent.at(-1), 'สวัสดี', 'the prompt goes through untouched');
});

test('shows tool progress and sources alongside the answer', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => {
      await e.status('[web_search] {"query":"aipass"}');
      await e.text('AiPASS is a platform.');
      await e.status('sources:\n  - Aipass https://aipass.go.th/');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await chat(['what is aipass']);
  assert.match(out, /\[web_search\]/);
  assert.match(out, /AiPASS is a platform\./);
  assert.match(out, /aipass\.go\.th/);
});

test('honours an explicit model', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await chat(['hi', '--model', 'claude-sonnet-5@default']);
  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
});

test('exits with a clear message when no extension is attached', async () => {
  const { out, code } = await chat(['hi']);
  assert.equal(code, 1);
  assert.match(out, /extension is not connected/);
});

test('exits with a clear message when the bridge is down', async () => {
  const { out, code } = await run(CHAT, ['hi', '--bridge', 'http://127.0.0.1:1']);
  assert.equal(code, 1);
  assert.match(out, /No bridge at/);
});

test('sends image part when --image is provided', async (t) => {
  /** @type {any} */
  let receivedParts = null;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      receivedParts = job.parts;
      await e.text('I see an image');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const imgPath = path.resolve(import.meta.dirname, '../../public/image.png');
  const { out, code } = await chat(['describe this image', '--image', imgPath]);
  assert.equal(code, 0);
  assert.match(out, /I see an image/);
  assert.ok(receivedParts, 'bridge should receive parts');
  const imgPart = receivedParts.find((/** @type {any} */ p) => p.type === 'image');
  assert.ok(imgPart, 'parts should contain an image part');
  assert.match(imgPart.image, /^data:image\/png;base64,/);
});

test('auto-detects and attaches inline image file path in chat prompt', async (t) => {
  /** @type {any} */
  let receivedParts = null;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      receivedParts = job.parts;
      await e.text('Analyzed inline image');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const imgPath = path.resolve(import.meta.dirname, '../../public/image.png');
  const { out, code } = await chat([`describe ${imgPath}`]);
  assert.equal(code, 0);
  assert.match(out, /Analyzed inline image/);
  assert.ok(receivedParts, 'bridge should receive parts');
  const imgPart = receivedParts.find((/** @type {any} */ p) => p.type === 'image');
  assert.ok(imgPart, 'inline image path should be attached as image part');
  assert.match(imgPart.image, /^data:image\/png;base64,/);
});

test('handles aborted stream without crashing', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      await e.text('First chunk...');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const { out, code } = await chat(['quick test']);
  assert.equal(code, 0);
  assert.match(out, /First chunk/);
});

test('sends document part when --file is provided', async (t) => {
  /** @type {any} */
  let receivedParts = null;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      receivedParts = job.parts;
      await e.text('Analyzed document');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const docPath = path.resolve(import.meta.dirname, '../README.md');
  const { out, code } = await chat(['summarise this readme', '--file', docPath]);
  assert.equal(code, 0);
  assert.match(out, /Analyzed document/);
  assert.ok(receivedParts, 'bridge should receive parts');
  const filePart = receivedParts.find((/** @type {any} */ p) => p.type === 'file');
  assert.ok(filePart, 'parts should contain a file part');
  assert.equal(filePart.filename, 'README.md');
  assert.equal(filePart.mediaType, 'text/markdown');
  assert.match(filePart.data, /^data:text\/markdown;base64,/);
});

test('forwards thinking level when --thinking is provided', async (t) => {
  /** @type {any} */
  let receivedThinking = null;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      receivedThinking = job.thinkingLevel;
      await e.text('Reasoned answer');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const { out, code } = await chat(['deep thought', '--thinking', 'high']);
  assert.equal(code, 0);
  assert.match(out, /Reasoned answer/);
  assert.equal(receivedThinking, 'high');
});
