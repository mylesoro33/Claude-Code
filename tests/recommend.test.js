const test = require('node:test');
const assert = require('node:assert');
const { recommend } = require('../recommend.js');
const song = (id, o = {}) => ({ id, title: 'T' + id, artist: 'A' + id, genre: 'Pop', ...o });
const songs = (ids, o = {}) => Object.fromEntries(ids.map((id) => [id, song(id, o[id])]));

test('new user with no ratings: only listening history, nothing invented', () => {
  const r = recommend({ me: { order: [], songs: {}, heard: [song('h')] }, others: [] });
  assert.deepEqual(r.items.map((i) => i.song.id), ['h']);
  assert.equal(r.neighbours, 0);
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
