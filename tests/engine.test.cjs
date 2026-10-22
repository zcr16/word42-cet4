const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const E = require('../dist/engine.js');
const words = Array.from({length: 705}, (_, i) => ({id: `w${i}`, rank: i + 1, core: i < 700}));
const start = '2026-10-22';
const copy = value => JSON.parse(JSON.stringify(value));
function finish(state, date, source = words) {
  for (const item of E.getQueue(state, source, date)) state = E.grade(state, item.id, 'good', date);
  return state;
}

test('default foundation plan selects first 600 core, then selected extras, and skips known words', () => {
  const state = E.createState(start);
  assert.equal(state.planMode, 'foundation');
  assert.equal(E.getStats(state, words, start).total, 600);
  assert.equal(E.getQueue(state, words, start).length, 10);
  state.knownIds = ['w0']; state.extraIds = ['w650', 'w701'];
  assert.equal(E.getStats(state, words, start).total, 601);
  assert.equal(E.getQueue(state, words, start)[0].id, 'w1');
});

test('foundation limits change at day 6 and day 16; missed words stay available after day 35', () => {
  const state = E.createState(start);
  for (const [day, goal] of [[1, 10], [5, 10], [6, 15], [15, 15], [16, 20], [35, 20], [36, 20], [43, 20]]) {
    const date = E.addDays(start, day - 1);
    assert.equal(E.getStats(state, words, date).newGoal, goal);
    assert.equal(E.getQueue(state, words, date, 'new').length, goal);
  }
});

test('complete foundation plan learns exactly 600 words by day 35; days 36–42 contain reviews only', () => {
  let state = E.createState(start);
  for (let day = 1; day <= 42; day++) {
    const date = E.addDays(start, day - 1);
    if (day >= 36) assert.equal(E.getQueue(state, words, date, 'new').length, 0);
    state = finish(state, date);
    assert.equal(E.canCheckIn(state, words, date), true, `day ${day}`);
    state = E.checkIn(state, words, date);
    if (day === 35) assert.equal(E.getStats(state, words, date).learned, 600);
  }
  const stats = E.getStats(state, words, E.addDays(start, 41));
  assert.equal(stats.checkInDays, 42); assert.equal(stats.streak, 42);
  assert.ok(Object.values(state.records).some(record => record.due > E.addDays(start, 41)));
  assert.ok(E.getQueue(state, words, E.addDays(start, 75), 'review').length > 0);
  assert.deepEqual(E.validateImport(state, words), state);
});

test('explicit sprint mode retains the 700-word, 25-a-day compatibility plan', () => {
  let state = {...E.createState(start), planMode: 'sprint'};
  for (let day = 0; day < 28; day++) state = finish(state, E.addDays(start, day));
  assert.equal(E.getStats(state, words, E.addDays(start, 27)).learned, 700);
  assert.equal(E.getStats(state, words, E.addDays(start, 28)).newGoal, 0);
});

test('again reserves one new slot, remains in the queue, and blocks check-in until successful retrieval', () => {
  const small = words.slice(0, 2), original = E.createState(start);
  let state = E.grade(original, 'w0', 'again', start);
  assert.equal(Object.keys(original.records).length, 0);
  assert.equal(E.getStats(state, small, start).newStarted, 1);
  assert.equal(E.getStats(state, small, start).newDone, 0);
  assert.deepEqual(E.getQueue(state, small, start).map(x => x.id), ['w1', 'w0']);
  assert.equal(state.records.w0.due, E.addDays(start, 1));
  state = E.grade(state, 'w1', 'good', start);
  assert.equal(E.canCheckIn(state, small, start), false);
  state = E.grade(state, 'w0', 'good', start);
  assert.equal(E.canCheckIn(state, small, start), true);
  assert.equal(E.getStats(state, small, start).newDone, 2);
  assert.equal(state.daily[start].newIds.length, 2);
  assert.deepEqual(E.validateImport(state, words), state);
});

test('failed retry survives leaving the app and becomes due next day', () => {
  const state = E.grade(E.createState(start), 'w0', 'again', start);
  const restored = E.validateImport(JSON.stringify(state), words);
  assert.equal(E.getQueue(restored, words, start, 'new').at(-1).kind, 'retry');
  assert.equal(E.getQueue(restored, words, E.addDays(start, 1), 'review')[0].id, 'w0');
});

test('interval ladder follows successful later-day retrieval; duplicate same-day success does not advance it', () => {
  let date = start, state = E.grade(E.createState(start), 'w0', 'good', date);
  assert.equal(state.records.w0.due, E.addDays(date, 1));
  const once = state;
  assert.equal(E.grade(state, 'w0', 'good', date), once);
  for (const gap of [2, 4, 7, 15, 30, 30]) {
    date = state.records.w0.due;
    state = E.grade(state, 'w0', 'good', date);
    assert.equal(state.records.w0.due, E.addDays(date, gap));
    assert.equal(state.daily[date].reviewIds.length, 1);
  }
  assert.equal(E.getStats(state, words, date).mastered, 1);
});

