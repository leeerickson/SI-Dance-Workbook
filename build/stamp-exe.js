// Puts the app icon and version details into the Windows .exe without needing Wine.
// Used by `npm run dist` between packaging and building the installer.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const pkg = require('../package.json');

const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', `${pkg.productName}.exe`);
const ico = path.join(__dirname, 'icon.ico');

const data = fs.readFileSync(exe);
const file = ResEdit.NtExecutable.from(data, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(file);

const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map(i => i.data));

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
const [a, b, c] = pkg.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: pkg.productName,
  ProductName: pkg.productName,
  CompanyName: pkg.author,
  InternalName: pkg.productName,
  OriginalFilename: `${pkg.productName}.exe`,
  LegalCopyright: `Copyright © ${new Date().getFullYear()} ${pkg.author}`
});
vi.outputToResourceEntries(res.entries);

res.outputResource(file);
fs.writeFileSync(exe, Buffer.from(file.generate()));
console.log(`Stamped icon and version ${pkg.version} into ${path.basename(exe)}`);
