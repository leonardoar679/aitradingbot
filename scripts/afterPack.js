const fs = require('fs')
const path = require('path')
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit')

// electron-builder's built-in icon/rcedit step (win.signAndEditExecutable) shells out to a
// native tool that unconditionally tries to download "winCodeSign" even when nothing needs
// signing, and that archive fails to extract without Windows Developer Mode / admin rights.
// This hook does the icon patch ourselves with a pure-JS PE resource editor instead, so
// packaging works without touching Windows privileges or hitting that download at all.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const icoPath = path.join(context.packager.info.projectDir, 'build', 'icon.ico')
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)

  const iconFile = Data.IconFile.from(fs.readFileSync(icoPath))
  const icons = iconFile.icons.map((item) => item.data)

  const exe = NtExecutable.from(fs.readFileSync(exePath))
  const res = NtExecutableResource.from(exe)

  const existingGroups = Resource.IconGroupEntry.fromEntries(res.entries)
  const targets = existingGroups.length > 0 ? existingGroups : [{ id: 1, lang: 1033 }]
  for (const group of targets) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons)
  }

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
}
