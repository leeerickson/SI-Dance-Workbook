// Builds the WordPress plugin zip: copies the shared player (mobile/www) into the plugin and zips it.
// Run from the repository root: node wordpress-plugin/build.js
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const plugin = path.join(__dirname, 'dance-player');
const playerSrc = path.join(root, 'mobile', 'www');
const playerDst = path.join(plugin, 'player');

fs.rmSync(playerDst, { recursive: true, force: true });
fs.cpSync(playerSrc, playerDst, { recursive: true });

const version = /Version:\s*([0-9.]+)/.exec(fs.readFileSync(path.join(plugin, 'dance-player.php'), 'utf8'))[1];
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
const zip = new AdmZip();
zip.addLocalFolder(plugin, 'dance-player');
const file = path.join(out, `dance-player-${version}.zip`);
zip.writeZip(file);
console.log(`Built ${path.relative(root, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
