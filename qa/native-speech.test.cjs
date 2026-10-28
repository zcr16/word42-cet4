'use strict';

// Runs the real ArkTS service/bridge after TypeScript transpilation. The only
// replacements are the OS speech engine, WebviewController and clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.WORD42_TYPESCRIPT_PATH || 'typescript');
const project = path.resolve(__dirname, '..');
const native = path.join(project, 'harmonyos/entry/src/main/ets/speech');
const copy = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

class Clock {
  now = 0;
  sequence = 0;
  jobs = new Map();
  set = (fn, delay) => { const id = ++this.sequence; this.jobs.set(id, { fn, at: this.now + delay }); return id; };
  clear = id => this.jobs.delete(id);
  advance(ms) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.jobs.delete(next[0]); next[1].fn();
    }
    this.now = until;
  }
}

class Engine {
  calls = [];
  listeners = [];
  stops = 0;
  shutdowns = 0;
  setListener(listener) { this.listener = listener; this.listeners.push(listener); }
  speak(text, params) { this.calls.push({ text, params: copy(params) }); }
  stop() { this.stops++; }
  shutdown() { this.shutdowns++; }
  get id() { return this.calls.at(-1).params.requestId; }
  start() { this.listener.onStart(this.id, {}); }
  complete(type = 1) { this.listener.onComplete(this.id, { type, message: '' }); }
}

class DownloadHandle {
  handlers = new Map();
  on(type, handler) { this.handlers.set(type, handler); }
  off(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
  emit(type, value) { this.handlers.get(type)?.(value); }
}

function load(file, dependencies, clock) {
  const source = fs.readFileSync(path.join(native, file), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file.replace(/\.ets$/, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, 'transpile diagnostics: ' + errors.map(d => d.messageText).join('; '));
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console,
    setTimeout: clock.set, clearTimeout: clock.clear,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected platform dependency: ' + name);
      return dependencies[name];
    }
  };
  vm.runInNewContext(result.outputText, sandbox, { filename: file });
  return module.exports;
}

function setup(options = {}) {
  const clock = new Clock(), events = [], engines = [], queries = [], creates = [], logs = [], downloads = [];
  const voices = options.voices || [{ language: 'en-US', person: 8, status: 'INSTALLED' }];
  const sdk = {
    listVoices(params) { queries.push(copy(params)); return options.list ? options.list(params) : Promise.resolve(voices); },
    createEngine(params) {
      creates.push(copy(params));
      if (options.create) return options.create(params);
      const engine = new Engine(); engines.push(engine); return Promise.resolve(engine);
    },
    downloadVoice(params, callback) {
      const handle = new DownloadHandle(); downloads.push({ params: copy(params), handle });
      if (options.download) return options.download(params, callback, handle);
      callback(undefined, handle);
    }
  };
  const module = load('EnglishSpeechService.ets', {
    '@kit.CoreSpeechKit': { textToSpeech: sdk },
    '@kit.PerformanceAnalysisKit': { hilog: { info(domain, tag, format, event, state) {
      assert.equal(domain, 0); assert.equal(tag, 'Word42Speech');
      logs.push({ event, state: JSON.parse(state) });
    } } }
  }, clock);
  const service = module.EnglishSpeechService.shared;
  const handler = (id, status, message) => events.push([id, status, message]);
  service.attach(handler); service.setDocumentReady(handler, true);
  return { clock, events, engines, queries, creates, logs, downloads, voices, service, handler, module,
    speak(id = 'sentence-1', text = 'Hello, world.', rate = 1) { service.speak(handler, id, text, rate); } };
}

