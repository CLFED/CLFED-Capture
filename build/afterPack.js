const fs = require('fs');
const path = require('path');
exports.default = async ({ appOutDir, packager }) => {
  const ResEdit = await import('resedit').then((m) => m.default || m);
  const exe = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
  const image = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(image);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, icon.icons.map((i) => i.data));
  const [version] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  version.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'CLFED Capture', FileDescription: 'CLFED Capture', CompanyName: 'Talal (CLFED)',
    LegalCopyright: 'Talal (CLFED)', OriginalFilename: 'CLFED Capture.exe', InternalName: 'CLFED Capture',
  });
  version.setFileVersion(1, 4, 0, 0, 1033);
  version.setProductVersion(1, 4, 0, 0, 1033);
  version.outputToResourceEntries(res.entries);
  res.outputResource(image);
  fs.writeFileSync(exe, Buffer.from(image.generate()));
};
