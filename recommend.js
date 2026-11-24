/*
 * Encore recommendations — collaborative filtering tuned toward rediscovery.
 *
 *  1. Similar users: anyone who rated at least 2 of the same songs and whose
 *     scores on them are within ~3 points of yours on average. Similarity is
 *     that agreement (1 − mean gap / 10), discounted when the overlap is small.
 *  2. Candidates: songs your neighbours rated that you haven't. Songs you've
 *     rated are never suggested; `exclude` skips songs already shown (Refresh).
 *  3. Ranking favours songs you've probably heard already: songs many similar
 *     listeners rated 9+, your favourite artists and genres. The predicted
 *     score (similarity-weighted average of neighbour scores) breaks ties and
 *     filters out songs your neighbours disliked.
 *  4. Every pick carries a short human reason.
 *
 * Shared by the server (real collaborative filtering across users) and the
 * browser (no other users there, so it returns nothing and the app falls back
 * to your favourite artists and the charts).
 */
(function (root) {
  const R = typeof module !== 'undefined' && module.exports ? require('./ranking.js') : root.Ranking;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const fmt = (v) => (v >= 9.995 ? '10' : v.toFixed(1));

  function scoreMap(order) {
    const m = new Map();
    R.flatten(order || []).forEach((e) => m.set(e.id, e.score));
    return m;
  }

  /**
   * me:      { order, songs }
   * others:  [{ order, songs }]   (other users, never including me)
   * exclude: [songId]             (already shown; Refresh asks for a new batch)
   * Returns { items: [{ song, predicted, reason, kind, rank }], neighbours }.
   */
  function recommend({ me, others = [], limit = 30, exclude = [] }) {
    const skip = new Set(exclude);
    const mine = scoreMap(me.order);
    const songs = me.songs || {};
    // Favourite artists and genres from my own ratings.
    const artist = new Map();
    const genre = new Map();
    for (const [id, sc] of mine) {
      const s = songs[id];
      if (!s) continue;
      const a = norm(s.artist);
      const x = artist.get(a) || { sum: 0, n: 0, best: null };
      x.sum += sc; x.n++;
      if (!x.best || sc > x.best.score) x.best = { title: s.title, score: sc };
      artist.set(a, x);
      if (s.genre) genre.set(s.genre, (genre.get(s.genre) || 0) + sc);
    }
    const favArtist = (a) => { const x = artist.get(norm(a)); return x && x.sum / x.n >= 6.5 ? x : null; };
    const topGenres = new Set([...genre.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g));

    // 1. Neighbours.
    const neighbours = [];
    for (const o of others) {
      const os = scoreMap(o.order);
      let n = 0, gap = 0;
      const common = [];
      for (const [id, sc] of os) if (mine.has(id)) { n++; gap += Math.abs(sc - mine.get(id)); common.push(id); }
      if (n < 2) continue;
      const agreement = 1 - gap / n / 10; // 1 = identical scores on shared songs
      if (agreement < 0.7) continue;      // scores more than ~3 points apart on average: not similar
      neighbours.push({ os, songs: o.songs || {}, sim: agreement * Math.min(1, n / 5), common });
    }
    neighbours.sort((a, b) => b.sim - a.sim);
    const top = neighbours.slice(0, 40);

    // 2. Candidates.
    const cand = new Map();
    const get = (id, song) => {
      let c = cand.get(id);
      if (!c) { c = { id, song, sum: 0, w: 0, support: 0, high: 0, anchor: null }; cand.set(id, c); }
      if (!c.song && song) c.song = song;
      return c;
    };
    for (const nb of top) {
      for (const [id, sc] of nb.os) {
        if (mine.has(id) || skip.has(id)) continue;
        const c = get(id, nb.songs[id]);
        c.sum += sc * nb.sim; c.w += nb.sim; c.support++;
        if (sc >= 9) c.high++;
        // Anchor for the reason: the song we both loved most, from the closest neighbour who loved this one.
        if (sc >= 8 && (!c.anchor || nb.sim > c.anchor.sim)) {
          let best = null;
          for (const cid of nb.common) {
            const ms = mine.get(cid);
            if (ms >= 7 && nb.os.get(cid) >= 7 && (!best || ms > best.score)) best = { id: cid, score: ms };
          }
          if (best && songs[best.id]) c.anchor = { sim: nb.sim, title: songs[best.id].title, score: best.score };
        }
      }
    }

    // 3. Rank, mostly by familiarity.
    const items = [];
    for (const c of cand.values()) {
      if (!c.song || !c.song.title) continue;
      const predicted = c.w ? c.sum / c.w : null;
      if (predicted !== null && predicted < 5) continue; // neighbours didn't like it
      const fav = favArtist(c.song.artist);
      const inGenre = c.song.genre && topGenres.has(c.song.genre);
      // Trust a prediction more when several similar listeners back it.
      const conf = Math.min(1, c.w / 1.2);
      const rank = 0.65 * (1 - conf) + ((predicted ?? 6.5) / 10) * conf
        + 0.7 * Math.min(1, c.high / 3)
        + (fav ? 0.6 : 0)
        + (inGenre ? 0.25 : 0)
        + 0.15 * Math.min(1, c.support / 5);
      let reason, kind;
      if (c.high >= 2) { reason = `${c.high} people with similar taste rated this 9+`; kind = 'neighbours'; }
      else if (fav) { reason = `Because you rated ${fav.best.title} a ${fmt(fav.best.score)}`; kind = 'artist'; }
      else if (c.anchor) { reason = `Because you rated ${c.anchor.title} a ${fmt(c.anchor.score)}`; kind = 'similar'; }
      else if (inGenre) { reason = `Popular with listeners who share your ${c.song.genre} picks`; kind = 'genre'; }
      else { reason = 'Rated highly by listeners like you'; kind = 'neighbours'; }
      items.push({ song: c.song, predicted: predicted === null ? null : Math.round(predicted * 10) / 10, reason, kind, rank });
    }
    items.sort((a, b) => b.rank - a.rank);
    return { items: items.slice(0, limit), neighbours: neighbours.length, topGenres: [...topGenres] };
  }

  const api = { recommend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recommend = api;
})(typeof self !== 'undefined' ? self : this);
