/*
 * Chart genres, shared by the browser and the server, and the one mapping
 * from genre names / tags (Apple, Last.fm, Spotify…) to these keys.
 *
 * Per genre, each chart source's own id:
 *   appleId    Apple Music genre id (genre chart feed)
 *   deezerId   Deezer genre id (/chart/{id}/tracks)
 *   billboard  Billboard chart slug (via your licensed / third-party provider)
 *   lastfmTag  Last.fm tag (top tracks by tag, with play counts)
 * A missing id means that source has no chart for the genre.
 */
(function (root) {
  const GENRES = [
    { key: 'pop', label: 'Pop', appleId: 14, deezerId: 132, billboard: 'pop-songs', lastfmTag: 'pop' },
    { key: 'hiphop', label: 'Rap/Hip-Hop', appleId: 18, deezerId: 116, billboard: 'hot-rap-songs', lastfmTag: 'hip-hop' },
    { key: 'rnb', label: 'R&B', appleId: 15, deezerId: 165, billboard: 'hot-r-and-and-b-hip-hop-songs', lastfmTag: 'rnb' },
    { key: 'country', label: 'Country', appleId: 6, deezerId: 84, billboard: 'country-songs', lastfmTag: 'country' },
    { key: 'rock', label: 'Rock', appleId: 21, deezerId: 152, billboard: 'hot-rock-songs', lastfmTag: 'rock' },
    { key: 'edm', label: 'EDM', appleId: 17, deezerId: 113, billboard: 'dance-electronic-songs', lastfmTag: 'edm' },
    { key: 'latin', label: 'Latin', appleId: 12, deezerId: 197, billboard: 'latin-songs', lastfmTag: 'latin' },
    { key: 'alternative', label: 'Alternative', appleId: 20, deezerId: 85, billboard: 'hot-alternative-songs', lastfmTag: 'alternative' },
    { key: 'indie', label: 'Indie', appleId: null, deezerId: null, billboard: null, lastfmTag: 'indie' },
    { key: 'jazz', label: 'Jazz', appleId: 11, deezerId: 129, billboard: 'jazz-songs', lastfmTag: 'jazz' },
    { key: 'gospel', label: 'Gospel', appleId: 22, deezerId: 186, billboard: 'hot-gospel-songs', lastfmTag: 'gospel' },
    { key: 'kpop', label: 'K-Pop', appleId: 51, deezerId: null, billboard: null, lastfmTag: 'k-pop' },
  ];
  /** The all-genres overall chart (never de-duplicated against the genre charts). */
  const ALL = { key: 'all', label: 'All genres', billboard: 'hot-100', billboardAlbums: 'billboard-200', deezerId: 0 };

  // Most specific first: "indie pop" is indie, "pop rap" is hip-hop, "k-pop" is K-Pop.
  const RULES = [
    ['kpop', /k-?pop|korean/],
    ['latin', /latin|reggaeton|urbano|bachata|salsa|regional mexican|corrido|cumbia|latino|música mexicana|musica mexicana/],
    ['gospel', /gospel|christian|worship|\bccm\b/],
    ['country', /country|americana|bluegrass/],
    ['jazz', /jazz|bebop|swing|bossa/],
    ['hiphop', /hip.?hop|\brap\b|trap|drill|grime/],
    ['rnb', /r&b|\brnb\b|r and b|soul|funk/],
    ['edm', /\bedm\b|electronic|electronica|dance|house|techno|trance|dubstep|electro|drum and bass|dnb/],
    ['indie', /indie/],
    ['alternative', /alternative|alt-?rock|emo|post-?punk|grunge|shoegaze/],
    ['rock', /rock|metal|punk/],
    ['pop', /pop/],
  ];
  /** One genre name or tag → a chart genre key (or null). */
  function fromName(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    for (const [k, re] of RULES) if (re.test(n)) return k;
    return null;
  }
  /** Ordered tags (strongest first) → the first that maps to a chart genre. */
  function fromTags(tags) {
    for (const t of tags || []) { const k = fromName(t); if (k) return k; }
    return null;
  }

  const byKey = Object.fromEntries(GENRES.map((g) => [g.key, g]));
  byKey.all = ALL;
  const api = { GENRES, ALL, byKey, fromName, fromTags };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Genres = api;
})(typeof self !== 'undefined' ? self : this);
