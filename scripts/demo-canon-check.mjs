#!/usr/bin/env node
/**
 * demo-canon-check.mjs — the app-side half of the stage preflight.
 *
 * The platform repo owns the plane/stage probes
 * (`atum-platform/scripts/demo/preflight.mjs`). Those probes cannot see the
 * three things that are only knowable from inside THIS repo and the installed
 * bundle:
 *
 *   installed-is-canon  the app in /Applications was built from the tip of the
 *                       canonical branch — not from a stale local pack, not
 *                       from a feature branch someone forgot to switch off.
 *   managed-model-pinned that bundle's baked copilot default is
 *                       binh-minh, so the demo draws on the managed Atum edge
 *                       rather than requiring a user-supplied provider key.
 *   google-auth-enabled that bundle bakes the public production Google sign-in
 *                       capability required for the minimal Moon-user path.
 *   installed-is-signed the installed bundle carries a valid, non-adhoc
 *                       Developer ID code signature (open-demo R-2: strangers'
 *                       Macs must not hit Gatekeeper walls).
 *   installed-is-notarized the bundle has a stapled notarization ticket, so
 *                       Gatekeeper accepts it offline on a Mac that has never
 *                       seen the app.
 *
 * Output format is deliberately identical to the platform preflight — one line
 * per probe, one summary line, exit 0 for GO and 1 for NO-GO:
 *
 *   PASS  <name> — <detail>
 *   FAIL  <name> — <detail>
 *   SKIP  <name> — <detail>
 *   ...
 *   CANON GO   |   CANON NO-GO (n failures)
 *
 * SKIP never fails the run: a skipped probe is one whose subject is absent
 * (no app installed on this Mac), which is a different statement from "the
 * installed app is wrong".
 *
 * Every probe takes its I/O through the injected context (`env`, `readFile`,
 * `exec`), so the unit tests exercise each one with fakes and never touch the
 * network or /Applications.
 *
 * Environment:
 *   ATUM_CANON_APP_PATH   installed bundle (default /Applications/Atum.app)
 *   ATUM_CANON_REMOTE     git remote to resolve (default origin)
 *   ATUM_CANON_BRANCH     canonical branch (default atum-main)
 *   ATUM_CANON_TIMEOUT_MS per-attempt ls-remote timeout (default 30000;
 *                         one retry is always attempted)
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { ATUM_PINNED_DEFAULT_MODEL, ATUM_PROD_PLANE } from '../apps/desktop/scripts/atum-product-defaults.mjs'

const execFileAsync = promisify(execFile)

export const RESULT = Object.freeze({ pass: 'pass', fail: 'fail', skip: 'skip' })

const LABEL = Object.freeze({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP' })

export const DEFAULT_TIMEOUT_MS = 30_000
export const CANON_RETRY_COUNT = 1
export const DEFAULT_APP_PATH = '/Applications/Atum.app'
export const DEFAULT_REMOTE = 'origin'
export const DEFAULT_BRANCH = 'atum-main'

const pass = detail => ({ ok: RESULT.pass, detail })
const fail = detail => ({ ok: RESULT.fail, detail })
const skip = detail => ({ ok: RESULT.skip, detail })

function readEnv(env, name, fallback = '') {
  const raw = env?.[name]

  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
}

function describeError(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

function positiveIntegerEnv(env, name, fallback) {
  const raw = readEnv(env, name)
  const value = Number(raw)

  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function resourcePath(context, basename) {
  return path.join(readEnv(context.env, 'ATUM_CANON_APP_PATH', DEFAULT_APP_PATH), 'Contents', 'Resources', basename)
}

/**
 * Read a JSON resource out of the installed bundle. Returns
 * `{ found, value, error }`. Callers decide whether a missing resource means
 * the app is absent or an installed bundle is incomplete.
 */
function readBundleJson(context, filePath) {
  let text

  try {
    text = context.readFile(filePath)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null

    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { found: false, value: null, error: null }
    }

    return { found: true, value: null, error: describeError(error) }
  }

  try {
    return { found: true, value: JSON.parse(text), error: null }
  } catch (error) {
    return { found: true, value: null, error: `not valid JSON (${describeError(error)})` }
  }
}

