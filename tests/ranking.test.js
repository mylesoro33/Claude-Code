const test = require('node:test');
const assert = require('node:assert');
const R = require('../ranking.js');

// Simulate a user whose true taste is a numeric value per song.
function place(rankings, bucket, id, taste) {
  const s = R.startPlacement(rankings, bucket, id);
  let opp;
  while ((opp = R.nextOpponent(s))) R.answer(s, taste[id] > taste[opp] ? 'new' : 'old');
  return { rankings: R.commit(rankings, s), steps: s.steps };
}

test('binary insertion produces a perfectly sorted list in log2(n) questions', () => {
  const taste = {};
  let r = R.emptyRankings();
  const ids = Array.from({ length: 100 }, (_, i) => 's' + i);
  ids.forEach((id) => (taste[id] = Math.random()));
  for (const id of ids) {
    const n = r.liked.length;
    const out = place(r, 'liked', id, taste);
    assert.ok(out.steps <= R.maxSteps(n), `took ${out.steps} for n=${n}`);
    r = out.rankings;
  }
  const sorted = [...ids].sort((a, b) => taste[b] - taste[a]);
  assert.deepStrictEqual(r.liked, sorted);
});

test('scores stay inside bucket bands and decrease with rank', () => {
  let r = { liked: ['a', 'b', 'c'], fine: ['d', 'e'], disliked: ['f'] };
  const flat = R.flatten(r);
  assert.deepStrictEqual(flat.map((e) => e.rank), [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(flat[0].score, 10);
  assert.strictEqual(flat[2].score, 6.7);
  for (let i = 1; i < flat.length; i++) assert.ok(flat[i].score <= flat[i - 1].score);
});

test('re-ranking moves a song between buckets and tie places at midpoint', () => {
  let r = { liked: ['a', 'b', 'c'], fine: [], disliked: [] };
  const s = R.startPlacement(r, 'fine', 'a');
  assert.strictEqual(R.nextOpponent(s), null);
  r = R.commit(r, s);
  assert.deepStrictEqual(r, { liked: ['b', 'c'], fine: ['a'], disliked: [] });
  const t = R.startPlacement(r, 'liked', 'x');
  R.answer(t, 'tie');
  assert.strictEqual(R.nextOpponent(t), null);
  assert.deepStrictEqual(R.commit(r, t).liked, ['b', 'x', 'c']);
});
