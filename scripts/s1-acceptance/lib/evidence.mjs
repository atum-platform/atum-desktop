// Evidence for the S1 acceptance drivers (scripts/s1-acceptance, harness tier H3, and the H2 harness
// in packages/cloud-controller/e2e): a private JSON file of checks and measurements, never a token,
// key, presigned link or message body. A value registered as a secret can never be written into the
// evidence: recording one throws, so a driver that leaks fails instead of saving the leak.
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Reads a private input file (a token, a credential): a regular 0600 file, no symlink, bounded. */
export function readSecretFile(file, maximum = 16 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maximum) throw new Error(`${file} is not a small regular file`)
    if ((info.mode & 0o077) !== 0) throw new Error(`${file} is readable by others: chmod 600 it`)
    const value = readFileSync(fd, 'utf8').trim()
    if (!value) throw new Error(`${file} is empty`)
    return value
  } finally {
    closeSync(fd)
  }
}

export class Evidence {
  /** @param {string} file @param {Record<string, unknown>} meta */
  constructor(file, meta) {
    this.file = file
    this.secrets = new Set()
    this.value = { ...meta, startedAt: new Date().toISOString(), passed: false, checks: [], measurements: {} }
    if (file) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  }

  /** Registers a value that must never appear in the evidence (or the printed lines). */
  secret(value) {
    if (typeof value === 'string' && value.length >= 8) this.secrets.add(value)
    return value
  }

  /** Throws when TEXT carries a registered secret. */
  guard(text) {
    for (const secret of this.secrets) {
      if (text.includes(secret)) throw new Error('refusing to record a secret in the evidence')
    }
    return text
  }

  check(name, ok, details = {}) {
    const entry = { name, ok: Boolean(ok), ...details }
    this.guard(JSON.stringify(entry))
    this.value.checks.push(entry)
    console.log(this.guard(`${ok ? 'PASS' : 'FAIL'} ${name}${details.note ? ` (${details.note})` : ''}`))
    this.save()
    return Boolean(ok)
  }

  measure(name, value) {
    this.guard(JSON.stringify(value))
    this.value.measurements[name] = value
    this.save()
  }

  /** Marks the run passed iff every check passed (and there was at least one). */
  finish(extra = {}) {
    this.value.finishedAt = new Date().toISOString()
    Object.assign(this.value, extra)
    this.value.passed = this.value.checks.length > 0 && this.value.checks.every(check => check.ok)
    this.save()
    return this.value.passed
  }

  save() {
    if (!this.file) return
    const text = this.guard(`${JSON.stringify(this.value, null, 2)}\n`)
    writeFileSync(this.file, text, { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}

/** Polls TEST until it answers truthy or the deadline passes. Returns the truthy value or null. */
export async function until(test, { timeoutMs = 60_000, intervalMs = 1_000, now = Date.now, sleep } = {}) {
  const wait = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    const value = await test()
    if (value) return value
    if (now() >= deadline) return null
    await wait(intervalMs)
  }
}

/** Percentiles of a list of numbers (nearest-rank), rounded to the millisecond. */
export function percentiles(values, wanted = [50, 95]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  const result = { n: sorted.length }
  for (const p of wanted) {
    result[`p${p}`] = sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]) : null
  }
  return result
}

/** Parses `--name value` and `--flag` arguments against an allowed set. */
export function parseArguments(argv, { values = [], flags = [] }) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (flags.includes(name)) result[name] = true
    else if (values.includes(name)) {
      if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`)
      result[name] = argv[++i]
    } else throw new Error(`unknown option --${name}`)
  }
  return result
}
