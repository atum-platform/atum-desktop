import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const patch = fileURLToPath(new URL('../vendor/t3-updates/patches/electron-updater-6.8.9.patch', import.meta.url))
const blob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

export function patchElectronUpdater() {
  const manifest = require.resolve('electron-updater/package.json')
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== '6.8.9') {
    throw new Error('Expected electron-updater 6.8.9.')
  }
  const root = path.dirname(manifest)
  const entries = [...readFileSync(patch, 'utf8').matchAll(
    /^diff --git a\/(out\/\S+) b\/\1\nindex ([a-f0-9]{40})\.\.([a-f0-9]{40}) /gm
  )]
  if (entries.length !== 2) {throw new Error('Unexpected updater patch paths.')}
  const hashes = entries.map(([, file]) => blob(readFileSync(path.join(root, file))))

  if (entries.every(([, , , expected], i) => hashes[i] === expected)) {return}
  if (!entries.every(([, , expected], i) => hashes[i] === expected)) {
    throw new Error('Unexpected electron-updater input; reinstall from the lock before building.')
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'atum-updater-patch-'))
  try {
    for (const [, file] of entries) {
      mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true })
      copyFileSync(path.join(root, file), path.join(scratch, file))
    }
    execFileSync('git', ['apply', patch], { cwd: scratch })
    for (const [, file, , expected] of entries) {
      if (blob(readFileSync(path.join(scratch, file))) !== expected) {
        throw new Error(`Updater patch output mismatch for ${file}.`)
      }
    }
    for (const [, file] of entries) {copyFileSync(path.join(scratch, file), path.join(root, file))}
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {patchElectronUpdater()}