test('hard shortens the interval; wrong quiz answers reopen same-day and future-due reviews without double advancement', () => {
  let state = E.grade(E.createState(start), 'w0', 'good', start);
  let date = state.records.w0.due;
  state = E.grade(state, 'w0', 'good', date);
  date = state.records.w0.due;
  state = E.grade(state, 'w0', 'hard', date);
  assert.equal(state.records.w0.stage, 1); assert.equal(state.records.w0.due, E.addDays(date, 1));
  state = E.grade(state, 'w0', 'again', date);
  assert.equal(E.getStats(state, words, date).retryRemaining, 1);
  state = E.grade(state, 'w0', 'good', date);
  assert.equal(state.records.w0.stage, 0);
  assert.equal(state.daily[date].reviewIds.length, 1);
});

test('marking started words known cannot expose new words beyond the daily grade quota', () => {
  let state = finish(E.createState(start), start);
  state.knownIds = ['w0', 'w1'];
  assert.equal(E.getQueue(state, words, start, 'new').length, 0);
  assert.equal(E.getStats(state, words, start).newGoal, 8);
  assert.equal(E.canCheckIn(state, words, start), true);
  assert.throws(() => E.grade(state, 'w20', 'good', start), /上限/);
});

test('missed days create a review backlog and continue with the next unseen word', () => {
  let state = finish(E.createState(start), start);
  const later = E.addDays(start, 40), queue = E.getQueue(state, words, later);
  assert.equal(queue.filter(x => x.kind === 'review').length, 10);
  assert.equal(queue.find(x => x.kind === 'new').id, 'w10');
  assert.equal(E.getStats(state, words, later).newGoal, 20);
  assert.equal(E.canCheckIn(state, words, later), false);
});

test('check-in requires due work, remains idempotent, and streak allows an unfinished current day', () => {
  const small = words.slice(0, 1);
  let state = finish(E.createState(start), start, small);
  state = E.checkIn(state, small, start);
  assert.equal(E.checkIn(state, small, start), state);
  const next = E.addDays(start, 1);
  assert.equal(E.getStats(state, small, next).streak, 1);
  assert.throws(() => E.checkIn(state, small, next), /复习/);
  state = finish(state, next, small); state = E.checkIn(state, small, next);
  assert.equal(E.getStats(state, small, next).streak, 2);
  assert.equal(E.getStats(state, small, E.addDays(start, 3)).streak, 0);
});

test('calendar arithmetic handles leap days, month boundaries, and DST without UTC-date shifts', () => {
  assert.equal(E.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(E.addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => E.dateKey('2026-02-29'));
  assert.throws(() => E.dateKey('2026-13-01'));
  const enginePath = path.resolve(__dirname, '../dist/engine.js');
  const source = `const E=require(${JSON.stringify(enginePath)});process.stdout.write(JSON.stringify([E.dateKey(new Date(2026,2,8,23,30)),E.addDays('2026-03-08',1),E.dayNumber(E.createState('2026-03-07'),'2026-03-09')]))`;
  for (const TZ of ['America/New_York', 'Asia/Shanghai']) {
    const output = execFileSync(process.execPath, ['-e', source], {env: {...process.env, TZ}, encoding: 'utf8'});
    assert.deepEqual(JSON.parse(output), ['2026-03-08', '2026-03-09', 3]);
  }
});

test('clock rollback blocks grading and check-in; correcting plan date preserves valid historical quotas', () => {
  let state = finish(E.createState(start), E.addDays(start, 15));
  assert.equal(state.daily[E.addDays(start, 15)].newIds.length, 20);
  assert.equal(E.getStats(state, words, start).clockWarning, true);
  assert.throws(() => E.grade(state, 'w25', 'good', start), /日期/);
  assert.equal(E.canCheckIn(state, words, start), false);
  state.startDate = E.addDays(start, 15);
  assert.equal(E.validateImport(state, words).daily[state.startDate].newIds.length, 20);
});

test('import rejects malformed dates, ids, stages, counters, prototype keys, and inconsistent history', () => {
  const valid = E.grade(E.createState(start), 'w0', 'good', start);
  for (const change of [
    s => s.startDate = '2026-02-30', s => s.knownIds = ['missing'], s => s.favoriteIds = ['w0', 'w0'],
    s => s.records.w0.stage = 99, s => s.records.w0.attempts = -1, s => s.sequence++,
    s => s.records.w0.due = start, s => s.records.w0.learned = false,
    s => s.daily[start].newIds = [], s => s.extraField = '<script>',
    s => s.planMode = 'unknown', s => s.daily[start].reviewIds = ['w0']
  ]) { const damaged = copy(valid); change(damaged); assert.throws(() => E.validateImport(damaged, words)); }
  const proto = JSON.parse(JSON.stringify(valid));
  Object.defineProperty(proto.records, '__proto__', {value: {}, enumerable: true});
  assert.throws(() => E.validateImport(proto, words));
  assert.equal({}.polluted, undefined);
});