test('uses an installed offline English voice; only real playback start/end drive UI, and natural sentences reuse engine', async () => {
  const e = setup(); e.speak('first', ' Hello, world. ', .75); await settle();
  const engine = e.engines[0];
  assert.deepEqual(e.events, []);
  assert.equal(e.queries[0].online, 1); assert.equal(e.queries[0].extraParams.language, 'en-US');
  assert.deepEqual(e.creates[0], { language: 'en-US', person: 8, online: 1, extraParams: { name: 'Word42English', isBackStage: false } });
  assert.equal(engine.calls[0].text, 'Hello, world.');
  assert.equal(engine.calls[0].params.extraParams.speed, .75);
  assert.equal(engine.calls[0].params.extraParams.playType, 1);
  assert.match(engine.id, /^[A-Za-z0-9]+$/);
  engine.start(); engine.start();
  assert.deepEqual(e.events, [['first', 'start', '']]);
  engine.complete(0); assert.equal(e.events.length, 1);
  engine.complete(1); assert.deepEqual(e.events.at(-1), ['first', 'end', '']);
  e.speak('second', 'Next sentence.'); await settle();
  assert.equal(e.creates.length, 1); assert.equal(engine.calls.length, 2);
  assert.equal(engine.shutdowns, 0);
  engine.start(); engine.complete(1); assert.equal(e.clock.jobs.size, 0);
});

for (const action of ['stop', 'background', 'hide', 'navigate', 'detach', 'shutdown']) {
  test(`cancels a pending voice query on ${action} without creating/playing later`, async () => {
    const query = deferred(), e = setup({ list: () => query.promise });
    e.speak();
    if (action === 'stop') e.service.stop(e.handler);
    if (action === 'background') e.service.setForeground(false);
    if (action === 'hide') e.service.setPageVisible(e.handler, false);
    if (action === 'navigate') e.service.setDocumentReady(e.handler, false);
    if (action === 'detach') e.service.detach(e.handler);
    if (action === 'shutdown') e.service.shutdown();
    assert.deepEqual(e.events, [['sentence-1', 'end', 'stopped']]);
    query.resolve([{ language: 'en-US', person: 8, status: 'INSTALLED' }]); await settle();
    assert.equal(e.creates.length, 0); assert.equal(e.clock.jobs.size, 0);
    e.clock.advance(20000); assert.equal(e.events.length, 1);
  });
}

for (const action of ['stop', 'background', 'timeout']) {
  test(`releases an engine that arrives after ${action}; never starts stale text`, async () => {
    const creation = deferred(), engine = new Engine(), e = setup({ create: () => creation.promise });
    e.speak(); await settle(); assert.equal(e.creates.length, 1);
    if (action === 'stop') e.service.stop(e.handler);
    if (action === 'background') e.service.setForeground(false);
    if (action === 'timeout') e.clock.advance(8000);
    creation.resolve(engine); await settle();
    assert.equal(engine.shutdowns, 1); assert.equal(engine.calls.length, 0);
    assert.equal(e.events.length, 1); assert.equal(e.events[0][1], action === 'timeout' ? 'error' : 'end');
    assert.equal(e.clock.jobs.size, 0);
  });
}

test('old listeners and old native IDs cannot finish or error a replacement with the same client ID', async () => {
  const e = setup(); e.speak('same'); await settle();
  const engine = e.engines[0], oldId = engine.id, oldListener = engine.listener;
  e.speak('same', 'Replacement sentence.'); await settle();
  assert.notEqual(engine.id, oldId);
  const before = e.events.length;
  oldListener.onStart(oldId, {}); oldListener.onComplete(oldId, { type: 1 }); oldListener.onError(oldId, 401, 'stale');
  engine.listener.onStart(oldId, {}); engine.listener.onComplete(oldId, { type: 1 });
  assert.equal(e.events.length, before);
  engine.start(); engine.complete(1);
  assert.deepEqual(e.events.slice(-2), [['same', 'start', ''], ['same', 'end', '']]);
});

test('a destroyed old page cannot detach or stop the new page listener', async () => {
  const e = setup(), secondEvents = [], second = (...args) => secondEvents.push(args);
  e.speak('old'); await settle(); const oldEngine = e.engines[0];
  e.service.attach(second); e.service.setDocumentReady(second, true);
  e.service.speak(second, 'new', 'New page.', 1); await settle();
  e.service.detach(e.handler); e.service.stop(e.handler); e.service.setPageVisible(e.handler, false);
  e.service.setDocumentReady(e.handler, false);
  const newEngine = e.engines[1]; newEngine.start(); newEngine.complete(1);
  assert.equal(oldEngine.shutdowns, 1); assert.equal(newEngine.shutdowns, 0);
  assert.deepEqual(secondEvents, [['new', 'start', ''], ['new', 'end', '']]);
});