function missingPublicConfigResult(context, configPath, absentDetail) {
  const stamp = readBundleJson(context, resourcePath(context, 'install-stamp.json'))

  if (!stamp.found) {
    return skip(absentDetail)
  }

  return fail(`${configPath} is missing from the installed app — reinstall from a production package`)
}

/** First field of the matching `git ls-remote` line, or null. */
export function parseLsRemote(output) {
  for (const line of String(output ?? '').split('\n')) {
    const sha = line.trim().split(/\s+/)[0]

    if (/^[0-9a-f]{40}$/i.test(sha)) {
      return sha.toLowerCase()
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Probes, in run order.
// ---------------------------------------------------------------------------

export const installedIsCanonProbe = {
  name: 'installed-is-canon',
  async run(context) {
    const appPath = readEnv(context.env, 'ATUM_CANON_APP_PATH', DEFAULT_APP_PATH)
    const remote = readEnv(context.env, 'ATUM_CANON_REMOTE', DEFAULT_REMOTE)
    const branch = readEnv(context.env, 'ATUM_CANON_BRANCH', DEFAULT_BRANCH)
    const stampPath = path.join(appPath, 'Contents', 'Resources', 'install-stamp.json')
    const stamp = readBundleJson(context, stampPath)

    if (!stamp.found) {
      return fail(`no app at ${appPath} — install the canonical production package`)
    }

    if (stamp.error) {
      return fail(`${stampPath} ${stamp.error}`)
    }

    const installed = String(stamp.value?.commit ?? '')
      .trim()
      .toLowerCase()

    if (!/^[0-9a-f]{40}$/.test(installed)) {
      return fail(`install-stamp.json has no usable commit (${JSON.stringify(stamp.value?.commit ?? null)})`)
    }

    if (/^0+$/.test(installed)) {
      return fail('installed build carries the all-zero fallback commit — it was packed outside a git checkout')
    }

    const timeoutMs = positiveIntegerEnv(context.env, 'ATUM_CANON_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
    let canonical = null
    let lastError = null

    for (let attempt = 0; attempt <= CANON_RETRY_COUNT; attempt += 1) {
      try {
        canonical = parseLsRemote(await context.exec('git', ['ls-remote', remote, branch], { timeoutMs }))
        if (canonical) break
        lastError = new Error('resolved no commit')
      } catch (error) {
        lastError = error
      }
    }

    if (!canonical) {
      return fail(
        `canon unreachable: git ls-remote ${remote} ${branch} failed after 2 attempts ` +
          `(${timeoutMs}ms each; ${describeError(lastError)})`
      )
    }

    if (installed !== canonical) {
      return fail(
        `canon differs: installed ${installed.slice(0, 12)} != ${remote}/${branch} ${canonical.slice(0, 12)} — reinstall from canon`
      )
    }

    if (stamp.value?.dirty === true) {
      return fail(`installed ${installed.slice(0, 12)} matches canon but was packed from a DIRTY tree`)
    }

    return pass(`installed ${installed.slice(0, 12)} == ${remote}/${branch}`)
  }
}

export const managedModelPinnedProbe = {
  name: 'managed-model-pinned',
  run(context) {
    // Repo canon first: whatever is installed, the branch we would reinstall
    // from must still pin the managed alias. A drifted constant is a failure
    // even when no app is present on this Mac.
    if (ATUM_PINNED_DEFAULT_MODEL !== 'binh-minh') {
      return fail(`repo canon pins ${ATUM_PINNED_DEFAULT_MODEL}, not binh-minh`)
    }

    const configPath = resourcePath(context, 'atum-public-config.json')
    const config = readBundleJson(context, configPath)

    if (!config.found) {
      return missingPublicConfigResult(
        context,
        configPath,
        `repo canon pins ${ATUM_PINNED_DEFAULT_MODEL}; no installed app to confirm the baked value`
      )
    }

    if (config.error) {
      return fail(`${configPath} ${config.error}`)
    }

    const baked = String(config.value?.defaultModel ?? '').trim()

    if (!baked) {
      return fail('installed app bakes no defaultModel — it will fall through to the engine silent default')
    }

    if (baked !== ATUM_PINNED_DEFAULT_MODEL) {
      return fail(`installed app bakes ${baked}, not ${ATUM_PINNED_DEFAULT_MODEL}`)
    }

    return pass(`installed app bakes ${baked}`)
  }
}

export const googleAuthEnabledProbe = {
  name: 'google-auth-enabled',
  run(context) {
    if (ATUM_PROD_PLANE.ATUM_PUBLIC_GOOGLE_AUTH_ENABLED !== 'true') {
      return fail('repo canon does not require Google authentication for production packages')
    }

    const configPath = resourcePath(context, 'atum-public-config.json')
    const config = readBundleJson(context, configPath)

    if (!config.found) {
      return missingPublicConfigResult(
        context,
        configPath,
        'repo canon requires Google authentication; no installed app to confirm the baked value'
      )
    }

    if (config.error) {
      return fail(`${configPath} ${config.error}`)
    }

    if (config.value?.providers?.google !== true) {
      return fail('installed app does not bake providers.google=true — reinstall from a production package')
    }

    return pass('installed app bakes providers.google=true')
  }
}

export const EXPECTED_MANAGED_CATALOG = Object.freeze([
  Object.freeze({ id: 'binh-minh', label: 'Bình Minh 1.1' }),
  Object.freeze({ id: 'nguyet-thuc', label: 'Nguyệt Thực 1.0' }),
  Object.freeze({ id: 'nhat-thuc', label: 'Nhật Thực 1.0' })
])

function defaultManagedCatalog(context) {
  const proxy = context.readRepoFile('apps/desktop/electron/atum-managed-model-proxy.ts')
  const labels = context.readRepoFile('apps/desktop/src/lib/model-status-label.ts')
  const ids = [...proxy.matchAll(/['"](binh-minh|nguyet-thuc|nhat-thuc)['"]/g)].map(match => match[1])
  const uniqueIds = [...new Set(ids)]

  return uniqueIds.map(id => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = labels.match(new RegExp(`['"]${escaped}['"]\\s*:\\s*['"]([^'"]+)['"]`))
    return { id, label: match?.[1] ?? '' }
  })
}

export const managedCatalogProbe = {
  name: 'managed-catalog-exact',
  run(context) {
    const actual = context.managedCatalog ?? defaultManagedCatalog(context)
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_MANAGED_CATALOG)) {
      return fail(
        `managed catalog is ${JSON.stringify(actual)}, expected ${JSON.stringify(EXPECTED_MANAGED_CATALOG)}`
      )
    }
    return pass(actual.map(model => model.label).join(' / '))
  }
}

export const nhatThucDisabledProbe = {
  name: 'nhat-thuc-selection-disabled',
  run(context) {
    const disabled =
      context.nhatThucDisabled ??
      (() => {
        const source = context.readRepoFile('apps/desktop/src/lib/atum-managed-model-access.ts')
        return /TEMPORARILY_UNAVAILABLE_MANAGED_MODELS\s*=\s*new Set\(\[['"]nhat-thuc['"]\]\)/.test(source)
      })()
    return disabled
      ? pass('Nhật Thực 1.0 remains visible but cannot be selected')
      : fail('Nhật Thực selection is not disabled in the client')
  }
}

function installedAppPath(context) {
  return readEnv(context.env, 'ATUM_CANON_APP_PATH', DEFAULT_APP_PATH)
}

function appAbsent(context) {
  return !readBundleJson(context, resourcePath(context, 'install-stamp.json')).found
}

export const installedIsSignedProbe = {
  name: 'installed-is-signed',
  async run(context) {
    const appPath = installedAppPath(context)

    if (appAbsent(context)) {
      return skip(`no app at ${appPath} — installed-is-canon already carries the absence failure`)
    }

    const timeoutMs = positiveIntegerEnv(context.env, 'ATUM_CANON_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)

    try {
      await context.exec('codesign', ['--verify', '--deep', '--strict', appPath], { timeoutMs })
    } catch (error) {
      return fail(`code signature invalid (${describeError(error)}) — repack with the Developer ID identity`)
    }

    let display

    try {
      display = await context.exec('codesign', ['--display', '--verbose=2', appPath], {
        timeoutMs,
        includeStderr: true
      })
    } catch (error) {
      return fail(`codesign --display failed (${describeError(error)})`)
    }

    if (/Signature\s*=\s*adhoc/.test(display)) {
      return fail('bundle is adhoc-signed — strangers\u2019 Macs will refuse it; sign with Developer ID')
    }

    const authority = display.match(/Authority=(Developer ID Application[^\n]*)/)

    if (!authority) {
      return fail('signature carries no Developer ID Application authority — sign with the distribution identity')
    }

    return pass(`valid signature by ${authority[1].trim()}`)
  }
}

export const installedIsNotarizedProbe = {
  name: 'installed-is-notarized',
  async run(context) {
    const appPath = installedAppPath(context)

    if (appAbsent(context)) {
      return skip(`no app at ${appPath} — installed-is-canon already carries the absence failure`)
    }

    const timeoutMs = positiveIntegerEnv(context.env, 'ATUM_CANON_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)

    // A STAPLED ticket is the requirement: the demo posture is a stranger's
    // Mac that may be offline, where Gatekeeper cannot phone home.
    try {
      await context.exec('xcrun', ['stapler', 'validate', appPath], { timeoutMs, includeStderr: true })
    } catch (error) {
      return fail(`no stapled notarization ticket (${describeError(error)}) — notarize and staple before the demo`)
    }

    return pass('stapled notarization ticket validates')
  }
}

/** Probes in run order. */
export const probes = Object.freeze([
  installedIsCanonProbe,
  managedModelPinnedProbe,
  googleAuthEnabledProbe,
  managedCatalogProbe,
  nhatThucDisabledProbe,
  installedIsSignedProbe,
  installedIsNotarizedProbe
])

export function formatLine(name, result) {
  return `${LABEL[result.ok]} ${name} — ${result.detail}`
}

export function formatSummary(failures) {
  return failures === 0 ? 'CANON GO' : `CANON NO-GO (${failures} failures)`
}

/**
 * Default command runner: resolves with stdout, rejects on non-zero exit.
 * `includeStderr` appends stderr — codesign(1) writes its display output there.
 */
export async function defaultExec(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, includeStderr = false } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 })

  return includeStderr ? `${stdout}${stderr}` : stdout
}

/**
 * Runs the probes sequentially. Returns `{ failures, lines, exitCode }`.
 * A probe that throws is a failure, never a crash.
 */
export async function runCanonCheck({
  probeList = probes,
  context = {},
  write = (/** @type {string} */ _line) => {}
} = {}) {
  const resolvedContext = {
    env: context.env ?? process.env,
    exec: context.exec ?? defaultExec,
    readFile: context.readFile ?? (filePath => readFileSync(filePath, 'utf8')),
    readRepoFile:
      context.readRepoFile ?? (filePath => readFileSync(path.resolve(import.meta.dirname, '..', filePath), 'utf8')),
    managedCatalog: context.managedCatalog,
    nhatThucDisabled: context.nhatThucDisabled
  }

  const lines = []
  let failures = 0

  for (const probe of probeList) {
    let result

    try {
      result = await probe.run(resolvedContext)
    } catch (error) {
      result = fail(`probe threw (${describeError(error)})`)
    }

    if (!result || !(result.ok in LABEL)) {
      result = fail('probe returned an unusable result')
    }

    if (result.ok === RESULT.fail) {
      failures += 1
    }

    const line = formatLine(probe.name, result)

    lines.push(line)
    write(line)
  }

  const summary = formatSummary(failures)

  lines.push(summary)
  write(summary)

  return { failures, lines, exitCode: failures === 0 ? 0 : 1 }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const { exitCode } = await runCanonCheck({
    write: line => process.stdout.write(`${line}\n`)
  })

  process.exitCode = exitCode
}
