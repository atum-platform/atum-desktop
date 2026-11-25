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

test('Matrix packaging claims the native sign-in callback scheme', () => {
  for (const file of ['matrix-builder.json', 'matrix-release-builder.json']) {
    const builder = JSON.parse(read(file))
    assert.equal(builder.appId, 'com.atum.matrix-candidate')
    assert.equal(builder.executableName, 'Atum Matrix Candidate')
    assert.ok(builder.protocols.flatMap(protocol => protocol.schemes).includes('atum'))
    assert.equal(builder.directories.app, 'dist-matrix')
  }
  assert.equal(packageJson.main, 'dist-matrix/matrix-main.mjs')
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
  assert.match(read('matrix-builder.json'), /Atum Matrix Candidate/)
})
