'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {window: {}};
for (const file of ['vocabulary.js', 'meta.js', 'learning.js', 'essays.js']) {
  const full = path.join(__dirname, '../dist/data', file);
  assert.ok(fs.existsSync(full), `Required content file is missing: ${file}`);
  vm.runInNewContext(fs.readFileSync(full, 'utf8'), context, {filename: file, timeout: 2000});
}
const {WORDS: words, WORD_META: meta, LEARNING_ARTICLES: articles, ESSAYS: essays} = context.window;
const wordCount = text => (text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || []).length;
function text(value, location) {
  assert.equal(typeof value, 'string', `${location}: expected plain text`);
  assert.ok(value.trim(), `${location}: empty text`);
  assert.doesNotMatch(value, /<\s*\/?\s*[a-z][^>]*>|javascript\s*:/i, `${location}: HTML or executable URL found`);
}
function textList(value, location, minimum = 1) {
  assert.ok(Array.isArray(value) && value.length >= minimum, `${location}: missing items`);
  value.forEach((item, index) => text(item, `${location}[${index}]`));
}
function sources(value, location) {
  assert.ok(Array.isArray(value) && value.length, `${location}: missing source attribution`);
  for (const source of value) {
    text(source.title, `${location}.title`);
    const parsed = new URL(source.url);
    assert.equal(parsed.protocol, 'https:', `${location}: source must use HTTPS`);
    assert.ok(parsed.hostname && !parsed.username && !parsed.password, `${location}: invalid source URL`);
  }
}

test('the complete offline vocabulary has unique IDs and a consistent schema', () => {
  assert.ok(Array.isArray(words) && words.length > 5000);
  assert.equal(new Set(words.map(word => word.id)).size, words.length);
  assert.equal(new Set(words.map(word => word.word.toLowerCase())).size, words.length);
  for (const word of words) {
    text(word.id, 'word.id'); text(word.word, word.id); text(word.meaning, `${word.id}.meaning`);
    assert.equal(typeof word.phonetic, 'string');
    assert.equal(typeof word.core, 'boolean'); assert.equal(typeof word.base, 'boolean');
    assert.ok(Number.isSafeInteger(word.rank) && word.rank > 0, `${word.id}: invalid rank`);
    assert.ok(Array.isArray(word.tags) && word.tags.some(tag => tag === 'cet4' || tag === 'gk'));
  }
  assert.equal(meta.counts.total, words.length);
  assert.equal(meta.counts.base, words.filter(word => word.base).length);
  assert.equal(meta.counts.advanced, words.filter(word => !word.base).length);
  assert.equal(meta.counts.cet4, words.filter(word => word.tags.includes('cet4')).length);
  assert.equal(meta.counts.gk, words.filter(word => word.tags.includes('gk')).length);
});

test('700 non-basic sprint words and 20 real foundation-check IDs are available', () => {
  const core = words.filter(word => word.core);
  assert.equal(core.length, 700);
  assert.ok(core.every(word => !word.base && word.phonetic.trim()));
  assert.equal(meta.counts.core, 700);
  assert.equal(meta.corePlan.primary, 600);
  assert.equal(meta.corePlan.optional, 100);
  assert.equal(meta.foundationCheckIds.length, 20);
  assert.equal(new Set(meta.foundationCheckIds).size, 20);
  for (const id of meta.foundationCheckIds) assert.ok(words.some(word => word.id === id && word.base), `Missing foundation word: ${id}`);
  assert.match(meta.source.commit, /^[a-f0-9]{40}$/);
  assert.match(meta.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(meta.source.license, 'MIT');
  assert.equal(new URL(meta.source.url).protocol, 'https:');
});

test('all six learning articles supply the fields consumed by the app', () => {
  assert.ok(Array.isArray(articles)); assert.equal(articles.length, 6);
  assert.equal(new Set(articles.map(article => article.id)).size, articles.length);
  for (const article of articles) {
    const label = `Article ${article.id}`;
    for (const key of ['id', 'title', 'subtitle']) text(article[key], `${label}.${key}`);
    assert.ok(Number.isInteger(article.minutes) && article.minutes > 0);
    textList(article.body, `${label}.body`, 2);
    textList(article.steps, `${label}.steps`, 2);
    sources(article.sources, `${label}.sources`);
  }
});

test('42 unique writing days are complete, aligned, and within 120–180 words', () => {
  assert.ok(Array.isArray(essays)); assert.equal(essays.length, 42);
  assert.equal(new Set(essays.map(essay => essay.day)).size, 42);
  assert.equal(JSON.stringify(essays.map(essay => essay.day).sort((a, b) => a - b)), JSON.stringify(Array.from({length: 42}, (_, index) => index + 1)));
  assert.equal(new Set(essays.map(essay => essay.title)).size, 42);
  for (const essay of essays) {
    const label = `Day ${essay.day}`;
    for (const key of ['title', 'topic', 'type', 'prompt', 'task']) text(essay[key], `${label}.${key}`);
    textList(essay.essay, `${label}.essay`); textList(essay.translation, `${label}.translation`);
    assert.equal(essay.essay.length, 3, `${label}: expected three English paragraphs`);
    assert.equal(essay.translation.length, essay.essay.length, `${label}: translation misalignment`);
    assert.ok(essay.translation.every(paragraph => /[\u3400-\u9fff]/.test(paragraph)), `${label}: missing Chinese translation`);
    const count = wordCount(essay.essay.join(' '));
    assert.ok(count >= 120 && count <= 180, `${label}: ${count} words, expected 120–180`);
    assert.equal(essay.wordCount, count, `${label}: displayed word count differs from body`);
    textList(essay.outline, `${label}.outline`, 3);
    assert.ok(Array.isArray(essay.phrases) && essay.phrases.length >= 3, `${label}: missing reusable phrases`);
    for (const phrase of essay.phrases) {text(phrase.en, `${label}.phrase.en`); text(phrase.zh, `${label}.phrase.zh`);}
    sources(essay.sources, `${label}.sources`);
  }
});
