/* 词序42 scheduling engine. Local calendar dates; deterministic, immutable updates. */
(function (root, factory) {
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  if (root) root.Engine = engine;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const DAY = 86400000, LIMIT = 25, INTERVALS = [1, 2, 4, 7, 15, 30];
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const clone = value => JSON.parse(JSON.stringify(value));
  function calendar(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw Error('日期须为 YYYY-MM-DD。');
    const [y, m, d] = key.split('-').map(Number), date = new Date(0);
    date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0);
    if (y < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw Error('日期无效。');
    return date;
  }
  function dateKey(value = new Date()) {
    if (typeof value === 'string') { calendar(value); return value; }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error('日期无效。');
    const key = [String(value.getFullYear()).padStart(4, '0'), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    calendar(key); return key;
  }
  function addDays(key, days) {
    if (!Number.isSafeInteger(days)) throw Error('日期间隔须为整数。');
    const date = calendar(key); date.setUTCDate(date.getUTCDate() + days);
    const result = date.toISOString().slice(0, 10); calendar(result); return result;
  }
  function createState(today = dateKey()) {
    return {version: 1, planMode: 'foundation', startDate: dateKey(today), records: {}, daily: {}, knownIds: [], favoriteIds: [], extraIds: [], sequence: 0};
  }
  function dayNumber(state, today = dateKey()) { return Math.round((calendar(dateKey(today)) - calendar(state.startDate)) / DAY) + 1; }
  function dailyLimit(state, today) {
    if (state.planMode === 'sprint') return LIMIT;
    const day = dayNumber(state, today); return day <= 5 ? 10 : day <= 15 ? 15 : 20;
  }
  function eligible(state, words) {
    const extras = new Set(state.extraIds), known = new Set(state.knownIds);
    const core = words.filter(w => w.core !== false).sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    const selected = new Set((state.planMode === 'sprint' ? core : core.slice(0, 600)).map(w => String(w.id)));
    // A gap found by the foundation check should be repaired before new sprint
    // vocabulary. Keep the existing daily quota; ordinary extras still follow it.
    const priority = word => extras.has(String(word.id)) && word.base === true ? 0 : selected.has(String(word.id)) ? 1 : 2;
    return words.filter(w => (selected.has(String(w.id)) || extras.has(String(w.id))) && !known.has(String(w.id)))
      .sort((a, b) => priority(a) - priority(b) || (Number(a.rank) || 0) - (Number(b.rank) || 0));
  }
  function dailyAt(state, date) { return state.daily[date] || {newIds: [], reviewIds: [], checkedIn: false}; }
  function clockWarning(state, today) { return today < state.startDate || Object.keys(state.daily).some(date => date > today); }
  function assertClock(state, today) { if (clockWarning(state, today)) throw Error('设备日期早于计划或已有学习记录，请先校正日期。'); }
  function getQueue(state, words, today = dateKey(), mode = 'all') {
    today = dateKey(today);
    if (!['all', 'new', 'review'].includes(mode)) throw Error('未知学习模式。');
    const list = eligible(state, words), daily = dailyAt(state, today);
    const slots = Math.max(0, dailyLimit(state, today) - daily.newIds.length);
    const due = [], retry = [], fresh = [];
    for (const word of list) {
      const id = String(word.id), record = has(state.records, id) ? state.records[id] : null;
      if (!record) { if (fresh.length < slots) fresh.push({id, kind: 'new'}); }
      else if (record.retryDate === today) retry.push({id, kind: 'retry', source: record.introduced === today ? 'new' : 'review'});
      else if (record.due <= today && record.lastSuccess !== today) due.push({id, kind: 'review'});
    }
    due.sort((a, b) => state.records[a.id].due.localeCompare(state.records[b.id].due) || state.records[a.id].order - state.records[b.id].order);
    retry.sort((a, b) => state.records[a.id].order - state.records[b.id].order);
    return [...due, ...fresh, ...retry].filter(item => mode === 'all' || item.kind === mode || item.kind === 'retry' && (mode === 'review' || item.source === mode));
  }
  function getStats(state, words, today = dateKey()) {
    today = dateKey(today);
    const active = eligible(state, words), ids = new Set(active.map(w => String(w.id))), daily = dailyAt(state, today);
    const started = daily.newIds.filter(id => ids.has(id)), remaining = active.filter(w => !has(state.records, String(w.id))).length;
    const limit = dailyLimit(state, today), newGoal = started.length + Math.min(remaining, Math.max(0, limit - daily.newIds.length));
    const newDone = started.filter(id => state.records[id]?.learned).length;
    const queue = getQueue(state, words, today), reviewDue = queue.filter(item => item.kind === 'review').length;
    const retryRemaining = queue.filter(item => item.kind === 'retry').length, reviewDone = daily.reviewIds.filter(id => ids.has(id)).length;
    const checks = Object.keys(state.daily).filter(date => date <= today && state.daily[date].checkedIn);
    let cursor = daily.checkedIn ? today : addDays(today, -1), streak = 0;
    while (state.daily[cursor]?.checkedIn) { streak++; cursor = addDays(cursor, -1); }
    const records = active.map(w => state.records[String(w.id)]).filter(Boolean), day = dayNumber(state, today);
    return {day, phase: day <= (state.planMode === 'sprint' ? 28 : 35) ? 'learning' : day <= 42 ? 'review' : 'continue', total: active.length, activeTotal: active.length,
      learned: records.filter(r => r.learned).length, mastered: records.filter(r => r.learned && r.stage >= 4).length,
      knownCount: state.knownIds.length, newGoal, newStarted: started.length, newDone, newRemaining: Math.max(0, newGoal - newDone), dailyLimit: limit,
      reviewDone, reviewDue, retryRemaining, dueRemaining: reviewDue + retryRemaining,
      reviewGoal: reviewDone + reviewDue + queue.filter(item => item.kind === 'retry' && item.source === 'review' && !daily.reviewIds.includes(item.id)).length,
      checkInDays: checks.length, checkedIn: daily.checkedIn, streak, clockWarning: clockWarning(state, today), backlogWarning: reviewDue > 60};
  }
  function safeId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[\u0000-\u001f]/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
  }
  function grade(state, id, rating, today = dateKey()) {
    today = dateKey(today); id = String(id); assertClock(state, today);
    if (!safeId(id)) throw Error('词条标识无效。');
    if (!['again', 'hard', 'good'].includes(rating)) throw Error('未知记忆反馈。');
    if (state.knownIds.includes(id)) throw Error('此词已标记熟悉，请先恢复学习。');
    const old = has(state.records, id) ? state.records[id] : null;
    if (old && rating !== 'again' && old.retryDate !== today) {
      if (old.lastSuccess === today) return state;
      if (old.due > today) throw Error('这个词尚未到复习日期。');
    }
    if (!old && dailyAt(state, today).newIds.length >= dailyLimit(state, today)) throw Error('今天已达到新词上限，请先完成复习。');
    const next = clone(state), daily = next.daily[today] || (next.daily[today] = {newIds: [], reviewIds: [], checkedIn: false});
    const record = old ? next.records[id] : {introduced: today, lastReview: today, due: addDays(today, 1), stage: 0, attempts: 0, lapses: 0, learned: false, retryDate: null, lastSuccess: null, order: 0};
    if (!old) { next.records[id] = record; daily.newIds.push(id); }
    record.attempts++; record.lastReview = today; record.order = ++next.sequence;
    if (rating === 'again') {
      record.lapses++; record.stage = 0; record.due = addDays(today, 1); record.retryDate = today;
    } else {
      // Only a scheduled retrieval on a later day advances the interval ladder.
      if (record.learned && record.lastSuccess !== today && rating === 'good' && record.retryDate !== today) record.stage = Math.min(record.stage + 1, INTERVALS.length - 1);
      const gap = rating === 'hard' ? Math.max(1, Math.floor(INTERVALS[record.stage] / 2)) : INTERVALS[record.stage];
      record.due = addDays(today, gap); record.learned = true; record.lastSuccess = today; record.retryDate = null;
      if (record.introduced !== today && !daily.reviewIds.includes(id)) daily.reviewIds.push(id);
    }
    return next;
  }
  function canCheckIn(state, words, today = dateKey()) {
    const s = getStats(state, words, today); return !s.clockWarning && s.newRemaining === 0 && s.dueRemaining === 0;
  }
  function checkIn(state, words, today = dateKey()) {
    today = dateKey(today); assertClock(state, today);
    if (!canCheckIn(state, words, today)) throw Error('请先完成今日新词、到期复习和重试。');
    if (state.daily[today]?.checkedIn) return state;
    const next = clone(state), daily = next.daily[today] || (next.daily[today] = {newIds: [], reviewIds: [], checkedIn: false});
    daily.checkedIn = true; return next;
  }
  function validateImport(raw, words) {
    if (typeof raw === 'string') { if (raw.length > 5 * 1024 * 1024) throw Error('备份超过大小限制。'); raw = JSON.parse(raw); }
    const fail = () => { throw Error('备份数据格式无效或与当前词库不符。'); };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(); };
    const int = (value, min, max = 1000000000) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); };
    const date = value => { try { calendar(value); } catch (_) { fail(); } };
    const valid = new Set(words.map(word => String(word.id)));
    const ids = value => { if (!Array.isArray(value) || value.length > valid.size || new Set(value).size !== value.length || value.some(id => !safeId(id) || !valid.has(id))) fail(); };
    keys(raw, ['version', 'planMode', 'startDate', 'records', 'daily', 'knownIds', 'favoriteIds', 'extraIds', 'sequence']);
    if (raw.version !== 1) fail(); date(raw.startDate); int(raw.sequence, 0);
    if (raw.planMode !== undefined && !['foundation', 'sprint'].includes(raw.planMode)) fail();
    ids(raw.knownIds); ids(raw.favoriteIds); ids(raw.extraIds);
    if (!object(raw.records) || !object(raw.daily) || Object.keys(raw.records).length > valid.size || Object.keys(raw.daily).length > 20000) fail();
    let attempts = 0; const orders = new Set();
    for (const [id, r] of Object.entries(raw.records)) {
      if (!safeId(id) || !valid.has(id)) fail();
      keys(r, ['introduced', 'lastReview', 'due', 'stage', 'attempts', 'lapses', 'learned', 'retryDate', 'lastSuccess', 'order']);
      date(r.introduced); date(r.lastReview); date(r.due); int(r.stage, 0, 5); int(r.attempts, 1); int(r.lapses, 0, r.attempts); int(r.order, 1, raw.sequence);
      if (typeof r.learned !== 'boolean' || r.introduced > r.lastReview || r.due <= r.lastReview || orders.has(r.order)) fail();
      if (r.lastSuccess !== null) date(r.lastSuccess);
      if (r.retryDate !== null) date(r.retryDate);
      if (r.learned !== (r.lastSuccess !== null) || r.lastSuccess && (r.lastSuccess < r.introduced || r.lastSuccess > r.lastReview)) fail();
      if (!r.learned && r.stage !== 0 || r.retryDate !== null && (r.retryDate !== r.lastReview || r.due !== addDays(r.lastReview, 1) || r.stage !== 0)) fail();
      if (!r.learned && r.retryDate === null || !raw.daily[r.introduced]?.newIds?.includes(id) || !has(raw.daily, r.lastReview)) fail();
      attempts += r.attempts; orders.add(r.order);
    }
    if (attempts !== raw.sequence) fail();
    for (const [day, entry] of Object.entries(raw.daily)) {
      date(day); keys(entry, ['newIds', 'reviewIds', 'checkedIn']); ids(entry.newIds); ids(entry.reviewIds);
      if (typeof entry.checkedIn !== 'boolean' || entry.newIds.length > LIMIT) fail();
      for (const id of entry.newIds) if (!has(raw.records, id) || raw.records[id].introduced !== day) fail();
      for (const id of entry.reviewIds) if (!has(raw.records, id) || raw.records[id].introduced >= day || typeof raw.records[id].lastSuccess !== 'string' || raw.records[id].lastSuccess < day) fail();
    }
    return {...clone(raw), planMode: raw.planMode || 'foundation'};
  }
  return Object.freeze({createState, dateKey, addDays, dayNumber, getStats, getQueue, grade, canCheckIn, checkIn, validateImport, INTERVALS: Object.freeze(INTERVALS.slice()), DAILY_LIMIT: LIMIT});
});
