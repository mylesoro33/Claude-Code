/*
 * Encore ranking engine — Beli-style pairwise ranking.
 *
 * Every ranked song lives in one of three buckets (loved / fine / didn't like).
 * Inside a bucket songs are ordered best → worst. A new song is placed with a
 * binary search: each step asks "do you like the new song more than X?", so
 * placing a song into a list of N takes only ~log2(N) questions.
 *
 * Scores (0–10) come from position: each bucket owns a score band and songs
 * are spread evenly through it, so scores shift as your list grows.
 */
(function (root) {
  const BUCKETS = ['liked', 'fine', 'disliked'];
  const BANDS = {
    liked: [6.7, 10.0],
    fine: [3.4, 6.6],
    disliked: [0.0, 3.3],
  };

  function emptyRankings() {
    return { liked: [], fine: [], disliked: [] };
  }

  /** Start placing `songId` into `bucket`. Returns a session object. */
  function startPlacement(rankings, bucket, songId) {
    if (!BUCKETS.includes(bucket)) throw new Error('bad bucket ' + bucket);
    const list = rankings[bucket].filter((id) => id !== songId);
    return { bucket, songId, list, lo: 0, hi: list.length, steps: 0 };
  }

  /** The song to compare against next, or null when placement is decided. */
  function nextOpponent(session) {
    if (session.lo >= session.hi) return null;
    return session.list[Math.floor((session.lo + session.hi) / 2)];
  }

  /**
   * Record an answer. choice: 'new' (new song is better), 'old' (opponent is
   * better) or 'tie' (too close to call — place it right there).
   */
  function answer(session, choice) {
    const mid = Math.floor((session.lo + session.hi) / 2);
    session.steps++;
    if (choice === 'new') session.hi = mid;
    else if (choice === 'old') session.lo = mid + 1;
    else if (choice === 'tie') { session.lo = mid; session.hi = mid; }
    else throw new Error('bad choice ' + choice);
    return session;
  }

  /** Max questions a placement into a list of n songs can take. */
  function maxSteps(n) {
    return n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1;
  }

  /** Apply a finished session; returns a new rankings object. */
  function commit(rankings, session) {
    const out = emptyRankings();
    for (const b of BUCKETS) out[b] = rankings[b].filter((id) => id !== session.songId);
    const list = out[session.bucket];
    list.splice(session.lo, 0, session.songId);
    return out;
  }

  function remove(rankings, songId) {
    const out = emptyRankings();
    for (const b of BUCKETS) out[b] = rankings[b].filter((id) => id !== songId);
    return out;
  }

  /** Score for position i (0 = best) in a bucket of n songs. */
  function scoreFor(bucket, i, n) {
    const [min, max] = BANDS[bucket];
    if (n <= 1) return round1(bucket === 'liked' ? 8.5 : (min + max) / 2);
    return round1(max - (i / (n - 1)) * (max - min));
  }

  /** Flat ordered list: [{id, bucket, rank, score}] best → worst. */
  function flatten(rankings) {
    const out = [];
    let rank = 1;
    for (const b of BUCKETS) {
      const list = rankings[b];
      list.forEach((id, i) => out.push({ id, bucket: b, rank: rank++, score: scoreFor(b, i, list.length) }));
    }
    return out;
  }

  function bucketOf(rankings, songId) {
    return BUCKETS.find((b) => rankings[b].includes(songId)) || null;
  }

  function round1(x) {
    return Math.round(x * 10) / 10;
  }

  const api = { BUCKETS, BANDS, emptyRankings, startPlacement, nextOpponent, answer, maxSteps, commit, remove, scoreFor, flatten, bucketOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ranking = api;
})(typeof self !== 'undefined' ? self : this);
