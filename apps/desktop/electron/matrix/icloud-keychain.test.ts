import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MatrixICloudKeychain, matrixKeychainHelper, runMatrixKeychain } from './icloud-keychain'

const directories: string[] = []

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const ME = '@fixture-owner:atumplatform.com'
// A sample, never a real key.
const KEY = 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666'

/**
 * A stand-in for the Atum Keys helper (native/atum-keys): the same one-request protocol over
 * stdin, an item store in a file, and a record of its arguments and input.
 */
function fakeHelper(mode: 'normal' | 'unprovisioned' | 'garbled' | 'slow' = 'normal') {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-keys-fake-'))
  directories.push(directory)
  const helper = path.join(directory, 'atum-keys')
  const store = path.join(directory, 'items.json')
  const seen = path.join(directory, 'seen.json')
  writeFileSync(store, '{}')
  writeFileSync(
    helper,
    `#!${process.execPath}
const fs = require('fs')
const mode = ${JSON.stringify(mode)}
let input = ''
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), input }))
  if (mode === 'slow') return setTimeout(() => {}, 10000)
  if (mode === 'garbled') return process.stdout.write('not json')
  if (mode === 'unprovisioned') return process.stdout.write(JSON.stringify({ ok: false, code: 'unprovisioned' }))
  const request = JSON.parse(input)
  const items = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'))
  let answer = { ok: true }
  if (request.op === 'read') answer = request.account in items ? { ok: true, value: items[request.account] } : { ok: false, code: 'not_found' }
  if (request.op === 'write') items[request.account] = request.value
  if (request.op === 'remove') delete items[request.account]
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(items))
  process.stdout.write(JSON.stringify(answer))
})
`
  )
  chmodSync(helper, 0o755)

  return {
    helper,
    seen: () => JSON.parse(readFileSync(seen, 'utf8')) as { argv: string[]; input: string },
    items: () => JSON.parse(readFileSync(store, 'utf8')) as Record<string, string>
  }
}

