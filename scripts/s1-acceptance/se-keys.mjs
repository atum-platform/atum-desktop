#!/usr/bin/env node
// S1 WS-3b real-Mac check of the device service's Secure Enclave keys (build plan §4 WS-3
// "A real-Mac script, scripts/s1-acceptance/se-keys.mjs, for the Secure Enclave paths").
//
// Not a CI test: it needs a Mac with a Secure Enclave and, for the approval legs, a person at it.
// It drives the SHIPPING wrapper (apps/desktop/electron/matrix/device/device-key.ts) against the
// real helper (apps/desktop/native/atum-device-key), so what passes here is what the app runs.
//
//   identity key   create, reload from the wrapped blobs (0600 in a 0700 directory), sign a Hello
//                  and an origin assertion with no prompt; Node verifies ES256 like DA and the hub.
//   approval key   (1) the owner approves: Touch ID on a Mac with it, the macOS password dialog on
//                  one without (the Mac mini, owner decision Q4) — the signature must verify;
//                  (2) nobody touches it: no signature, ever (optionally while CuaDriver clicks and
//                  types at the sheet: --attack); (3) right after a real approval, a second one
//                  is NOT satisfied by it (reuse window 0, G0 finding F2).
//
// Usage (from the repo root; Node 23.6+):
//   node --experimental-transform-types scripts/s1-acceptance/se-keys.mjs            # full, attended
//   node --experimental-transform-types scripts/s1-acceptance/se-keys.mjs --unattended
//   ... --helper "/Applications/Atum Matrix Candidate.app/Contents/Resources/app.asar.unpacked/atum-device-key"
//   ... --attack            # drive CuaDriver at the sheet during the no-touch leg (needs cua-driver)
//   ... --identity-only     # no approval prompt at all (identity key legs only)
//   ... --json              # also print a machine-readable summary
//
// Without --helper it compiles the helper into a temporary folder and signs it ad hoc (never with
// the Developer ID). Every key it makes lives in a temporary key directory and is deleted at the end.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

if (process.platform !== 'darwin') {
  console.error('se-keys: macOS only (the Secure Enclave helper).')
  process.exit(1)
}

// The device-key module is TypeScript with parameter properties: run under type transformation.
let device

try {
  device = await import(pathToFileURL(path.join(repo, 'apps/desktop/electron/matrix/device/device-key.ts')).href)
} catch (error) {
  if (!process.env.ATUM_SE_KEYS_REEXEC) {
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url), ...args], {
      stdio: 'inherit',
      env: { ...process.env, ATUM_SE_KEYS_REEXEC: '1' }
    })

    process.exit(child.status ?? 1)
  }

  console.error(`se-keys: cannot load device-key.ts (${error?.message ?? error}). Use Node 23.6+ with --experimental-transform-types.`)
  process.exit(1)
}

const { SecureEnclaveDeviceKeys, deviceSignedBytes, originSignedBytes, verifyDeviceSignature, DeviceKeyError } = device

const results = []
const record = (verdict, label, detail = '') => {
  results.push({ verdict, label, detail })
  console.log(`  [${verdict}] ${label}${detail ? ` ${detail}` : ''}`)
}