for (const voices of [[], [{ language: 'en-US', person: 8, status: 'EOM' }], [{ language: 'zh-CN', person: 13, status: 'INSTALLED' }]]) {
  test(`missing installed English voice reports a real error, no fake start or download (${JSON.stringify(voices)})`, async () => {
    const e = setup({ voices }); e.speak(); await settle();
    assert.equal(e.creates.length, 0); assert.equal(e.events.length, 1);
    assert.equal(e.events[0][1], 'error'); assert.match(e.events[0][2], /系统.*英语.*语音/);
    assert.equal(e.clock.jobs.size, 0);
  });
}

test('voice query failure and createEngine failure each terminate once with error', async () => {
  for (const options of [{ list: () => Promise.reject(new Error('query failed')) }, { create: () => Promise.reject(new Error('create failed')) }]) {
    const e = setup(options); e.speak(); await settle();
    assert.equal(e.events.length, 1); assert.equal(e.events[0][1], 'error');
    assert.equal(e.clock.jobs.size, 0); e.clock.advance(12000); assert.equal(e.events.length, 1);
  }
});

test('8 second query/start watchdog errors and disposes ready engine without pretending playback started', async () => {
  const query = deferred(), waiting = setup({ list: () => query.promise }); waiting.speak();
  waiting.clock.advance(7999); assert.equal(waiting.events.length, 0);
  waiting.clock.advance(1); assert.equal(waiting.events[0][1], 'error');
  query.resolve([{ language: 'en-US', person: 8, status: 'INSTALLED' }]); await settle();
  assert.equal(waiting.creates.length, 0);
  const ready = setup(); ready.speak(); await settle(); const engine = ready.engines[0];
  ready.clock.advance(8000); assert.equal(ready.events[0][1], 'error'); assert.equal(engine.shutdowns, 1);
  engine.start(); engine.complete(1); assert.equal(ready.events.length, 1);
});

test('engine runtime error stops and releases it; malformed requests never reach SDK', async () => {
  const e = setup();
  for (const id of ['', 'a'.repeat(81), 'x;alert(1)', 42, null]) e.speak(id);
  assert.equal(e.events.length, 0);
  for (const [text, rate] of [['', 1], ['   ', 1], ['a'.repeat(2001), 1], [null, 1], ['ok', .59], ['ok', 1.21], ['ok', NaN], ['ok', Infinity], ['ok', '1']]) e.speak('valid-id', text, rate);
  assert.equal(e.events.length, 9); assert.ok(e.events.every(event => event[1] === 'error'));
  assert.equal(e.queries.length, 0); assert.equal(e.clock.jobs.size, 0);
  e.speak('valid-id', 'A'.repeat(2000), .6); await settle(); const engine = e.engines[0];
  engine.listener.onError(engine.id, 1002300005, 'private SDK error details');
  assert.equal(engine.shutdowns, 1); assert.equal(e.events.at(-1)[1], 'error');
  assert.ok(!e.events.at(-1)[2].includes('private SDK'));
});

test('explicit stop terminates the real web adapter queue; stale completion never reads the next sentence', async () => {
  const { createController } = require(path.join(project, 'dist/speech.js'));
  const e = setup(), changes = [];
  const env = { setTimeout: e.clock.set, clearTimeout: e.clock.clear };
  const handler = (...args) => env.__word42SpeechEvent(...args);
  e.service.attach(handler); e.service.setDocumentReady(handler, true);
  env.Word42Speech = { speak: (...args) => e.service.speak(handler, ...args), stop: () => e.service.stop(handler) };
  const controller = createController(env);
  controller.play([{ id: 1, text: 'First sentence.' }, { id: 2, text: 'Second sentence.' }], { onChange: value => changes.push(value.status) });
  await settle(); const engine = e.engines[0]; engine.start(); controller.stop();
  engine.complete(1); await settle();
  assert.equal(engine.calls.length, 1); assert.equal(engine.shutdowns, 1);
  assert.equal(controller.isActive(), false); assert.deepEqual(changes, ['loading', 'start', 'stop']);
  assert.equal(e.clock.jobs.size, 0);
});

