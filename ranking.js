/*
 * Encore rating engine.
 *
 * Your ratings are one ordered list, best → worst. You never type a number:
 *  - The first song you rate goes straight to the top with a 10.
 *  - Every song after that is placed by head-to-head questions
 *    ("Is this better or worse than X?"). It's a binary search, so placing a
 *    song into a list of N takes only ~log2(N) questions (7 for 100 songs).
 *  - Scores come from rank and are re-spread across the whole list every time
 *    it changes: score = 10 × (N − i) / N for the song at position i (0 = best).
 *    The top song is always 10, the order never contradicts the scores, and
 *    the gaps shrink as your collection grows.
 */
(function (root) {
  const round1 = (x) => Math.round(x * 10) / 10;

  /** Score for position i (0 = best) in a list of n songs. */
  function scoreFor(i, n) {
    if (n <= 0) return 0;
    return round1((10 * (n - i)) / n);
  }

  /** [{ id, rank, score }] best → worst. */
  function flatten(order) {
    const n = order.length;
    return order.map((id, i) => ({ id, rank: i + 1, score: scoreFor(i, n) }));
  }

  /**
   * Start placing `songId`. If the list (without this song) is empty, the
   * placement is already decided: it becomes #1 with a 10.
   */
  function startPlacement(order, songId) {
    const list = order.filter((id) => id !== songId);
    return { songId, list, lo: 0, hi: list.length, steps: 0 };
  }

  /** The song to compare against next, or null when the rank is decided. */
  function nextOpponent(s) {
    if (s.lo >= s.hi) return null;
    return s.list[Math.floor((s.lo + s.hi) / 2)];
  }

  /** choice: 'better' (new song beats the opponent), 'worse', or 'same'. */
  function answer(s, choice) {
    const mid = Math.floor((s.lo + s.hi) / 2);
    s.steps++;
    if (choice === 'better') s.hi = mid;
    else if (choice === 'worse') s.lo = mid + 1;
    else if (choice === 'same') { s.lo = mid; s.hi = mid; }
    else throw new Error('bad choice ' + choice);
    return s;
  }

  /** Most questions a placement into a list of n songs can take. */
  function maxSteps(n) {
    return n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1;
  }

  /** Apply a finished placement; returns the new order. */
  function commit(order, s) {
    const out = order.filter((id) => id !== s.songId);
    out.splice(s.lo, 0, s.songId);
    return out;
  }

  function remove(order, songId) {
    return order.filter((id) => id !== songId);
  }

  /** Drag-to-rank: move a song to `index` (0 = top). */
  function move(order, songId, index) {
    if (!order.includes(songId)) return order;
    const out = order.filter((id) => id !== songId);
    out.splice(Math.max(0, Math.min(index, out.length)), 0, songId);
    return out;
  }

  /** Convert the old loved / fine / didn't-like buckets into one ordered list. */
  function fromLegacy(rankings) {
    if (!rankings || typeof rankings !== 'object') return [];
    const seen = new Set();
    return [...(rankings.liked || []), ...(rankings.fine || []), ...(rankings.disliked || [])]
      .filter((id) => typeof id === 'string' && !seen.has(id) && seen.add(id));
  }

  const api = { scoreFor, flatten, startPlacement, nextOpponent, answer, maxSteps, commit, remove, move, fromLegacy, round1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ranking = api;
})(typeof self !== 'undefined' ? self : this);
