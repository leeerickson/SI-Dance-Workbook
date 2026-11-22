// Builds the Recital Live WordPress plugin zip.
// Run from the repository root: node wordpress-plugin/build-recital-live.js
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const plugin = path.join(__dirname, 'recital-live');

const version = /Version:\s*([0-9.]+)/.exec(fs.readFileSync(path.join(plugin, 'recital-live.php'), 'utf8'))[1];
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
const zip = new AdmZip();
zip.addLocalFolder(plugin, 'recital-live');
const file = path.join(out, `recital-live-${version}.zip`);
zip.writeZip(file);
console.log(`Built ${path.relative(root, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