test('real web adapter naturally advances sentences on one engine', async () => {
  const { createController } = require(path.join(project, 'dist/speech.js'));
  const e = setup(), changes = [], env = { setTimeout: e.clock.set, clearTimeout: e.clock.clear };
  const handler = (...args) => env.__word42SpeechEvent(...args);
  e.service.attach(handler); e.service.setDocumentReady(handler, true);
  env.Word42Speech = { speak: (...args) => e.service.speak(handler, ...args), stop: () => e.service.stop(handler) };
  const controller = createController(env);
  controller.play([{ id: 1, text: 'First sentence.' }, { id: 2, text: 'Second sentence.' }], { onChange: value => changes.push(value.status) });
  await settle(); const engine = e.engines[0]; engine.start(); engine.complete(0);
  assert.equal(engine.calls.length, 1); engine.complete(1); await settle();
  assert.equal(engine.calls.length, 2); assert.equal(e.creates.length, 1);
  engine.start(); engine.complete(1);
  assert.equal(controller.isActive(), false); assert.equal(engine.shutdowns, 0);
  assert.deepEqual(changes, ['loading', 'start', 'end', 'loading', 'start', 'end', 'complete']);
  assert.equal(e.clock.jobs.size, 0);
});

test('bridge emits executable JSON safely and restricts native calls to the attached packaged page', async () => {
  const e = setup(), deliveries = [], scripts = [];
  const page = vm.createContext({ window: { __word42SpeechEvent: (...args) => deliveries.push(args), WORD42_NATIVE: true,
    Word42Speech: { speak() {}, stop() {} } }, document: { readyState: 'complete' } });
  let url = 'resource://rawfile/index.html';
  const controller = { getUrl: () => url, runJavaScript(script) { scripts.push(script); return Promise.resolve(vm.runInContext(script, page)); } };
  const { SpeechBridge } = load('SpeechBridge.ets', { './EnglishSpeechService': e.module }, e.clock);
  const bridge = new SpeechBridge(controller); bridge.attach(); bridge.pageReady(url);
  assert.equal(bridge.forwardConsole('[Word42Speech] mode=native'), true);
  assert.equal(bridge.forwardConsole('[Word42Speech] error=native_error'), true);
  assert.equal(bridge.forwardConsole('[Word42Speech] error=PRIVATE_NOTE'), false);
  assert.equal(bridge.forwardConsole('PRIVATE_NOTE'), false);
  // A hostile-looking future OS message must remain data, even with line separators.
  const malicious = '\");globalThis.compromised=true;//\n\u2028\u2029</script>';
  e.service.handler('safe-id', 'error', malicious);
  assert.deepEqual(deliveries, [['safe-id', 'error', malicious]]);
  assert.equal(page.compromised, undefined);
  assert.ok(!scripts.at(-1).includes('\u2028')); assert.ok(!scripts.at(-1).includes('\u2029'));
  for (const bad of ['https://example.com/index.html', 'file:///index.html', 'resource://rawfile/other.html', 'resource://rawfile/index.html/evil', 'javascript:alert(1)']) {
    url = bad; bridge.speak('ignored', 'Should not speak.', 1); e.service.handler('safe-id', 'start', '');
  }
  assert.equal(e.queries.length, 1, 'the only query is the one read-only startup probe'); assert.equal(deliveries.length, 1);
  url = 'resource://rawfile/index.html#writing'; bridge.pageReady(url);
  bridge.speak('allowed', 'Hello.', 1); await settle(); assert.equal(e.engines[0].calls.length, 1);
  bridge.detach(); bridge.speak('ignored', 'No longer attached.', 1); assert.equal(e.engines[0].shutdowns, 1);
  assert.ok(e.logs.some(log => log.event === 'bridge.probe' && log.state.speakFunction && log.state.callback));
  assert.ok(!JSON.stringify(e.logs).includes('PRIVATE_NOTE'));
});

