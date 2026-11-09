/**
 * mac-icon.mjs
 *
 * Dependency-free helpers for the Atum macOS icon pipeline, shared by
 * scripts/generate-mac-icon.mjs (regeneration) and
 * scripts/atum-branding.test.mjs (content-correction assertions):
 *
 *   - ICONSET_ENTRIES — the canonical .iconset filename ↔ pixel-size table
 *     iconutil expects.
 *   - decodePngToRgba — a minimal PNG decoder (8-bit, non-interlaced, color
 *     types 0/2/4/6) normalizing to RGBA. Enough to prove that the ICNS
 *     payload and icon-mac.png carry the SAME pixels, not just similar sizes.
 *   - parseIcns — split an .icns container into its typed entries.
 *
 * Decoders this small are a deliberate trade: the icon is our own generator's
 * output (sips/iconutil produce plain 8-bit non-interlaced PNGs), so a full
 * PNG implementation would be dead surface. Anything outside that envelope
 * throws loudly instead of passing a bad assertion.
 */

import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// iconutil's expected iconset members: [filename, pixel width/height].
const ICONSET_ENTRIES = Object.freeze([
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
])

// Samples per pixel for the PNG color types we accept.
const COLOR_TYPE_BPP = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 })

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode an 8-bit non-interlaced PNG (color types 0/2/4/6) to a plain RGBA
 * pixel buffer: { width, height, data } where data is width*height*4 bytes.
 */
function decodePngToRgba(buffer) {
  if (!isPng(buffer)) {
    throw new Error('Not a PNG file')
  }

  let offset = 8
  let ihdr = null
  const idat = []

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (!ihdr) {
    throw new Error('PNG is missing IHDR')
  }

  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || !(ihdr.colorType in COLOR_TYPE_BPP)) {
    throw new Error(
      `Unsupported PNG encoding (bitDepth=${ihdr.bitDepth}, colorType=${ihdr.colorType}, interlace=${ihdr.interlace})`
    )
  }

  const bpp = COLOR_TYPE_BPP[ihdr.colorType]
  const stride = ihdr.width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))

  if (raw.length !== (stride + 1) * ihdr.height) {
    throw new Error(`PNG pixel data length mismatch (got ${raw.length}, want ${(stride + 1) * ihdr.height})`)
  }

  // Un-filter scanlines in place.
  const pixels = Buffer.alloc(stride * ihdr.height)

  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride)
    const rowUp = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? rowOut[x - bpp] : 0
      const up = rowUp ? rowUp[x] : 0
      const upLeft = rowUp && x >= bpp ? rowUp[x - bpp] : 0
      const value = rowIn[x]

      if (filter === 0) {
        rowOut[x] = value
      } else if (filter === 1) {
        rowOut[x] = (value + left) & 0xff
      } else if (filter === 2) {
        rowOut[x] = (value + up) & 0xff
      } else if (filter === 3) {
        rowOut[x] = (value + ((left + up) >> 1)) & 0xff
      } else if (filter === 4) {
        rowOut[x] = (value + paeth(left, up, upLeft)) & 0xff
      } else {
        throw new Error(`Unknown PNG row filter ${filter}`)
      }
    }
  }

  // Normalize to RGBA so cross-encoder comparisons (sips vs iconutil) compare
  // pixels, not container choices.
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4)

  for (let i = 0, j = 0; i < pixels.length; i += bpp, j += 4) {
    if (ihdr.colorType === 6) {
      rgba[j] = pixels[i]
      rgba[j + 1] = pixels[i + 1]
      rgba[j + 2] = pixels[i + 2]
      rgba[j + 3] = pixels[i + 3]
    } else if (ihdr.colorType === 2) {
      rgba[j] = pixels[i]
      rgba[j + 1] = pixels[i + 1]
      rgba[j + 2] = pixels[i + 2]
      rgba[j + 3] = 0xff
    } else if (ihdr.colorType === 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = pixels[i]
      rgba[j + 3] = pixels[i + 1]
    } else {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = pixels[i]
      rgba[j + 3] = 0xff
    }
  }

  return { data: rgba, height: ihdr.height, width: ihdr.width }
}

/**
 * Split an .icns container into { type → data } entries. Throws on a malformed
 * header or truncated entry — a structurally invalid icns should fail the
 * test/build, never squeak through.
 */
function parseIcns(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('Not an ICNS file')
  }

  const declared = buffer.readUInt32BE(4)

  if (declared !== buffer.length) {
    throw new Error(`ICNS length mismatch (header ${declared}, file ${buffer.length})`)
  }

  const entries = new Map()
  let offset = 8

  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32BE(offset + 4)

    if (length < 8 || offset + length > buffer.length) {
      throw new Error(`ICNS entry '${type}' has an invalid length (${length})`)
    }

    entries.set(type, buffer.subarray(offset + 8, offset + length))
    offset += length
  }

  return entries
}

/** True when every pixel's alpha channel is fully opaque. */
function isFullyOpaque({ data }) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0xff) {
      return false
    }
  }

  return true
}

export { COLOR_TYPE_BPP, decodePngToRgba, ICONSET_ENTRIES, isFullyOpaque, isPng, parseIcns, PNG_SIGNATURE }
