/**
 * Tests for scripts/mac-icon.mjs + scripts/generate-mac-icon.mjs — the
 * deterministic icon pipeline's pure parts: PNG decoding, ICNS parsing, the
 * iconset table, and staleness detection.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test } from 'vitest'

import { ensureMacIconsFresh, macIconsStale } from './generate-mac-icon.mjs'
import { decodePngToRgba, ICONSET_ENTRIES, isFullyOpaque, isPng, parseIcns, PNG_SIGNATURE } from './mac-icon.mjs'

// Build a minimal valid PNG (8-bit RGBA, filter-0 rows) for decoder tests.
function makeTestPng(width, height, fill) {
  const ihdr = Buffer.alloc(13)

  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0

    for (let x = 0; x < width; x++) {
      fill(raw, y * (stride + 1) + 1 + x * 4, x, y)
    }
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)

    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    // CRC left zeroed — the decoder under test does not validate it.
    out.writeUInt32BE(0, 8 + data.length)

    return out
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Wrap pixel data in a one-entry icns container.
function makeTestIcns(type, pngBuffer) {
  const entry = Buffer.alloc(8 + pngBuffer.length)

  entry.write(type, 0, 'ascii')
  entry.writeUInt32BE(entry.length, 4)
  pngBuffer.copy(entry, 8)

  const header = Buffer.alloc(8)

  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + entry.length, 4)

  return Buffer.concat([header, entry])
}

test('decodePngToRgba round-trips exact pixels', () => {
  const png = makeTestPng(2, 2, (buf, i, x, y) => {
    buf[i] = x * 100
    buf[i + 1] = y * 50
    buf[i + 2] = 7
    buf[i + 3] = 0xff
  })
  const decoded = decodePngToRgba(png)

  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual([...decoded.data.subarray(0, 8)], [0, 0, 7, 0xff, 100, 0, 7, 0xff])
  assert.ok(isFullyOpaque(decoded))
})

test('decodePngToRgba rejects non-PNG and interlaced/exotic encodings loudly', () => {
  assert.throws(() => decodePngToRgba(Buffer.from('not a png')), /Not a PNG/)

  const interlaced = makeTestPng(1, 1, (buf, i) => buf.fill(0xff, i, i + 4))

  interlaced[8 + 8 + 12] = 1 // IHDR interlace byte (8 sig + 8 chunk header + 12 into IHDR data)

  assert.throws(() => decodePngToRgba(interlaced), /Unsupported PNG encoding/)
})

test('isFullyOpaque detects any transparent pixel', () => {
  const png = makeTestPng(2, 1, (buf, i, x) => {
    buf.fill(0xff, i, i + 4)
    buf[i + 3] = x === 0 ? 0xff : 0x00
  })

  assert.equal(isFullyOpaque(decodePngToRgba(png)), false)
})

test('parseIcns extracts typed entries and validates the container', () => {
  const png = makeTestPng(1, 1, (buf, i) => buf.fill(0xff, i, i + 4))
  const icns = makeTestIcns('ic10', png)
  const entries = parseIcns(icns)

  assert.ok(isPng(entries.get('ic10')))
  assert.deepEqual(decodePngToRgba(entries.get('ic10')).data, decodePngToRgba(png).data)

  assert.throws(() => parseIcns(Buffer.from('nope')), /Not an ICNS/)
  const truncated = Buffer.from(icns)

  truncated.writeUInt32BE(icns.length + 100, 4)
  assert.throws(() => parseIcns(truncated), /length mismatch/)
})

test('ICONSET_ENTRIES covers the full apple iconset ladder up to 1024', () => {
  assert.equal(ICONSET_ENTRIES.length, 10)
  assert.equal(ICONSET_ENTRIES.at(-1)[0], 'icon_512x512@2x.png')
  assert.equal(ICONSET_ENTRIES.at(-1)[1], 1024)

  const sizes = new Set(ICONSET_ENTRIES.map(([, size]) => size))

  for (const required of [16, 32, 64, 128, 256, 512, 1024]) {
    assert.ok(sizes.has(required), `iconset missing ${required}px`)
  }
})

test('macIconsStale keys off svg-vs-assets mtimes; non-darwin pack prep skips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-icon-test-'))

  try {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(root, 'assets', 'icon-mac.svg'), '<svg/>')

    // Missing generated assets → stale.
    assert.equal(macIconsStale({ root }), true)

    // Fresh assets (mtime >= svg) → not stale.
    const past = new Date(Date.now() - 60_000)

    fs.writeFileSync(path.join(root, 'assets', 'icon-mac.png'), 'png')
    fs.writeFileSync(path.join(root, 'assets', 'icon-mac.icns'), 'icns')
    fs.utimesSync(path.join(root, 'assets', 'icon-mac.svg'), past, past)
    assert.equal(macIconsStale({ root }), false)

    // Touching the svg again re-stales the pair.
    fs.writeFileSync(path.join(root, 'assets', 'icon-mac.svg'), '<svg changed/>')
    assert.equal(macIconsStale({ root }), true)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }

  assert.deepEqual(ensureMacIconsFresh({ platform: 'linux' }), { reason: 'not-darwin', status: 'skipped' })
})
