'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Engine = require('../dist/engine.js');
const context = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/data/vocabulary.js'), 'utf8'), context);
const words = context.window.WORDS;
const start = '2026-10-22';

function finishToday(state, date) {
  for (const item of Engine.getQueue(state, words, date)) state = Engine.grade(state, item.id, 'good', date);
  return state;
}

test('a foundation gap is learned immediately within the existing ten-word quota', () => {
  let state = Engine.createState(start);
  state.extraIds = ['accept'];
  const queue = Engine.getQueue(state, words, start, 'new');
  assert.equal(queue.length, 10);
  assert.equal(queue[0].id, 'accept');
  state = finishToday(state, start);
  assert.equal(state.records.accept.learned, true);
  assert.equal(state.daily[start].newIds.length, 10);
  assert.equal(Engine.getStats(state, words, start).newRemaining, 0);
  assert.equal(Engine.canCheckIn(state, words, start), true);
});

test('due reviews remain ahead of newly added foundation gaps', () => {
  let state = Engine.createState(start);
  state = Engine.grade(state, 'case', 'good', start);
  state.extraIds = ['accept'];
  const queue = Engine.getQueue(state, words, Engine.addDays(start, 1));
  assert.equal(queue[0].id, 'case');
  assert.equal(queue[0].kind, 'review');
  assert.equal(queue.find(item => item.kind === 'new').id, 'accept');
});

test('ordinary extra words do not displace the 600 primary words', () => {
  const extra = words.find(word => !word.base && !word.core);
  let state = Engine.createState(start);
  state.extraIds = [extra.id];
  for (let day = 0; day < 35; day++) {
    const date = Engine.addDays(start, day);
    assert.equal(Engine.getQueue(state, words, date, 'new').some(item => item.id === extra.id), false);
    state = finishToday(state, date);
  }
  assert.equal(Engine.getStats(state, words, Engine.addDays(start, 34)).learned, 600);
  assert.equal(Engine.getQueue(state, words, Engine.addDays(start, 35), 'new')[0].id, extra.id);
});

test('foundation gaps extend the plan without raising the daily workload', () => {
  let state = Engine.createState(start);
  state.extraIds = ['accept', 'achieve', 'allow'];
  for (let day = 0; day < 35; day++) {
    const date = Engine.addDays(start, day);
    state = finishToday(state, date);
    const limit = day < 5 ? 10 : day < 15 ? 15 : 20;
    assert.equal(state.daily[date].newIds.length, limit);
  }
  assert.equal(Engine.getStats(state, words, Engine.addDays(start, 34)).learned, 600);
  assert.equal(Engine.getStats(state, words, Engine.addDays(start, 34)).total, 603);
  assert.equal(Engine.getQueue(state, words, Engine.addDays(start, 35), 'new').length, 3);
  assert.equal(Engine.validateImport(JSON.parse(JSON.stringify(state)), words).records.accept.learned, true);
});

test('a known foundation word remains skipped until explicitly restored', () => {
  const state = Engine.createState(start);
  state.extraIds = ['accept'];
  state.knownIds = ['accept'];
  assert.equal(Engine.getQueue(state, words, start).some(item => item.id === 'accept'), false);
  state.knownIds = [];
  assert.equal(Engine.getQueue(state, words, start)[0].id, 'accept');
});

test('the review button can complete every retry counted in its badge, including new words', () => {
  let state = Engine.createState(start);
  state = Engine.grade(state, 'case', 'again', start);
  assert.equal(Engine.getStats(state, words, start).dueRemaining, 1);
  const review = Engine.getQueue(state, words, start, 'review');
  assert.equal(review.length, 1);
  assert.equal(review[0].id, 'case');
  assert.equal(review[0].kind, 'retry');
  assert.equal(Engine.getQueue(state, words, start, 'new').some(item => item.id === 'case'), true);
  assert.equal(Engine.getQueue(state, words, start, 'all').filter(item => item.id === 'case').length, 1);
  state = Engine.grade(state, review[0].id, 'good', start);
  assert.equal(Engine.getStats(state, words, start).dueRemaining, 0);
  assert.equal(state.daily[start].newIds.length, 1);
  assert.equal(state.records.case.learned, true);
});
