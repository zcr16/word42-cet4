'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { splitSentences, createController } = require('../dist/speech.js');

function harness({ native = true, voices = [{ lang: 'en-US', name: 'Test English' }] } = {}) {
  const calls = [], events = [], logs = [], timers = new Map(), listeners = {}, documentListeners = {}, voiceListeners = new Set();let timer = 0;
  const env = {
    console: { info(message) { logs.push(message); } },
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms });return timer; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { listeners[name] = fn; },
    document: { visibilityState: 'visible', addEventListener(name, fn) { documentListeners[name] = fn; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      getVoices: () => voices,
      speak(utterance) { calls.push({ method: 'browserSpeak', utterance }); },
      cancel() { calls.push({ method: 'browserStop' }); },
      addEventListener(name, fn) { if (name === 'voiceschanged') voiceListeners.add(fn); },
      removeEventListener(name, fn) { voiceListeners.delete(fn); }
    }
  };
  if (native) env.Word42Speech = { speak(id, text, rate) { calls.push({ method: 'speak', id, text, rate }); }, stop() { calls.push({ method: 'stop' }); } };
  const controller = createController(env);
  return { env, controller, calls, events, logs, timers,
    play(texts, rate = 1) { controller.play(texts.map((text, id) => ({ id, text })), { rate, onChange: event => events.push(event) }); },
    signal(id, status, message) { env.__word42SpeechEvent(id, status, message); },
    expire(ms) { for (const [id, item] of [...timers]) if (item.ms <= ms) { timers.delete(id);item.fn(); } },
    voicesChanged() { for (const fn of [...voiceListeners]) fn(); },
    hide() { env.document.visibilityState = 'hidden';documentListeners.visibilitychange(); },
    pagehide() { listeners.pagehide(); }
  };
}

test('sentence splitting preserves abbreviations, initials, decimals, quotes and every whitespace character', () => {
  const input = 'Dr. Smith and Mr. A. Jones paid $3.14.  The U.S. team won!\nTry tools, e.g. a pen. "Ready?" Yes!';
  assert.deepEqual(splitSentences(input), ['Dr. Smith and Mr. A. Jones paid $3.14.  ', 'The U.S. team won!\n', 'Try tools, e.g. a pen. ', '"Ready?" ', 'Yes!']);
  assert.equal(splitSentences(input).join(''), input);
  assert.deepEqual(splitSentences('Meet at 5 p.m. We can talk.'), ['Meet at 5 p.m. ', 'We can talk.']);
  assert.deepEqual(splitSentences(''), []);
});

test('all 42 essays retain exactly their original paragraph text and translation data', () => {
  const context = { window: {} };vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/data/essays.js'), 'utf8'), context);
  const essays = context.window.ESSAYS;assert.equal(essays.length, 42);
  for (const essay of essays) for (const paragraph of essay.essay) {
    const parts = splitSentences(paragraph);assert.equal(parts.join(''), paragraph);assert.ok(parts.every(text => text.trim()));
  }
});

test('native bridge is preferred, uses bounded IDs/rates and ignores callbacks after switching sentences', () => {
  const h = harness();h.play([' First sentence. '], 0.75);
  const first = h.calls[0];assert.equal(first.method, 'speak');assert.equal(first.rate, 0.75);assert.equal(first.text, 'First sentence.');assert.match(first.id, /^[A-Za-z0-9_-]{1,80}$/);
  h.signal(first.id, 'start');h.play(['Second sentence.']);const second = h.calls.findLast(c => c.method === 'speak');
  assert.equal(h.calls.filter(c => c.method === 'stop').length, 1);
  const count = h.events.length;h.signal(first.id, 'end');h.signal(first.id, 'error', 'late failure');h.signal(first.id, 'start');assert.equal(h.events.length, count);
  h.signal(second.id, 'start');h.signal(second.id, 'end');assert.equal(h.events.at(-1).status, 'complete');assert.equal(h.controller.isActive(), false);
  assert.equal(h.calls.some(c => c.method === 'browserSpeak'), false);
});

test('whole-essay queue advances only on the current completion; native stopped never starts the next sentence', () => {
  const h = harness();h.play(['One.', 'Two.', 'Three.']);const first = h.calls[0];
  h.signal(first.id, 'start');h.signal(first.id, 'end');const second = h.calls.findLast(c => c.method === 'speak');assert.equal(second.text, 'Two.');
  h.signal(first.id, 'end');assert.equal(h.calls.filter(c => c.method === 'speak').length, 2);
  h.signal(second.id, 'end', 'stopped');assert.equal(h.controller.isActive(), false);assert.equal(h.events.at(-1).status, 'stop');assert.equal(h.calls.filter(c => c.method === 'speak').length, 2);
});

test('explicit stop, background and pagehide cancel native playback without late queue continuation', () => {
  for (const action of ['stop', 'hide', 'pagehide']) {
    const h = harness();h.play(['One.', 'Two.']);const request = h.calls[0];
    if (action === 'stop') h.controller.stop();else h[action]();
    h.signal(request.id, 'end');h.signal(request.id, 'start');assert.equal(h.calls.filter(c => c.method === 'speak').length, 1);assert.equal(h.controller.isActive(), false);assert.equal(h.timers.size, 0);
  }
});

