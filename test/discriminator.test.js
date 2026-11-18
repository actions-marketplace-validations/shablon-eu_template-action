import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOverlap, canonicalDiscriminator, rulesForParameter } from '../src/discriminator.js';

const rules = (map) => Object.entries(map).flatMap(([p, c]) => rulesForParameter(p, c));

test('rulesForParameter shorthand', () => {
  assert.deepEqual(rulesForParameter('lang', 'de'), [{ parameter: 'lang', cmp: 'eq', value: 'de' }]);
  assert.deepEqual(rulesForParameter('n', 5), [{ parameter: 'n', cmp: 'eq', value: 5 }]);
  assert.deepEqual(rulesForParameter('lang', ['de', 'at']), [{ parameter: 'lang', cmp: 'in', value: ['de', 'at'] }]);
  assert.deepEqual(rulesForParameter('lang', { not: 'de' }), [{ parameter: 'lang', cmp: 'not', value: 'de' }]);
});

test('rulesForParameter rejects invalid conditions', () => {
  assert.throws(() => rulesForParameter('x', null), /string or a number/);
  assert.throws(() => rulesForParameter('x', true), /booleans/);
  assert.throws(() => rulesForParameter('x', []), /non-empty list/);
  assert.throws(() => rulesForParameter('x', { eq: ['a'] }), /Use `in`/);
  assert.throws(() => rulesForParameter('x', { in: 'a' }), /list of strings/);
  assert.throws(() => rulesForParameter('x', {}), /empty/);
});

test('canonicalDiscriminator ignores order and treats missing as catch-all', () => {
  assert.equal(
    canonicalDiscriminator(rules({ a: 'x', b: ['1', '2'] })),
    canonicalDiscriminator(rules({ b: ['2', '1'], a: 'x' })),
  );
  assert.equal(canonicalDiscriminator(undefined), canonicalDiscriminator([]));
  assert.notEqual(canonicalDiscriminator(rules({ a: 'x' })), canonicalDiscriminator(rules({ a: 'y' })));
  assert.notEqual(canonicalDiscriminator(rules({ a: 5 })), canonicalDiscriminator(rules({ a: '5' })));
});

test('canOverlap', () => {
  const overlap = (a, b) => canOverlap(rules(a), rules(b));
  assert.equal(overlap({ lang: 'de' }, {}), true);
  assert.equal(overlap({ lang: 'de' }, { plan: 'pro' }), true);
  assert.equal(overlap({ lang: 'de' }, { lang: 'en' }), false);
  assert.equal(overlap({ lang: 'de' }, { lang: ['de', 'at'] }), true);
  assert.equal(overlap({ lang: ['en', 'fr'] }, { lang: ['de', 'at'] }), false);
  assert.equal(overlap({ lang: 'de' }, { lang: { not: 'de' } }), false);
  assert.equal(overlap({ lang: ['de'] }, { lang: { not_in: ['de', 'at'] } }), false);
  assert.equal(overlap({ lang: { not: 'de' } }, { lang: { not: 'en' } }), true);
  assert.equal(overlap({ age: { lt: 18 } }, { age: { gte: 18 } }), false);
  assert.equal(overlap({ age: { lte: 18 } }, { age: { gte: 18 } }), true);
  assert.equal(overlap({ age: { gt: 10, lt: 20 } }, { age: { gt: 15 } }), true);
  assert.equal(overlap({ age: 5 }, { age: { gt: 5 } }), false);
  assert.equal(overlap({ age: '5' }, { age: { lte: 5 } }), true);
  // String comparisons are not analysed, so they count as overlapping.
  assert.equal(overlap({ d: { lt: '2026' } }, { d: { gte: '2026' } }), true);
});
