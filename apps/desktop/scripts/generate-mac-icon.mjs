#!/usr/bin/env node
/**
 * generate-mac-icon.mjs — deterministic regeneration of the packaged macOS
 * icon assets from their single source of truth, assets/icon-mac.svg:
 *
 *   assets/icon-mac.svg
 *     → assets/icon-mac.png   (1024×1024 master render)
 *     → assets/icon-mac.icns  (full iconset, via iconutil)
 *
 * Usage:
 *   node scripts/generate-mac-icon.mjs            # regenerate (macOS only)
 *   node scripts/generate-mac-icon.mjs --check    # exit 1 if assets are stale
 *
 * Toolchain (all macOS-built-in except the optional rsvg-convert):
 *   - rasterize:  rsvg-convert when available (best SVG fidelity), else sips
 *   - resample:   sips -z (fixed sips resampling, identical inputs → identical
 *                 pixels on a given toolchain)
 *   - iconset→icns: iconutil -c icns
 *
 * The 512@2x iconset member IS the un-resampled master, so the icns 1024px
 * entry and icon-mac.png are pixel-identical by construction — the branding
 * test asserts exactly that (see scripts/atum-branding.test.mjs).
 *
 * Non-macOS hosts are never required to have this toolchain: the script
 * refuses early with a clear message, and pack-prep only calls it for darwin
 * targets, falling back to the checked-in assets when regeneration is
 * unavailable (see before-pack.mjs).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePngToRgba, ICONSET_ENTRIES, parseIcns } from './mac-icon.mjs'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SVG_PATH = path.join(DESKTOP_ROOT, 'assets', 'icon-mac.svg')
const PNG_PATH = path.join(DESKTOP_ROOT, 'assets', 'icon-mac.png')
const ICNS_PATH = path.join(DESKTOP_ROOT, 'assets', 'icon-mac.icns')
const MASTER_SIZE = 1024

function commandExists(command) {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

/** Why regeneration can't run here, or null when the toolchain is complete. */
function macIconToolchainProblem({ platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    return `macOS icon regeneration requires macOS (iconutil/sips); host is ${platform}`
  }

  if (!commandExists('iconutil')) {
    return 'iconutil not found (Xcode command line tools required)'
  }

  if (!commandExists('sips')) {
    return 'sips not found'
  }

  return null
}

function rasterizeSvg(svgPath, outPng) {
  if (commandExists('rsvg-convert')) {
    execFileSync('rsvg-convert', ['-w', String(MASTER_SIZE), '-h', String(MASTER_SIZE), '-o', outPng, svgPath])

    return
  }

  // sips rasterizes at the SVG document size — icon-mac.svg declares
  // width/height 1024, so the output is the 1024 master directly.
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', outPng], { stdio: ['ignore', 'ignore', 'inherit'] })
}

/**
 * Regenerate icon-mac.png + icon-mac.icns from icon-mac.svg. Returns the
 * output paths and their sha256 digests for the build log.
 */
function generateMacIcons({ root = DESKTOP_ROOT, log = console.log } = {}) {
  const problem = macIconToolchainProblem()

  if (problem) {
    throw new Error(problem)
  }

  const svgPath = path.join(root, 'assets', 'icon-mac.svg')
  const pngPath = path.join(root, 'assets', 'icon-mac.png')
  const icnsPath = path.join(root, 'assets', 'icon-mac.icns')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-icon-'))

  try {
    const master = path.join(work, 'master.png')

    rasterizeSvg(svgPath, master)

    const decoded = decodePngToRgba(fs.readFileSync(master))

    if (decoded.width !== MASTER_SIZE || decoded.height !== MASTER_SIZE) {
      throw new Error(`master render is ${decoded.width}x${decoded.height}, expected ${MASTER_SIZE}x${MASTER_SIZE}`)
    }

    fs.copyFileSync(master, pngPath)

    const iconset = path.join(work, 'icon-mac.iconset')

    fs.mkdirSync(iconset)

    for (const [filename, size] of ICONSET_ENTRIES) {
      const target = path.join(iconset, filename)

      if (size === MASTER_SIZE) {
        // The 1024 member is the master itself — no resample — so the icns
        // and icon-mac.png carry identical pixels by construction.
        fs.copyFileSync(master, target)
      } else {
        execFileSync('sips', ['-z', String(size), String(size), master, '--out', target], {
          stdio: ['ignore', 'ignore', 'inherit']
        })
      }
    }

    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath])

    // Fail closed: the artifact we ship must parse and contain a 1024 entry
    // that decodes — never ship a structurally suspect icns.
    const entries = parseIcns(fs.readFileSync(icnsPath))
    const largest = entries.get('ic10')

    if (!largest) {
      throw new Error('generated icns is missing its 1024px (ic10) entry')
    }

    const icnsPixels = decodePngToRgba(largest)

    if (icnsPixels.width !== MASTER_SIZE || icnsPixels.height !== MASTER_SIZE) {
      throw new Error(`icns 1024 entry decoded to ${icnsPixels.width}x${icnsPixels.height}`)
    }

    const digest = target => createHash('sha256').update(fs.readFileSync(target)).digest('hex')

    const result = { icns: icnsPath, png: pngPath, sha256: { icns: digest(icnsPath), png: digest(pngPath) } }

    log(`[mac-icon] regenerated ${path.relative(root, pngPath)} (${result.sha256.png.slice(0, 12)})`)
    log(`[mac-icon] regenerated ${path.relative(root, icnsPath)} (${result.sha256.icns.slice(0, 12)})`)

    return result
  } finally {
    fs.rmSync(work, { force: true, recursive: true })
  }
}

/** True when the SVG source is newer than either generated asset. */
function macIconsStale({ root = DESKTOP_ROOT } = {}) {
  const svgPath = path.join(root, 'assets', 'icon-mac.svg')
  const svgMtime = fs.statSync(svgPath).mtimeMs

  for (const generated of ['icon-mac.png', 'icon-mac.icns']) {
    const target = path.join(root, 'assets', generated)

    if (!fs.existsSync(target) || fs.statSync(target).mtimeMs < svgMtime) {
      return true
    }
  }

  return false
}

/**
 * Pack-prep integration (darwin targets only): regenerate when the checked-in
 * assets are stale relative to the SVG. When the toolchain is unavailable the
 * checked-in assets remain authoritative — callers treat a thrown error as
 * "keep existing assets", never as a build failure.
 */
function ensureMacIconsFresh({ root = DESKTOP_ROOT, platform = process.platform, log = console.log } = {}) {
  if (platform !== 'darwin') {
    return { reason: 'not-darwin', status: 'skipped' }
  }

  if (!macIconsStale({ root })) {
    return { reason: 'fresh', status: 'skipped' }
  }

  const result = generateMacIcons({ root, log })

  return { reason: 'regenerated', status: 'regenerated', ...result }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  if (process.argv.includes('--check')) {
    process.exitCode = macIconsStale({}) ? 1 : 0

    if (process.exitCode === 1) {
      console.error('[mac-icon] assets/icon-mac.{png,icns} are stale relative to icon-mac.svg — run the generator')
    }
  } else {
    try {
      generateMacIcons({})
    } catch (error) {
      console.error(`[mac-icon] ${error.message}`)
      process.exitCode = 1
    }
  }
}

export { ensureMacIconsFresh, generateMacIcons, macIconsStale, macIconToolchainProblem }