test('bridge tolerates synchronous and asynchronous dispatch failure during destruction', async () => {
  for (const asyncFailure of [false, true]) {
    const e = setup();
    const controller = { getUrl: () => 'resource://rawfile/index.html', runJavaScript() {
      if (asyncFailure) return Promise.reject(new Error('detached'));
      throw new Error('detached');
    } };
    const { SpeechBridge } = load('SpeechBridge.ets', { './EnglishSpeechService': e.module }, e.clock);
    const bridge = new SpeechBridge(controller); bridge.attach(); bridge.pageReady(controller.getUrl());
    assert.doesNotThrow(() => e.service.handler('safe', 'end', 'stopped'));
    await settle(); bridge.detach();
  }
});

test('diagnostic voice query runs once without creating a speaker, and never changes an active request', async () => {
  const pending = deferred(); let calls = 0;
  const e = setup({ list: () => ++calls === 1 ? pending.promise : Promise.resolve([{ language: 'en-US', person: 8, status: 'INSTALLED' }]) });
  e.service.probeEnglishVoices(); e.service.probeEnglishVoices(); assert.equal(e.queries.length, 1);
  e.speak('actual', 'Real sentence.'); await settle(); const engine = e.engines[0]; engine.start();
  pending.resolve([{ language: 'en-US', person: 8, status: 'GA' }]); await settle();
  assert.deepEqual(e.events, [['actual', 'start', '']]); assert.equal(e.creates.length, 1);
  engine.complete(); assert.deepEqual(e.events.at(-1), ['actual', 'end', '']);
  assert.ok(e.logs.some(log => log.event === 'probe.list_voices.done' && !log.state.englishInstalled));
});

test('diagnostics retain SDK codes but exclude learning text, IDs, exception messages, remote URLs and query/hash', async () => {
  const e = setup({ list: () => Promise.reject({ code: 1002300002, message: 'PRIVATE_SDK_CONTENT' }) });
  e.speak('PRIVATE_REQUEST_ID', 'PRIVATE_LEARNING_CONTENT'); await settle();
  assert.match(e.events[0][2], /1002300002/);
  const { SpeechBridge } = load('SpeechBridge.ets', { './EnglishSpeechService': e.module }, e.clock);
  const controller = { getUrl: () => 'https://PRIVATE_REMOTE_HOST/path?PRIVATE_REMOTE_QUERY', runJavaScript: () => Promise.resolve('') };
  const bridge = new SpeechBridge(controller); bridge.attach(); bridge.pageLoading('resource://rawfile/index.html?PRIVATE_QUERY#PRIVATE_NOTE');
  bridge.pageReady(controller.getUrl());
  const output = JSON.stringify(e.logs);
  for (const value of ['PRIVATE_SDK_CONTENT', 'PRIVATE_REQUEST_ID', 'PRIVATE_LEARNING_CONTENT', 'PRIVATE_REMOTE_HOST', 'PRIVATE_REMOTE_QUERY', 'PRIVATE_QUERY', 'PRIVATE_NOTE']) {
    assert.ok(!output.includes(value), 'diagnostic leak: ' + value);
  }
  assert.ok(e.logs.some(log => log.event === 'sdk.exception' && log.state.code === 1002300002));
});

function downloadableVoice() {
  return { language: 'en_US', person: 8, status: 'GA', style: 'interaction-broadcast' };
}

