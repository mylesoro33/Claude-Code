const test = require('node:test');
const assert = require('node:assert');
const { recommend } = require('../recommend.js');
const song = (id, o = {}) => ({ id, title: 'T' + id, artist: 'A' + id, genre: 'Pop', ...o });
const songs = (ids, o = {}) => Object.fromEntries(ids.map((id) => [id, song(id, o[id])]));

test('new user with no ratings and nobody else: nothing invented', () => {
  const r = recommend({ me: { order: [], songs: {} }, others: [] });
  assert.deepEqual(r.items, []);
  assert.equal(r.neighbours, 0);
});

test('exclude skips songs already shown, so Refresh gets a new batch', () => {
  const me = { order: ['a', 'b', 'c'], songs: songs(['a', 'b', 'c']) };
  const others = [1, 2, 3].map(() => ({ order: ['x', 'y', 'a', 'b', 'c', 'z'], songs: songs(['a', 'b', 'c', 'x', 'y', 'z']) }));
  const first = recommend({ me, others, limit: 1 }).items.map((i) => i.song.id);
  assert.deepEqual(first, ['x']);
  const next = recommend({ me, others, limit: 1, exclude: first }).items.map((i) => i.song.id);
  assert.ok(next.length && next.every((id) => !first.includes(id)), `${next} overlaps ${first}`);
  assert.ok(!next.some((id) => ['a', 'b', 'c'].includes(id)), 'never suggests rated songs');
});

test('favourite artists get a "Because you rated" reason', () => {
  const me = { order: ['a', 'b'], songs: songs(['a', 'b'], { a: { artist: 'Mira', title: 'Low Tide' } }) };
  const other = { order: ['m2', 'a', 'b'], songs: songs(['a', 'b', 'm2'], { a: { artist: 'Mira' }, m2: { artist: 'Mira', title: 'Glass House' } }) };
  const r = recommend({ me, others: [other] });
  const m2 = r.items.find((i) => i.song.id === 'm2');
  assert.equal(m2.reason, 'Because you rated Low Tide a 10');
});

test('songs disliked by similar users are filtered out', () => {
  const me = { order: ['a', 'b', 'c'], songs: songs(['a', 'b', 'c']) };
  const others = [1, 2].map(() => ({ order: ['a', 'b', 'c', 'bad'], songs: songs(['a', 'b', 'c', 'bad']) })); // bad = 2.5
  const r = recommend({ me, others });
  assert.ok(!r.items.some((i) => i.song.id === 'bad'));
});
