#!/usr/bin/env node
// Vendors T3 Code's design layer into packages/atum-kit/t3/upstream/, byte for byte, from one pinned
// upstream release (owner 2026-11-24, option B: T3's design system is the Atum Kit base).
//
//   node scripts/sync-t3-design.mjs          fetch the pinned files (network) and rewrite t3/PIN.json
//   node scripts/sync-t3-design.mjs --check  offline: fail unless t3/ holds exactly the pinned files
//
// Files come from the commit the tag names, never a branch, so a re-sync is reproducible. To move the
// pin (for example to v0.1.12 when it ships stable), change TAG and COMMIT, run the sync, rebuild the
// Kit and review the diff. T3 Code is MIT (t3/upstream/LICENSE); the notice is t3/THIRD-PARTY.md and
// apps/desktop/third-party/app-components.json (id t3code-design-system).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'pingdotgg/t3code'
export const TAG = 'v0.1.11'
export const COMMIT = '59651c1761f6c63e9b6056839067066968e6a406'

/** What the Kit takes from T3: tokens and glass (index.css), the theme roles, the composer and controls. */
export const FILES = [
  'LICENSE',
  'apps/web/src/index.css',
  'apps/web/src/themePalette.ts',
  'apps/web/src/appearanceContrast.ts',
  'apps/web/src/panelAnimations.ts',
  'apps/web/src/components/chat/ComposerSurface.tsx',
  'apps/web/src/components/ui/button.tsx',
  'apps/web/src/components/ui/menu.tsx',
  'apps/web/src/components/ui/dialog.tsx'
]

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const T3_DIR = join(PACKAGE, 't3')
export const UPSTREAM = join(T3_DIR, 'upstream')
const PIN_FILE = join(T3_DIR, 'PIN.json')

const sha256 = text => createHash('sha256').update(text).digest('hex')

export async function readPin() {
  return JSON.parse(await readFile(PIN_FILE, 'utf8'))
}

/** Reads one vendored upstream file (a path from FILES). */
export async function readUpstream(path) {
  if (!FILES.includes(path)) {
    throw new Error(`${path} is not a vendored T3 file`)
  }

  return readFile(join(UPSTREAM, path), 'utf8')
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  })

  const nested = await Promise.all(
    entries.map(entry => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]))
  )

  return nested.flat()
}

export async function check() {
  const pin = await readPin()
  const problems = []

  if (pin.repository !== REPOSITORY || pin.tag !== TAG || pin.commit !== COMMIT) {
    problems.push(
      `t3/PIN.json names ${pin.repository}@${pin.tag} (${pin.commit}); the script pins ${REPOSITORY}@${TAG} (${COMMIT})`
    )
  }

  const pinned = Object.keys(pin.files ?? {}).sort()

  if (JSON.stringify(pinned) !== JSON.stringify([...FILES].sort())) {
    problems.push('t3/PIN.json does not list exactly the files the script vendors')
  }

  for (const path of FILES) {
    const text = await readFile(join(UPSTREAM, path)).catch(() => null)

    if (!text) {
      problems.push(`missing t3/upstream/${path}`)
    } else if (sha256(text) !== pin.files?.[path]) {
      problems.push(`t3/upstream/${path} differs from ${TAG}`)
    }
  }

  const extra = (await listFiles(UPSTREAM)).map(file => relative(UPSTREAM, file)).filter(file => !FILES.includes(file))

  for (const file of extra) {
    problems.push(`t3/upstream/${file} is not a pinned file`)
  }

  if (problems.length) {
    throw new Error(
      `T3 design files are stale:\n  ${problems.join('\n  ')}\nRun node packages/atum-kit/scripts/sync-t3-design.mjs`
    )
  }
}

export async function sync() {
  const tagged = execFileSync('git', ['ls-remote', `https://github.com/${REPOSITORY}.git`, `refs/tags/${TAG}`], {
    encoding: 'utf8'
  })
    .trim()
    .split(/\s+/)[0]

  if (tagged !== COMMIT) {
    throw new Error(`${REPOSITORY} ${TAG} is ${tagged || 'missing'}, not ${COMMIT}; update COMMIT deliberately`)
  }

  await rm(UPSTREAM, { recursive: true, force: true })
  const files = {}

  for (const path of FILES) {
    const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/${path}`)

    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`)
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    await mkdir(dirname(join(UPSTREAM, path)), { recursive: true })
    await writeFile(join(UPSTREAM, path), bytes)
    files[path] = sha256(bytes)
  }

  const pin = { repository: REPOSITORY, tag: TAG, commit: COMMIT, license: 'MIT', files }
  await writeFile(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ;(process.argv.includes('--check') ? check() : sync()).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