test('GA English voice prepares on demand, pauses the 8s start timer, then verifies installation and speaks', async () => {
  const voice = downloadableVoice(), e = setup({ voices: [voice] });
  e.speak('downloaded', 'Hello after preparation.'); await settle();
  assert.equal(e.downloads.length, 1); assert.equal(e.creates.length, 0);
  assert.deepEqual(e.events.map(x => x[1]), ['preparing']);
  assert.deepEqual(e.downloads[0].params, { requestId: e.downloads[0].params.requestId,
    language: voice.language, person: voice.person, style: voice.style });
  e.clock.advance(9000); assert.equal(e.events.length, 1);
  voice.status = 'INSTALLED'; e.downloads[0].handle.emit('complete', voice); await settle();
  assert.equal(e.queries.length, 2); assert.equal(e.creates.length, 1);
  assert.equal(e.engines[0].calls[0].text, 'Hello after preparation.');
  assert.equal(e.downloads[0].handle.handlers.size, 0);
  e.engines[0].start(); e.engines[0].complete();
  assert.deepEqual(e.events.map(x => x[1]), ['preparing', 'start', 'end']);
  assert.equal(e.clock.jobs.size, 0);
});

test('repeated clicks share one OS download and only the newest request speaks afterwards', async () => {
  const voice = downloadableVoice(), e = setup({ voices: [voice] });
  e.speak('first', 'Old sentence.'); await settle();
  e.speak('second', 'Latest sentence.'); await settle();
  assert.equal(e.downloads.length, 1); assert.equal(e.creates.length, 0);
  voice.status = 'INSTALLED'; e.downloads[0].handle.emit('complete', voice); await settle();
  assert.equal(e.creates.length, 1); assert.equal(e.engines[0].calls.length, 1);
  assert.equal(e.engines[0].calls[0].text, 'Latest sentence.');
  e.engines[0].start(); e.engines[0].complete();
  assert.deepEqual(e.events.map(([id, status]) => [id, status]), [
    ['first', 'preparing'], ['first', 'end'], ['second', 'preparing'], ['second', 'start'], ['second', 'end']
  ]);
});

for (const operation of ['stop', 'background', 'shutdown']) {
  test(`download completion after ${operation} never plays and listeners are eventually removed`, async () => {
    const voice = downloadableVoice(), e = setup({ voices: [voice] });
    e.speak(); await settle(); const handle = e.downloads[0].handle;
    const lateComplete = handle.handlers.get('complete');
    if (operation === 'stop') e.service.stop(e.handler);
    if (operation === 'background') e.service.setForeground(false);
    if (operation === 'shutdown') e.service.shutdown();
    voice.status = 'INSTALLED'; lateComplete(voice); await settle();
    assert.equal(e.creates.length, 0); assert.equal(handle.handlers.size, 0);
    assert.deepEqual(e.events.map(x => x[1]), ['preparing', 'end']);
    assert.equal(e.clock.jobs.size, 0);
  });
}

test('stop then replay while preparation continues reuses the same download', async () => {
  const voice = downloadableVoice(), e = setup({ voices: [voice] });
  e.speak('old'); await settle(); e.service.stop(e.handler);
  e.speak('new'); await settle(); assert.equal(e.downloads.length, 1);
  voice.status = 'INSTALLED'; e.downloads[0].handle.emit('complete', voice); await settle();
  assert.equal(e.creates.length, 1); e.engines[0].start(); e.engines[0].complete();
  assert.deepEqual(e.events.at(-1), ['new', 'end', '']);
});

for (const outcome of ['cancel', 'error', 'timeout']) {
  test(`OS download ${outcome} reports one terminal error, cleans listeners and never plays late`, async () => {
    const voice = downloadableVoice(), e = setup({ voices: [voice] });
    e.speak(); await settle(); const handle = e.downloads[0].handle, lateComplete = handle.handlers.get('complete');
    if (outcome === 'cancel') handle.emit('cancel', 'PRIVATE_CANCEL_MESSAGE');
    if (outcome === 'error') handle.emit('error', { code: 1002300008, message: 'PRIVATE_ERROR_MESSAGE' });
    if (outcome === 'timeout') { e.clock.advance(179999); assert.equal(e.events.length, 1); e.clock.advance(1); }
    await settle();
    assert.deepEqual(e.events.map(x => x[1]), ['preparing', 'error']);
    if (outcome === 'cancel') assert.match(e.events.at(-1)[2], /取消/);
    if (outcome === 'error') assert.match(e.events.at(-1)[2], /1002300008/);
    if (outcome === 'timeout') assert.match(e.events.at(-1)[2], /超时/);
    assert.equal(handle.handlers.size, 0); assert.equal(e.clock.jobs.size, 0);
    voice.status = 'INSTALLED'; lateComplete(voice); await settle();
    assert.equal(e.creates.length, 0); assert.equal(e.events.length, 2);
    assert.ok(!JSON.stringify(e.logs).includes('PRIVATE_'));
  });
}

