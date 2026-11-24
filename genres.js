/*
 * The chart genres, shared by the browser and the server.
 *  appleId    → Apple's genre id for the "Current Chart" feed (null = no Apple feed for it)
 *  lastfmTag  → Last.fm tag for "Most Streamed" (Last.fm ranks by total plays)
 *  sample     → clearly labeled placeholder songs, used only when a live source is unavailable
 */
(function (root) {
  const GENRES = [
    { key: 'pop', label: 'Pop', appleId: 14, lastfmTag: 'pop',
      sample: [['Blinding Lights', 'The Weeknd'], ['Shape of You', 'Ed Sheeran'], ['Someone You Loved', 'Lewis Capaldi'], ['As It Was', 'Harry Styles'], ['Starboy', 'The Weeknd'], ['Dance Monkey', 'Tones and I'], ['Perfect', 'Ed Sheeran'], ['Watermelon Sugar', 'Harry Styles'], ['Levitating', 'Dua Lipa'], ['Flowers', 'Miley Cyrus']] },
    { key: 'hiphop', label: 'Rap/Hip-Hop', appleId: 18, lastfmTag: 'hip-hop',
      sample: [['Sunflower', 'Post Malone'], ['rockstar', 'Post Malone'], ["God's Plan", 'Drake'], ['One Dance', 'Drake'], ['Lucid Dreams', 'Juice WRLD'], ['HUMBLE.', 'Kendrick Lamar'], ['SICKO MODE', 'Travis Scott'], ['Without Me', 'Eminem'], ['Mockingbird', 'Eminem'], ['Old Town Road', 'Lil Nas X']] },
    { key: 'rnb', label: 'R&B', appleId: 15, lastfmTag: 'rnb',
      sample: [['Die For You', 'The Weeknd'], ['Kill Bill', 'SZA'], ['Snooze', 'SZA'], ['Leave The Door Open', 'Silk Sonic'], ['Location', 'Khalid'], ['Best Part', 'Daniel Caesar'], ['Redbone', 'Childish Gambino'], ['Earned It', 'The Weeknd'], ['Thinkin Bout You', 'Frank Ocean'], ['Pink + White', 'Frank Ocean']] },
    { key: 'country', label: 'Country', appleId: 6, lastfmTag: 'country',
      sample: [['Last Night', 'Morgan Wallen'], ['Tennessee Whiskey', 'Chris Stapleton'], ['Wagon Wheel', 'Darius Rucker'], ['Fast Car', 'Luke Combs'], ['Beautiful Crazy', 'Luke Combs'], ['Wasted On You', 'Morgan Wallen'], ['Cruise', 'Florida Georgia Line'], ['Need You Now', 'Lady A'], ['Before He Cheats', 'Carrie Underwood'], ['Body Like A Back Road', 'Sam Hunt']] },
    { key: 'rock', label: 'Rock', appleId: 21, lastfmTag: 'rock',
      sample: [['Bohemian Rhapsody', 'Queen'], ['Mr. Brightside', 'The Killers'], ['Believer', 'Imagine Dragons'], ['Smells Like Teen Spirit', 'Nirvana'], ["Sweet Child O' Mine", "Guns N' Roses"], ['Do I Wanna Know?', 'Arctic Monkeys'], ['Thunderstruck', 'AC/DC'], ['In The End', 'Linkin Park'], ["Livin' On A Prayer", 'Bon Jovi'], ['Hotel California', 'Eagles']] },
    { key: 'edm', label: 'EDM', appleId: 17, lastfmTag: 'edm',
      sample: [['Closer', 'The Chainsmokers'], ['Something Just Like This', 'The Chainsmokers'], ['Lean On', 'Major Lazer'], ['Wake Me Up', 'Avicii'], ['Titanium', 'David Guetta'], ['This Is What You Came For', 'Calvin Harris'], ['Faded', 'Alan Walker'], ['Animals', 'Martin Garrix'], ["Don't Let Me Down", 'The Chainsmokers'], ['Levels', 'Avicii']] },
    { key: 'latin', label: 'Latin', appleId: 12, lastfmTag: 'latin',
      sample: [['Despacito', 'Luis Fonsi'], ['Tití Me Preguntó', 'Bad Bunny'], ['DÁKITI', 'Bad Bunny'], ['Taki Taki', 'DJ Snake'], ['Mi Gente', 'J Balvin'], ['Me Porto Bonito', 'Bad Bunny'], ['Hawái', 'Maluma'], ['BICHOTA', 'KAROL G'], ['Danza Kuduro', 'Don Omar'], ['Con Calma', 'Daddy Yankee']] },
    { key: 'alternative', label: 'Alternative', appleId: 20, lastfmTag: 'alternative',
      sample: [['Heat Waves', 'Glass Animals'], ['Riptide', 'Vance Joy'], ['Take Me To Church', 'Hozier'], ['Stressed Out', 'twenty one pilots'], ['Somebody That I Used To Know', 'Gotye'], ['Pumped Up Kicks', 'Foster The People'], ['Sweater Weather', 'The Neighbourhood'], ['Radioactive', 'Imagine Dragons'], ['Little Talks', 'Of Monsters and Men'], ['Ride', 'twenty one pilots']] },
    { key: 'indie', label: 'Indie', appleId: null, lastfmTag: 'indie',
      sample: [['Electric Feel', 'MGMT'], ['The Less I Know The Better', 'Tame Impala'], ['Ho Hey', 'The Lumineers'], ['Young Folks', 'Peter Bjorn and John'], ['Home', 'Edward Sharpe & The Magnetic Zeros'], ['Space Song', 'Beach House'], ['Let It Happen', 'Tame Impala'], ['Dog Days Are Over', 'Florence + The Machine'], ['Kids', 'MGMT'], ['Notion', 'The Rare Occasions']] },
    { key: 'jazz', label: 'Jazz', appleId: 11, lastfmTag: 'jazz',
      sample: [['Fly Me To The Moon', 'Frank Sinatra'], ['Feeling Good', 'Nina Simone'], ['What A Wonderful World', 'Louis Armstrong'], ['Take Five', 'The Dave Brubeck Quartet'], ['So What', 'Miles Davis'], ['Dream A Little Dream Of Me', 'Ella Fitzgerald'], ["Don't Know Why", 'Norah Jones'], ['La Vie En Rose', 'Louis Armstrong'], ['My Funny Valentine', 'Chet Baker'], ['Summertime', 'Ella Fitzgerald']] },
    { key: 'gospel', label: 'Gospel', appleId: 22, lastfmTag: 'gospel',
      sample: [['Goodness of God', 'Bethel Music'], ['Graves Into Gardens', 'Elevation Worship'], ['Way Maker', 'Leeland'], ['Oceans (Where Feet May Fail)', 'Hillsong UNITED'], ['I Can Only Imagine', 'MercyMe'], ['Total Praise', 'Richard Smallwood'], ['Break Every Chain', 'Tasha Cobbs Leonard'], ['Never Would Have Made It', 'Marvin Sapp'], ['Jireh', 'Elevation Worship'], ['Stand', 'Donnie McClurkin']] },
    { key: 'kpop', label: 'K-Pop', appleId: 51, lastfmTag: 'k-pop',
      sample: [['Dynamite', 'BTS'], ['Butter', 'BTS'], ['How You Like That', 'BLACKPINK'], ['DDU-DU DDU-DU', 'BLACKPINK'], ['Ditto', 'NewJeans'], ['Hype Boy', 'NewJeans'], ['Seven', 'Jung Kook'], ['Kill This Love', 'BLACKPINK'], ['Boy With Luv', 'BTS'], ['Supernova', 'aespa']] },
  ];
  const byKey = Object.fromEntries(GENRES.map((g) => [g.key, g]));
  const api = { GENRES, byKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Genres = api;
})(typeof self !== 'undefined' ? self : this);