describe('the recovery key in iCloud Keychain, through the Atum Keys helper', () => {
  it('finds the helper inside a packaged app', () => {
    expect(matrixKeychainHelper('/Applications/Atum.app/Contents/Resources')).toBe(
      '/Applications/Atum.app/Contents/Resources/atum-keys/Atum Keys.app/Contents/MacOS/atum-keys'
    )
  })

  it('keeps, reads and removes the key, handing it over on stdin only', async () => {
    const fake = fakeHelper()
    const keychain = new MatrixICloudKeychain({ helper: fake.helper })

    expect(await keychain.available()).toBe(true)
    expect(await keychain.read(ME)).toBeUndefined()
    expect(await keychain.write(ME, KEY, 'F_TEST_9bc29')).toBe(true)
    expect(fake.seen().argv).toEqual([])
    expect(JSON.parse(fake.seen().input)).toMatchObject({ op: 'write', account: ME })
    expect(JSON.parse(fake.items()[ME]!)).toEqual({ v: 1, key: KEY, keyId: 'F_TEST_9bc29' })
    expect(await keychain.read(ME)).toEqual({ key: KEY, keyId: 'F_TEST_9bc29' })
    expect(await keychain.remove(ME)).toBe(true)
    expect(await keychain.read(ME)).toBeUndefined()
  })

  it('is simply unavailable without the helper, or when its keychain group is not provisioned', async () => {
    expect(await new MatrixICloudKeychain({}).available()).toBe(false)
    expect(await new MatrixICloudKeychain({ helper: '/nowhere/atum-keys' }).available()).toBe(false)

    const lines: string[] = []

    const unprovisioned = new MatrixICloudKeychain({
      helper: fakeHelper('unprovisioned').helper,
      log: line => lines.push(line)
    })

    expect(await unprovisioned.available()).toBe(false)
    expect(await unprovisioned.read(ME)).toBeUndefined()
    expect(await unprovisioned.write(ME, KEY)).toBe(false)
    expect(lines).toEqual(['[Matrix] icloud keychain unavailable code=unprovisioned'])
  })

  it('never logs the key, and refuses to store what is not a key', async () => {
    const lines: string[] = []
    const keychain = new MatrixICloudKeychain({ helper: fakeHelper().helper, log: line => lines.push(line) })

    expect(await keychain.write(ME, 'not\na key')).toBe(false)
    await keychain.write(ME, KEY)
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('ignores an item that is not one of Atum’s', async () => {
    const fake = fakeHelper()
    const keychain = new MatrixICloudKeychain({ helper: fake.helper })
    await runMatrixKeychain(fake.helper, { op: 'write', account: ME, value: '{"v":2,"key":"x"}' })
    expect(await keychain.read(ME)).toBeUndefined()
  })

  it('treats a garbled or a stuck helper as unavailable, never as an answer', async () => {
    expect(await runMatrixKeychain(fakeHelper('garbled').helper, { op: 'probe' })).toEqual({
      ok: false,
      code: 'unavailable'
    })
    expect(await runMatrixKeychain(fakeHelper('slow').helper, { op: 'probe' }, 300)).toEqual({
      ok: false,
      code: 'unavailable'
    })
    expect(await runMatrixKeychain('/nowhere/atum-keys', { op: 'probe' })).toEqual({ ok: false, code: 'unavailable' })
  })
})

const swiftc = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0

/**
 * A stand-in caller: starts the program it is given as its own child (inheriting stdin and stdout)
 * and waits for it, or with --detach exits at once, so launchd adopts the child before it reads
 * its request. Signed ad hoc under a chosen identifier.
 */
const PARENT_C = `#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int detach = argc > 1 && strcmp(argv[1], "--detach") == 0;
  char **child_argv = argv + 1 + detach;
  if (!child_argv[0]) return 2;
  pid_t child = fork();
  if (child < 0) return 1;
  if (child == 0) {
    execv(child_argv[0], child_argv);
    _exit(127);
  }
  if (detach) return 0;
  int status = 0;
  if (waitpid(child, &status, 0) < 0) return 1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
`

/** Runs `command` with one request on its stdin and reads the helper's one answer. */
function ask(command: string[], request: unknown, options: { detached?: boolean } = {}) {
  if (options.detached) {
    // The request arrives a second after the caller has gone.
    const directory = mkdtempSync(path.join(tmpdir(), 'atum-keys-orphan-'))
    directories.push(directory)
    const input = path.join(directory, 'request.json')
    const output = path.join(directory, 'answer.json')
    writeFileSync(input, JSON.stringify(request))
    const quoted = command.map(part => `'${part.replaceAll("'", "'\\''")}'`).join(' ')
    spawnSync('/bin/sh', ['-c', `(sleep 1; cat '${input}') | ${quoted} > '${output}'`])

    for (let i = 0; i < 100; i++) {
      const answer = readFileSync(output, 'utf8')

      if (answer) {
        return JSON.parse(answer) as unknown
      }

      spawnSync('/bin/sleep', ['0.1'])
    }

    throw new Error('no answer from the adopted helper')
  }

  const result = spawnSync(command[0]!, command.slice(1), { input: JSON.stringify(request), encoding: 'utf8' })

  return JSON.parse(result.stdout) as unknown
}

// The real helper, built here and signed ad hoc: no provisioning profile, so the keychain refuses
// its access group, exactly as a build without the profile would. Proves the Swift side of the
// protocol (and that it never needs the key as an argument), and that it hands the key to nobody
// but Atum: the process that ran it must meet Atum's signing requirement (team 7D5FC62RXD,
// identifier com.atum.matrix-candidate). A test build of the same source (ATUM_KEYS_CALLER_TEST)
// trusts an ad-hoc signed stand-in instead, so the check is shown letting the right caller through
// as well as refusing the rest.
describe.runIf(swiftc)('the real Atum Keys helper, without a provisioning profile', () => {
  let executable = ''
  let testBuild = ''
  let atum = ''
  let stranger = ''

  beforeAll(() => {
    const directory = mkdtempSync(path.join(tmpdir(), 'atum-keys-real-'))
    directories.push(directory)
    const source = path.resolve(import.meta.dirname, '..', '..', 'native', 'atum-keys')
    const contents = path.join(directory, 'Atum Keys.app', 'Contents')
    mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
    copyFileSync(path.join(source, 'Info.plist'), path.join(contents, 'Info.plist'))
    executable = path.join(contents, 'MacOS', 'atum-keys')
    testBuild = path.join(directory, 'atum-keys-caller-test')

    const build = (args: string[]) => {
      const built = spawnSync('xcrun', args, { encoding: 'utf8' })
      expect(built.status, built.stderr).toBe(0)
    }

    build(['swiftc', '-O', path.join(source, 'main.swift'), '-o', executable])
    expect(spawnSync('codesign', ['--force', '--sign', '-', path.join(directory, 'Atum Keys.app')]).status).toBe(0)
    build(['swiftc', '-Onone', '-D', 'ATUM_KEYS_CALLER_TEST', path.join(source, 'main.swift'), '-o', testBuild])

    const parent = path.join(directory, 'parent.c')
    writeFileSync(parent, PARENT_C)
    atum = path.join(directory, 'atum')
    stranger = path.join(directory, 'stranger')

    for (const [file, identifier] of [
      [atum, 'com.atum.keys-caller-test'],
      [stranger, 'com.example.stranger']
    ] as const) {
      build(['clang', '-O2', parent, '-o', file])
      expect(spawnSync('codesign', ['--force', '--sign', '-', '--identifier', identifier, file]).status).toBe(0)
    }
  }, 240_000)

  it('answers its protocol and says it is not provisioned', async () => {
    expect(await runMatrixKeychain(executable, { op: 'probe' })).toEqual({ ok: false, code: 'unprovisioned' })
    expect(await new MatrixICloudKeychain({ helper: executable }).available()).toBe(false)
  })

  it('refuses the key to every caller that is not Atum: this test, a shell, a signed stranger', async () => {
    for (const request of [
      { op: 'read', account: ME },
      { op: 'write', account: ME, value: KEY },
      { op: 'remove', account: ME },
      { op: 'read', account: 'not a user' }
    ] as const) {
      expect(await runMatrixKeychain(executable, request)).toEqual({ ok: false, code: 'caller' })
      expect(ask(['/bin/sh', '-c', '"$0"; exit $?', executable], request)).toEqual({ ok: false, code: 'caller' })
      // Signed, even under the identifier the test build trusts, but not by Atum's team.
      expect(ask([atum, executable], request)).toEqual({ ok: false, code: 'caller' })
      expect(ask([stranger, executable], request)).toEqual({ ok: false, code: 'caller' })
    }
  })

  it('lets through only the caller that meets the requirement, while it is still there', () => {
    // Past the check: the keychain answers (no profile here), and a bad account is still invalid.
    expect(ask([atum, testBuild], { op: 'read', account: ME })).toEqual({ ok: false, code: 'unprovisioned' })
    expect(ask([atum, testBuild], { op: 'read', account: 'not a user' })).toEqual({ ok: false, code: 'invalid' })

    // Any other caller, and the right one once it has exited, are refused before the keychain.
    expect(ask([stranger, testBuild], { op: 'read', account: ME })).toEqual({ ok: false, code: 'caller' })
    expect(ask([testBuild], { op: 'read', account: ME })).toEqual({ ok: false, code: 'caller' })
    expect(ask([atum, '--detach', testBuild], { op: 'read', account: ME }, { detached: true })).toEqual({
      ok: false,
      code: 'caller'
    })
  })
})