const read = (command, commandArgs) => {
  try {
    return execFileSync(command, commandArgs, { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ host facts

const biometrics = /Effective biometrics for unlock:\s*1/.test(read('/usr/bin/bioutil', ['-r']))
const facts = {
  macOS: read('/usr/bin/sw_vers', ['-productVersion']),
  build: read('/usr/bin/sw_vers', ['-buildVersion']),
  model: read('/usr/sbin/sysctl', ['-n', 'hw.model']),
  chip: read('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
  computer: read('/usr/sbin/scutil', ['--get', 'ComputerName']),
  touchId: biometrics,
  approvalPrompt: biometrics ? 'Touch ID' : 'macOS password dialog'
}

console.log('se-keys: Secure Enclave device keys on this Mac')
for (const [key, value] of Object.entries(facts)) console.log(`  ${key}: ${value}`)

// ------------------------------------------------------------------ the helper

const work = mkdtempSync(path.join(tmpdir(), 'atum-se-keys-'))
let helper = option('--helper')

if (helper) {
  const signing = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', helper], { encoding: 'utf8' }).stderr ?? ''
  const developerId = /Authority=Developer ID Application/.test(signing)
  const hardened = /flags=.*runtime/.test(signing)
  record(developerId && hardened ? 'PASS' : 'INFO', 'shipping helper signature', `(developer id: ${developerId}, hardened runtime: ${hardened})`)
} else {
  helper = path.join(work, 'atum-device-key')
  const { stageAtumDeviceKey } = await import(pathToFileURL(path.join(repo, 'apps/desktop/scripts/stage-atum-device-key.mjs')).href)
  stageAtumDeviceKey({ output: helper })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', helper])
  record('INFO', 'helper built and signed ad hoc', helper)
}

const keyDir = path.join(work, 'keys')
const keys = new SecureEnclaveDeviceKeys({ binary: helper, keyDir, approvalMs: Number(option('--approval-seconds') ?? 60) * 1000 })

// ------------------------------------------------------------------ identity key: no prompt

try {
  const pub = await keys.publicKeys()
  const reloaded = await new SecureEnclaveDeviceKeys({ binary: helper, keyDir }).existingKeys()
  const blobMode = statSync(path.join(keyDir, 'identity.key')).mode & 0o777
  const dirMode = statSync(keyDir).mode & 0o777

  record(
    reloaded?.identity.kid === pub.identity.kid && reloaded?.approval.kid === pub.approval.kid && blobMode === 0o600 && dirMode === 0o700
      ? 'PASS'
      : 'FAIL',
    'create and reload both keys from their wrapped blobs',
    `(identity ${pub.identity.kid.slice(0, 8)}…, approval ${pub.approval.kid.slice(0, 8)}…, blob ${blobMode.toString(8)}, dir ${dirMode.toString(8)})`
  )

  const hello = deviceSignedBytes('Hello', { deviceServiceId: '00000000-0000-4000-8000-000000000000', sentAt: Date.now() })
  const started = performance.now()
  const signature = await keys.signIdentity(hello)
  const ms = Math.round(performance.now() - started)

  record(
    verifyDeviceSignature(pub.identity.spki, hello, signature.sig) ? 'PASS' : 'FAIL',
    'identity key signs a Hello with no prompt; ES256 verifies in Node',
    `(${ms} ms)`
  )

  const origin = originSignedBytes({ v: 1, dg: 'x'.repeat(43), t: Date.now() })
  const originSignature = await keys.signIdentity(origin)
  record(
    verifyDeviceSignature(pub.identity.spki, origin, originSignature.sig) &&
      !verifyDeviceSignature(pub.identity.spki, hello, originSignature.sig)
      ? 'PASS'
      : 'FAIL',
    'identity key signs an origin assertion under its own domain'
  )

  // ------------------------------------------------------------------ approval key

  if (flag('--identity-only')) {
    await keys.discard()
    record('INFO', 'approval legs skipped (--identity-only); test keys deleted')
    throw new Error('done')
  }

  const approvalBytes = deviceSignedBytes('EnrollDevice', { test: 'se-keys', at: Date.now() })

  const attempt = async (reason, seconds) => {
    const short = new SecureEnclaveDeviceKeys({ binary: helper, keyDir, approvalMs: seconds * 1000 })

    try {
      return { signature: await short.approve(approvalBytes, reason) }
    } catch (error) {
      return { error: error instanceof DeviceKeyError ? error.code : String(error) }
    }
  }

  const realPresenceSince = since => {
    const log = read('/usr/bin/log', [
      'show',
      '--start',
      since,
      '--style',
      'compact',
      '--predicate',
      'process == "coreauthd" OR process == "biometrickitd" OR subsystem == "com.apple.LocalAuthentication"'
    ])

    // A real finger: coreauthd's "MechanismTouchId[…] has matched" and biometrickitd's match result
    // (macOS 26; older releases logged "finger-off"). A real password: its mechanism succeeding.
    return /MechanismTouchId\[\d+\][^\n]*has matched|matchEventMessage:[^\n]*\.result:1|finger-off|MechanismUserPassword[^\n]*(entered|success|finished with No error)/i.test(
      log
    )
  }

  const timestamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

  if (!flag('--unattended')) {
    console.log(`\n  >>> Approve the prompt now with ${facts.approvalPrompt} (60 s).`)
    const approved = await attempt('test the Atum approval prompt (se-keys, approve this one)', 60)

    record(
      approved.signature && verifyDeviceSignature(pub.approval.spki, approvalBytes, approved.signature.sig) ? 'PASS' : 'FAIL',
      `approval with ${facts.approvalPrompt} signs, and the signature verifies`,
      approved.error ? `(${approved.error})` : ''
    )

    if (approved.signature) {
      console.log('\n  >>> A second prompt follows. Do NOT touch it: it must time out (no reuse of the last approval).')
      const since = timestamp()
      const reused = await attempt('test the Atum approval prompt (se-keys, do NOT approve)', 15)

      record(
        !reused.signature ? 'PASS' : realPresenceSince(since) ? 'SKIP' : 'FAIL',
        'an approval right after another is not satisfied by it (reuse window 0)',
        reused.signature ? '(signed: was the sensor touched?)' : `(${reused.error})`
      )
    }
  }

  console.log(`\n  >>> A prompt appears for 15 s. Nobody should touch it${flag('--attack') ? ' (CuaDriver will click and type at it)' : ''}.`)
  const since = timestamp()
  let attacker

  if (flag('--attack') && read('/usr/bin/which', ['cua-driver'])) {
    attacker = spawn(
      '/bin/sh',
      [
        '-c',
        'for i in 1 2 3 4 5 6; do sleep 2; cua-driver call click \'{"x":717,"y":450}\' >/dev/null 2>&1; cua-driver call type_text \'{"text":"not-the-password"}\' >/dev/null 2>&1; cua-driver call press_key \'{"key":"return"}\' >/dev/null 2>&1; done'
      ],
      { stdio: 'ignore' }
    )
  }

  const untouched = await attempt('test the Atum approval prompt (se-keys, nobody approves)', 15)
  attacker?.kill()

  record(
    !untouched.signature ? 'PASS' : realPresenceSince(since) ? 'SKIP' : 'FAIL',
    `no signature without a deliberate ${facts.approvalPrompt}${attacker ? ' (CuaDriver driving the sheet)' : ''}`,
    untouched.signature ? '(signed: a real touch or password in the logs means re-run unattended)' : `(${untouched.error})`
  )

  await keys.discard()
  record('INFO', 'test keys deleted')
} catch (error) {
  if (error?.message !== 'done') {
    record('FAIL', 'unexpected error', String(error?.message ?? error))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter(each => each.verdict === 'FAIL').length
const passed = results.filter(each => each.verdict === 'PASS').length
console.log(`\nse-keys: PASS=${passed} FAIL=${failed} on ${facts.computer || 'this Mac'} (${facts.approvalPrompt})`)

if (flag('--json')) {
  console.log(JSON.stringify({ facts, results }, null, 2))
}

process.exit(failed ? 1 : 0)