test('download callback failure and a callback arriving after shutdown are handled without leaking listeners', async () => {
  const e = setup({ voices: [downloadableVoice()], download: (_params, callback) => callback({ code: 1002300008 }) });
  e.speak(); await settle();
  assert.deepEqual(e.events.map(x => x[1]), ['preparing', 'error']); assert.equal(e.clock.jobs.size, 0);
  let responseCallback;
  const waiting = setup({ voices: [downloadableVoice()], download: (_params, callback) => { responseCallback = callback; } });
  waiting.speak(); await settle(); waiting.service.shutdown(); await settle();
  const handle = new DownloadHandle(); responseCallback(undefined, handle); await settle();
  assert.equal(handle.handlers.size, 0); assert.equal(waiting.creates.length, 0); assert.equal(waiting.clock.jobs.size, 0);
});

for (const installed of [true, false]) {
  test(`already downloaded SDK code 1002300010 requires an INSTALLED recheck (${installed})`, async () => {
    const voice = downloadableVoice();
    const e = setup({ voices: [voice], download: (_params, callback) => {
      if (installed) voice.status = 'INSTALLED';
      callback({ code: 1002300010 });
    } });
    e.speak(); await settle();
    assert.equal(e.downloads.length, 1); assert.equal(e.queries.length, 2);
    assert.equal(e.creates.length, installed ? 1 : 0);
    if (installed) { e.engines[0].start(); e.engines[0].complete(); }
    else assert.equal(e.events.at(-1)[1], 'error');
  });
}

test('GA voice with missing style or invalid person errors 401 without guessing download parameters', async () => {
  for (const voice of [
    { language: 'en_US', person: 8, status: 'GA' },
    { language: 'en_US', person: 8, status: 'GA', style: '' },
    { language: 'en_US', person: NaN, status: 'GA', style: 'interaction-broadcast' }
  ]) {
    const e = setup({ voices: [voice] }); e.speak(); await settle();
    assert.equal(e.downloads.length, 0); assert.equal(e.creates.length, 0);
    assert.equal(e.events.at(-1)[1], 'error'); assert.match(e.events.at(-1)[2], /401/);
  }
});

test('read-only startup diagnosis of a GA voice never starts a download', async () => {
  const e = setup({ voices: [downloadableVoice()] });
  e.service.probeEnglishVoices(); await settle();
  assert.equal(e.downloads.length, 0); assert.equal(e.creates.length, 0); assert.equal(e.events.length, 0);
});

test('page capability probe accepts ArkWeb double-encoded JSON without misreporting all capabilities absent', async () => {
  for (const doubleEncoded of [false, true]) {
    const e = setup();
    const page = vm.createContext({ window: { Word42Speech: { speak() {}, stop() {} }, WORD42_NATIVE: true,
      __word42SpeechEvent() {} }, document: { readyState: 'complete' } });
    const controller = { getUrl: () => 'resource://rawfile/index.html', runJavaScript(script) {
      const value = vm.runInContext(script, page); return Promise.resolve(doubleEncoded ? JSON.stringify(value) : value);
    } };
    const { SpeechBridge } = load('SpeechBridge.ets', { './EnglishSpeechService': e.module }, e.clock);
    const bridge = new SpeechBridge(controller); bridge.attach(); bridge.pageReady(controller.getUrl()); await settle();
    const probe = e.logs.find(log => log.event === 'bridge.probe');
    assert.ok(probe); assert.ok(probe.state.proxyObject && probe.state.speakFunction && probe.state.stopFunction);
    assert.ok(probe.state.native && probe.state.callback && probe.state.documentComplete);
  }
});
