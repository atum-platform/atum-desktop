import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { decodePngToRgba, parseIcns } from './mac-icon.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8')
const readBuffer = relativePath => fs.readFileSync(path.join(desktopRoot, relativePath))
const packageJson = JSON.parse(read('package.json'))

test('packaged macOS identity and visible protocol names are Atum while legacy links remain stable', () => {
  assert.equal(packageJson.name, 'hermes')
  assert.equal(packageJson.productName, 'Atum')
  assert.equal(packageJson.build.appId, 'com.atum.desktop')
  assert.equal(packageJson.build.productName, 'Atum')
  assert.equal(packageJson.build.executableName, 'Atum')
  assert.equal(packageJson.build.mac.icon, 'assets/icon-mac.icns')
  assert.deepEqual(packageJson.build.protocols.map(protocol => protocol.name), ['Atum Protocol', 'Atum Protocol'])
  assert.deepEqual(packageJson.build.protocols[0].schemes, ['hermes'])
  assert.doesNotMatch(packageJson.build.protocols.map(protocol => protocol.name).join('\n'), /Hermes|Matrix/u)
})

test('the packaged bundle claims the atum:// scheme the Google sign-in callback returns on', () => {
  // macOS reads CFBundleURLTypes from the packaged Info.plist — an installed
  // build is the ONLY thing that can receive atum://auth-callback/<state>.
  // Losing this entry silently breaks native sign-in with no test failure
  // anywhere else, so pin it next to the Hermes compatibility scheme.
  const schemes = packageJson.build.protocols.flatMap(protocol => protocol.schemes)

  assert.ok(schemes.includes('atum'), 'build.protocols must claim the atum:// scheme')
  assert.ok(schemes.includes('hermes'), 'the inherited hermes:// scheme must keep working')
  assert.equal(new Set(schemes).size, schemes.length, 'a scheme must be claimed exactly once')
})

test('Atum macOS icon source uses a standard rounded tile on a transparent 1024 canvas', () => {
  const svg = read('assets/icon-mac.svg')

  assert.match(svg, /viewBox="0 0 1024 1024"/)
  assert.match(svg, /<rect x="96" y="96" width="832" height="832" rx="184" fill=/)
  assert.doesNotMatch(svg, /<rect width="1024" height="1024" fill=/)
})

test('icon-mac.icns carries the SAME rounded transparent 1024 pixels as icon-mac.png', () => {
  // Content correspondence, not size: the icns 1024px entry must decode to
  // exactly the pixels of icon-mac.png. Corners must stay transparent (macOS
  // does not apply a rounded mask to ICNS artwork), while the tile centre is
  // opaque. This prevents both the hard black square and a nested white tile.
  const pngPixels = decodePngToRgba(readBuffer('assets/icon-mac.png'))

  assert.equal(pngPixels.width, 1024)
  assert.equal(pngPixels.height, 1024)

  const entries = parseIcns(readBuffer('assets/icon-mac.icns'))
  const largest = entries.get('ic10')

  assert.ok(largest, 'icns must contain a 1024px (ic10) entry')

  const icnsPixels = decodePngToRgba(largest)

  assert.equal(icnsPixels.width, 1024)
  assert.equal(icnsPixels.height, 1024)
  assert.deepEqual(
    icnsPixels.data,
    pngPixels.data,
    'icns 1024 entry drifted from icon-mac.png — run: node scripts/generate-mac-icon.mjs'
  )
  const alphaAt = (x, y) => pngPixels.data[(y * pngPixels.width + x) * 4 + 3]

  assert.equal(alphaAt(0, 0), 0, 'top-left canvas corner must be transparent')
  assert.equal(alphaAt(1023, 0), 0, 'top-right canvas corner must be transparent')
  assert.equal(alphaAt(0, 1023), 0, 'bottom-left canvas corner must be transparent')
  assert.equal(alphaAt(1023, 1023), 0, 'bottom-right canvas corner must be transparent')
  assert.equal(alphaAt(512, 512), 0xff, 'rounded tile centre must be opaque')
  assert.equal(alphaAt(512, 96), 0xff, 'rounded tile must reach its declared optical top edge')
})

test('window title and native fallback name are Atum', () => {
  for (const file of ['index.html', 'matrix.html', 'matrix-pages.html', 'matrix-pet.html']) {
    assert.match(read(file), /<title>Atum<\/title>/, file)
  }

  // Hidden developer/SDK documents keep their technical labels; neither is a product window.
  assert.match(read('matrix-sdk.html'), /<title>Atum Matrix SDK<\/title>/)
  assert.match(read('matrix-playground.html'), /<title>Atum Matrix playground<\/title>/)
  assert.match(read('electron/main.ts'), /HERMES_DESKTOP_APP_NAME \|\| 'Atum'/)
})

test('Windows installer and uninstall lifecycle derive or recognize the Atum product identity', () => {
  const installPs1 = fs.readFileSync(path.resolve(desktopRoot, '..', '..', 'scripts', 'install.ps1'), 'utf8')
  const guiUninstall = fs.readFileSync(path.resolve(desktopRoot, '..', '..', 'hermes_cli', 'gui_uninstall.py'), 'utf8')

  assert.match(installPs1, /desktopPackage\.build\.executableName/)
  assert.match(installPs1, /\$desktopExecutableName, "Hermes"/)
  assert.match(installPs1, /"\$ProductName\.lnk"/)
  assert.match(guiUninstall, /Applications\/Atum\.app/)
  assert.match(guiUninstall, /Programs" \/ "Atum"/)
})
