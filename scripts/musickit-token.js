// Mint a MusicKit developer token for static hosting (paste it into config.js).
//   APPLE_TEAM_ID=ABCDE12345 APPLE_KEY_ID=XYZ987TUV1 APPLE_PRIVATE_KEY_PATH=./AuthKey.p8 node scripts/musickit-token.js
const { appleConfig, makeDeveloperToken } = require('../server.js');
const cfg = appleConfig();
if (!cfg) { console.error('Set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY_PATH first.'); process.exit(1); }
console.log(makeDeveloperToken(cfg, 180 * 24 * 3600 - 60)); // Apple's maximum is 6 months
