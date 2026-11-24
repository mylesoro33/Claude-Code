const test = require('node:test');
const assert = require('node:assert');
const R = require('../ranking.js');

// Simulate a user whose true taste is a numeric value per song.
function place(order, id, taste) {
  const s = R.startPlacement(order, id);
  let opp;
  while ((opp = R.nextOpponent(s))) R.answer(s, taste[id] > taste[opp] ? 'better' : 'worse');
  return { order: R.commit(order, s), steps: s.steps };
}

test('the first song is a 10 without asking anything', () => {
  const s = R.startPlacement([], 'a');
  assert.strictEqual(R.nextOpponent(s), null);
  const order = R.commit([], s);
  assert.deepStrictEqual(R.flatten(order), [{ id: 'a', rank: 1, score: 10 }]);
});

test('better/worse placement sorts perfectly in log2(n) questions', () => {
  const taste = {};
  let order = [];
  const ids = Array.from({ length: 200 }, (_, i) => 's' + i);
  ids.forEach((id) => (taste[id] = Math.random()));
  for (const id of ids) {
    const n = order.length;
    const out = place(order, id, taste);
    assert.ok(out.steps <= R.maxSteps(n), `took ${out.steps} for n=${n}`);
    order = out.order;
  }
  assert.deepStrictEqual(order, [...ids].sort((a, b) => taste[b] - taste[a]));
});

test('scores re-spread on every add: top is 10, strictly ordered, all within 0–10', () => {
  let order = [];
  for (let n = 1; n <= 50; n++) {
    order = [...order, 'x' + n]; // worst so far
    const flat = R.flatten(order);
    assert.strictEqual(flat[0].score, 10);
    for (let i = 1; i < flat.length; i++) assert.ok(flat[i].score < flat[i - 1].score || flat[i].score === flat[i - 1].score && n > 100);
    assert.ok(flat.every((e) => e.score > 0 && e.score <= 10));
  }
  assert.deepStrictEqual(R.flatten(['a', 'b']).map((e) => e.score), [10, 5]);
  assert.deepStrictEqual(R.flatten(['a', 'b', 'c', 'd']).map((e) => e.score), [10, 7.5, 5, 2.5]);
});

test('a new #1 takes the 10 and everyone else shifts down', () => {
  let order = ['a', 'b'];
  const s = R.startPlacement(order, 'c');
  R.answer(s, 'better'); // better than b (mid)
  R.answer(s, 'better'); // better than a
  order = R.commit(order, s);
  assert.deepStrictEqual(R.flatten(order).map((e) => [e.id, e.score]), [['c', 10], ['a', 6.7], ['b', 3.3]]);
});

test('"about the same" places it right there; re-rating moves a song', () => {
  const s = R.startPlacement(['a', 'b', 'c'], 'x');
  R.answer(s, 'same');
  assert.strictEqual(R.nextOpponent(s), null);
  assert.deepStrictEqual(R.commit(['a', 'b', 'c'], s), ['a', 'x', 'b', 'c']);
  const r = R.startPlacement(['a', 'b', 'c'], 'a'); // re-rate a against b, c
  assert.deepStrictEqual(r.list, ['b', 'c']);
  R.answer(r, 'worse'); R.answer(r, 'worse');
  assert.deepStrictEqual(R.commit(['a', 'b', 'c'], r), ['b', 'c', 'a']);
});

test('drag move, remove and legacy bucket migration', () => {
  assert.deepStrictEqual(R.move(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepStrictEqual(R.move(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']);
  assert.deepStrictEqual(R.move(['a'], 'zz', 0), ['a']);
  assert.deepStrictEqual(R.remove(['a', 'b'], 'a'), ['b']);
  assert.deepStrictEqual(R.fromLegacy({ liked: ['a', 'b'], fine: ['c'], disliked: ['d', 'a'] }), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(R.fromLegacy(null), []);
});
