import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENGINE_EXCLUSIONS_REF = 'drive-engine-0.18'
export const ENGINE_EXCLUSIONS_COMMIT = '7f3037af2a159e5f19e1eea9aac0fb96f209e117'
const cppPath = 'src/libsync/csync_exclude.cpp'
const listPath = 'src/resources/theme/universal/sync-exclude.lst'
const output = new URL('../apps/desktop/electron/matrix/drive-exclusions.json', import.meta.url)

// csync_exclude_expand_escapes expands these; other escapes survive to the glob translator.
export function expandEngineExclusionEscapes(line) {
  const escapes = {
    "'": "'",
    '"': '"',
    '?': '?',
    '#': '#',
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v'
  }
  return line.replace(/\\(.)/gu, (whole, next) => escapes[next] ?? whole)
}

export function generateDriveExclusions(cpp, list, commit = ENGINE_EXCLUSIONS_COMMIT) {
  const anchors = [...cpp.matchAll(/_atumExcludes\s*=\s*\{([\s\S]*?)\};/gu)]
  if (anchors.length !== 1) throw new Error('drive_exclusions_source_ambiguous')
  const literals = [...anchors[0][1].matchAll(/QStringLiteral\(("(?:\\.|[^"\\])*")\)/gu)]
  if (!literals.length || anchors[0][1].replace(/QStringLiteral\(("(?:\\.|[^"\\])*")\)/gu, '').replace(/[\s,]/gu, '')) {
    throw new Error('drive_exclusions_source_unsupported')
  }
  const atum = literals.map(match => JSON.parse(match[1]))
  const baseline = []
  for (const raw of list.split(/\r?\n/u)) {
    const line = raw.trim()
    // A future conditional needs an explicit version decision, never silent truncation.
    if (line.startsWith('#!version')) throw new Error('drive_exclusions_version_unsupported')
    if (!line || line.startsWith('#')) continue
    baseline.push(expandEngineExclusionEscapes(line))
  }
  const patterns = [...new Set([...baseline, ...atum])]
  if (patterns.some(pattern => typeof pattern !== 'string' || !pattern || pattern.includes('\0'))) {
    throw new Error('drive_exclusions_source_invalid')
  }
  return {
    version: 1,
    engine: {
      ref: ENGINE_EXCLUSIONS_REF,
      commit,
      sources: {
        [cppPath]: createHash('sha256').update(cpp).digest('hex'),
        [listPath]: createHash('sha256').update(list).digest('hex')
      }
    },
    patterns,
    // Generated provenance, not a second maintained exclusion list.
    atumPatterns: atum
  }
}

export function snapshotDriveExclusions(engineRepo) {
  const commit = execFileSync('git', ['rev-parse', ENGINE_EXCLUSIONS_REF + '^{commit}'], {
    cwd: engineRepo,
    encoding: 'utf8'
  }).trim()
  if (commit !== ENGINE_EXCLUSIONS_COMMIT) throw new Error('drive_exclusions_pin_changed')
  const source = name =>
    execFileSync('git', ['show', commit + ':' + name], { cwd: engineRepo, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  return JSON.stringify(generateDriveExclusions(source(cppPath), source(listPath), commit), null, 2) + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if ((args.length !== 1 && args.length !== 2) || (args.length === 2 && args[1] !== '--check')) {
    throw new Error('Usage: node scripts/gen-drive-exclusions.mjs <engine-repo> [--check]')
  }
  const generated = snapshotDriveExclusions(resolve(args[0]))
  if (args[1] === '--check') {
    if (generated !== readFileSync(output, 'utf8')) throw new Error('drive_exclusions_snapshot_stale')
  } else {
    writeFileSync(output, generated)
  }
  process.stdout.write('DRIVE_EXCLUSIONS_VERIFIED\n')
}