test('browser fallback selects an English voice and ignores cancelled utterance events', () => {
  const h = harness({ native: false });h.play(['One.'], 0.75);const first = h.calls.find(c => c.method === 'browserSpeak').utterance;
  assert.equal(first.lang, 'en-US');assert.equal(first.rate, 0.75);first.onstart();h.play(['Two.']);const count = h.events.length;first.onend();first.onerror();assert.equal(h.events.length, count);
  const second = h.calls.findLast(c => c.method === 'browserSpeak').utterance;second.onstart();second.onend();assert.equal(h.events.at(-1).status, 'complete');
});

test('missing English voices give an explicit error instead of speaking with an unrelated default voice', () => {
  for (const voices of [[], [{ lang: 'zh-CN', name: 'Chinese only' }]]) {
    const h = harness({ native: false, voices });h.play(['English.']);h.expire(1500);
    assert.equal(h.events.at(-1).status, 'error');assert.match(h.events.at(-1).message, /英语声音/);assert.equal(h.calls.filter(c => c.method === 'browserSpeak').length, 0);assert.equal(h.controller.isActive(), false);
  }
});

test('voices loaded later can start; stopping before voices load never starts cancelled speech', () => {
  const voices = [], h = harness({ native: false, voices });h.play(['English.']);voices.push({ lang: 'en-GB', name: 'English' });h.voicesChanged();assert.equal(h.calls.filter(c => c.method === 'browserSpeak').length, 1);
  const delayed = [], cancelled = harness({ native: false, voices: delayed });cancelled.play(['No late sound.']);cancelled.controller.stop();delayed.push({ lang: 'en-US' });cancelled.voicesChanged();cancelled.expire(1500);assert.equal(cancelled.calls.filter(c => c.method === 'browserSpeak').length, 0);
});

test('native error or missing start callback terminates the queue and shows a recoverable message', () => {
  const h = harness();h.play(['One.', 'Two.']);h.signal(h.calls[0].id, 'error', '英语引擎不可用');assert.equal(h.events.at(-1).message, '英语引擎不可用');assert.equal(h.controller.isActive(), false);
  h.play(['Retry.']);h.expire(12000);assert.equal(h.events.at(-1).status, 'error');assert.match(h.events.at(-1).message, /启动超时/);assert.equal(h.controller.isActive(), false);
});

test('speech diagnostics contain only fixed mode/status/error labels, never spoken text or raw errors', () => {
  const h = harness();h.play(['Synthetic private lesson https://invalid.example/note']);
  h.signal(h.calls[0].id, 'start');h.signal(h.calls[0].id, 'error', 'Synthetic private error and note https://invalid.example/error');
  assert.deepEqual(h.logs, ['[Word42Speech] mode=native','[Word42Speech] signal=start','[Word42Speech] signal=error','[Word42Speech] error=native_error']);
  const b = harness({ native: false, voices: [] });b.play(['Another synthetic lesson.']);b.expire(1500);
  assert.deepEqual(b.logs, ['[Word42Speech] mode=browser','[Word42Speech] error=english_voice_missing']);
  assert.doesNotMatch([...h.logs,...b.logs].join('\n'), /Synthetic|lesson|note|https:|word42-/);
});

test('preparing resources replaces the 12-second start timeout and allows real start/end later', () => {
  const h = harness();h.play(['One.']);const request = h.calls[0];
  h.signal(request.id, 'preparing', '正在准备英语声音资源。');h.expire(12000);
  assert.equal(h.controller.isActive(), true);assert.equal(h.events.at(-1).status, 'preparing');assert.equal(h.events.at(-1).message, '正在准备英语声音资源。');
  assert.equal([...h.timers.values()].some(timer => timer.ms === 300000), true);
  const preparationTimer = [...h.timers.keys()][0];h.signal(request.id, 'preparing', '仍在准备英语声音资源。');assert.equal([...h.timers.keys()][0], preparationTimer, 'progress events must not reset the five-minute limit');
  assert.equal(h.events.some(event => event.status === 'start'), false);
  h.signal(request.id, 'start');const startedEvents = h.events.length;h.signal(request.id, 'preparing', '迟到的准备状态');assert.equal(h.events.length, startedEvents);h.signal(request.id, 'end');
  assert.equal(h.events.at(-1).status, 'complete');assert.equal(h.timers.size, 0);
});

test('stopping or replacing resource preparation rejects its late preparing/start/end callbacks', () => {
  const h = harness();h.play(['One.', 'Two.']);const request = h.calls[0];h.signal(request.id, 'preparing', '正在准备。');h.controller.stop();
  const count = h.events.length;h.signal(request.id, 'preparing', '迟到的准备');h.signal(request.id, 'start');h.signal(request.id, 'end');assert.equal(h.events.length, count);assert.equal(h.calls.filter(c => c.method === 'speak').length, 1);assert.equal(h.timers.size, 0);
  h.play(['Replacement.']);const replacement = h.calls.findLast(c => c.method === 'speak');h.signal(request.id, 'preparing', '迟到的准备');h.signal(replacement.id, 'start');h.signal(replacement.id, 'end');assert.equal(h.events.at(-1).status, 'complete');
});

test('resource preparation has a five-minute limit and cannot continue after timeout', () => {
  const h = harness();h.play(['One.', 'Two.']);const request = h.calls[0];h.signal(request.id, 'preparing', '正在准备。');h.expire(300000);
  assert.equal(h.controller.isActive(), false);assert.equal(h.events.at(-1).status, 'error');assert.match(h.events.at(-1).message, /准备超时/);
  h.signal(request.id, 'start');h.signal(request.id, 'end');assert.equal(h.calls.filter(c => c.method === 'speak').length, 1);
});
