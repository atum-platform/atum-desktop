import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installMatrixExitBarrier } from './exit-barrier'
import { MATRIX_LOCAL_BRAIN_METHODS, MatrixLocalBrain, type MatrixLocalBrainOwner } from './local-brain'

const OWNER_A: MatrixLocalBrainOwner = { accountKey: 'a'.repeat(64), generation: 3 }
const OWNER_B: MatrixLocalBrainOwner = { accountKey: 'b'.repeat(64), generation: 4 }
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function platformKey(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') {return 'darwin-arm64'}

  if (process.platform === 'linux' && process.arch === 'x64') {return 'linux-x64'}
  throw new Error(`unsupported test platform ${process.platform}-${process.arch}`)
}

function writeSignedReceipt(resources: string): string {
  const binary = readFileSync(join(resources, 'bin', 'gbrain'))
  const original = JSON.parse(readFileSync(join(resources, 'MANIFEST.json'), 'utf8')).gbrain
  const pin = readFileSync(join(resources, 'pin.json'))
  const signed = createHash('sha256').update(binary).digest('hex')
  writeFileSync(join(resources, 'SIGNED-BINARY.json'), JSON.stringify({
    format: 'atum.local-brain.signed-binary/1',
    platform: platformKey(),
    sourceLock: {
      schema: 'atum.local-brain.source/1',
      repository: 'https://example.test/atum-platform',
      commit: 'a'.repeat(40),
      path: 'packages/local-brain',
      pin: { bytes: pin.length, sha256: createHash('sha256').update(pin).digest('hex') },
      archive: { name: 'local-brain.tar.gz', bytes: 1, sha256: 'b'.repeat(64) }
    },
    original,
    signed: { bytes: binary.length, sha256: signed }
  }))
  return signed
}

function fixture(
  mode: 'ready' | 'delayed-ready' | 'failed' | 'no-response' | 'exit' | 'unicode-ready' | 'grandchild' | 'delayed-outcome' | 'stubborn' = 'ready'
) {
  const directory = mkdtempSync(join(tmpdir(), 'atum-local-brain-'))
  temporary.push(directory)
  const resources = join(directory, 'resources')
  const userData = join(directory, 'user-data')
  const source = join(resources, 'src')
  const binaryDirectory = join(resources, 'bin')
  mkdirSync(source, { recursive: true })
  mkdirSync(binaryDirectory, { recursive: true })
  mkdirSync(join(resources, 'contract', 'awareness-v1'), { recursive: true })
  mkdirSync(join(resources, 'licenses'), { recursive: true })
  const binary = join(binaryDirectory, 'gbrain')
  const bytes = Buffer.from('fixture-gbrain-binary')
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(binary, bytes)
  chmodSync(binary, 0o700)
  writeFileSync(join(resources, 'pin.json'), JSON.stringify({
    schema: 'atum.local-brain.pin/1',
    gbrain: { assets: { [platformKey()]: { sha256: digest, size: bytes.length } } }
  }))
  writeFileSync(join(resources, 'MANIFEST.json'), JSON.stringify({
    entry: 'src/cli.mjs',
    format: 'atum.local-brain.package/1',
    gbrain: { bytes: bytes.length, sha256: digest },
    platform: platformKey()
  }))
  writeSignedReceipt(resources)
  writeFileSync(join(source, 'cli.mjs'), `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { spawn } from 'node:child_process';
    const mode = ${JSON.stringify(mode)};
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1];
    const launches = join(root, 'launches.jsonl');
    const launchCount = existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1;
    appendFileSync(launches, JSON.stringify({ launchCount, pid: process.pid }) + '\\n');
    writeFileSync(join(root, 'launch.json'), JSON.stringify({ args, env: {
      PATH: process.env.PATH ?? null,
      MATRIX_ACCESS_TOKEN: process.env.MATRIX_ACCESS_TOKEN ?? null,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null
    }}));
    const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
    const respond = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { method: message.method, params: message.params ?? null } }) + '\\n');
    let delayed = 0;
    let inputEnded = false;
    const finishDrained = () => {
      if (mode === 'delayed-outcome' && launchCount === 1 && inputEnded && delayed === 0) {
        setTimeout(() => {
          writeFileSync(join(root, 'drained.json'), JSON.stringify({ launchCount }));
          process.exit(0);
        }, 40);
      }
    };
    if (mode === 'stubborn') {
      // A provider wedged mid-write: ignores SIGTERM and the end of its input.
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    }
    if (mode === 'grandchild' || mode === 'stubborn') {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });
      grandchild.unref();
      writeFileSync(join(root, 'grandchild.pid'), String(grandchild.pid));
    }
    if (mode === 'exit') process.exit(2);
    else if (mode === 'failed') notify('brain.failed', { code: 'fixture' });
    else if (mode === 'delayed-ready') setTimeout(() => notify('brain.ready', {}), 80);
    else if (mode === 'unicode-ready') {
      const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'brain.ready', params: { city: 'Đà Nẵng' } }) + '\\n');
      const split = frame.indexOf(Buffer.from('Đ')) + 1;
      process.stdout.write(frame.subarray(0, split));
      setTimeout(() => process.stdout.write(frame.subarray(split)), 5);
    }
    else {
      if (mode === 'delayed-outcome' && launchCount > 1) {
        writeFileSync(join(root, 'restart-after-drain.json'), JSON.stringify({ drained: existsSync(join(root, 'drained.json')) }));
      }
      notify('brain.ready', {});
    }
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => {
      buffer += data;
      for (;;) {
        const at = buffer.indexOf('\\n');
        if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (mode === 'delayed-outcome' && launchCount === 1) {
          // The provider has accepted and persisted the operation before the
          // supervisor's deadline, then drains it after stdin closes.
          appendFileSync(join(root, 'persisted.jsonl'), JSON.stringify({ method: message.method, params: message.params ?? null }) + '\\n');
          delayed++;
          setTimeout(() => {
            respond(message);
            writeFileSync(join(root, 'late-response.json'), JSON.stringify({ id: message.id }));
            delayed--;
            finishDrained();
          }, 80);
        } else if (mode !== 'no-response') {
          respond(message);
        }
      }
    });
    process.stdin.on('end', () => {
      if (mode === 'delayed-outcome' && launchCount === 1) {
        inputEnded = true;
        finishDrained();
      } else if (mode === 'stubborn') {
        // Keeps running.
      } else {
        process.exit(0);
      }
    });
  `)

  return { directory, resources, userData }
}

function supervisor(input = fixture(), options: Partial<ConstructorParameters<typeof MatrixLocalBrain>[0]> = {}) {
  return new MatrixLocalBrain({
    resources: input.resources,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    userData: input.userData,
    ...options
  })
}

describe('MatrixLocalBrain', () => {
  it('runs only the attested resource under the owner account root and sanitizes its environment', async () => {
    const input = fixture()
    const brain = supervisor(input)
    await brain.activate(OWNER_A)
    expect(brain.ready(OWNER_A)).toBe(true)
    await expect(brain.call(OWNER_A, 'brain.info')).resolves.toEqual({ method: 'brain.info', params: null })

    const root = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain')
    const launched = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'))
    expect(launched.args).toEqual(expect.arrayContaining([
      'serve', '--root', root, '--binary', join(input.resources, 'bin', 'gbrain'), '--binary-sha256'
    ]))
    expect(launched.env).toEqual({ PATH: null, MATRIX_ACCESS_TOKEN: null, ELECTRON_RUN_AS_NODE: '1' })
    await brain.stop()
    expect(brain.ready(OWNER_A)).toBe(false)
  })

  it('coalesces same-owner startup and rejects an unpinned platform binary before spawn', async () => {
    const input = fixture('delayed-ready')
    const brain = supervisor(input)
    const first = brain.activate(OWNER_A)
    const upper = { ...OWNER_A, accountKey: OWNER_A.accountKey.toUpperCase() }
    expect(brain.activate(upper)).toBe(first)
    await first
    expect(brain.ready(upper)).toBe(true)
    await expect(brain.call(upper, 'brain.info')).resolves.toEqual({ method: 'brain.info', params: null })
    expect(existsSync(join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'launch.json'))).toBe(true)
    await brain.stop()

    const invalid = fixture()
    writeFileSync(join(invalid.resources, 'MANIFEST.json'), JSON.stringify({
      entry: 'src/cli.mjs', format: 'atum.local-brain.package/1', gbrain: { bytes: 1, sha256: '0'.repeat(64) }, platform: platformKey()
    }))
    await expect(supervisor(invalid).activate(OWNER_A)).rejects.toThrow('matrix_local_brain_receipt_invalid')
    expect(existsSync(join(invalid.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'launch.json'))).toBe(false)
  })

  it('requires a pin-bound final-byte receipt and passes its digest to the provider', async () => {
    const missing = fixture()
    rmSync(join(missing.resources, 'SIGNED-BINARY.json'))
    await expect(supervisor(missing).activate(OWNER_A)).rejects.toThrow('matrix_local_brain_receipt_invalid')

    const forged = fixture()
    const receipt = JSON.parse(readFileSync(join(forged.resources, 'SIGNED-BINARY.json'), 'utf8'))
    receipt.sourceLock.commit = 'z'.repeat(40)
    writeFileSync(join(forged.resources, 'SIGNED-BINARY.json'), JSON.stringify(receipt))
    await expect(supervisor(forged).activate(OWNER_A)).rejects.toThrow('matrix_local_brain_receipt_invalid')

    const signed = fixture()
    const signedBytes = Buffer.from('fixture-gbrain-binary-after-codesign')
    writeFileSync(join(signed.resources, 'bin', 'gbrain'), signedBytes)
    const finalDigest = writeSignedReceipt(signed.resources)
    const brain = supervisor(signed)
    await brain.activate(OWNER_A)
    const launched = JSON.parse(readFileSync(join(signed.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'launch.json'), 'utf8'))
    expect(launched.args).toEqual(expect.arrayContaining(['--binary-sha256', finalDigest]))
    await brain.stop()
  })

  it('treats source metadata as informational but rejects mismatched raw and final bytes', async () => {
    const metadata = fixture()
    const metadataPath = join(metadata.resources, 'SIGNED-BINARY.json')
    const receipt = JSON.parse(readFileSync(metadataPath, 'utf8'))
    receipt.sourceLock.commit = 'c'.repeat(40)
    receipt.sourceLock.repository = 'https://example.test/another-source'
    receipt.sourceLock.archive.sha256 = 'd'.repeat(64)
    writeFileSync(metadataPath, JSON.stringify(receipt))
    const allowed = supervisor(metadata)
    await allowed.activate(OWNER_A)
    await allowed.stop()

    for (const kind of ['original', 'signed'] as const) {
      const input = fixture()
      const file = join(input.resources, 'SIGNED-BINARY.json')
      const changed = JSON.parse(readFileSync(file, 'utf8'))
      changed[kind].sha256 = '0'.repeat(64)
      writeFileSync(file, JSON.stringify(changed))
      await expect(supervisor(input).activate(OWNER_A)).rejects.toThrow(
        kind === 'original' ? 'matrix_local_brain_receipt_invalid' : 'matrix_local_brain_binary_invalid'
      )
    }
  })

  it('fences a pending RPC and old readiness when the active Matrix account switches', async () => {
    const input = fixture('no-response')
    const brain = supervisor(input, { requestTimeoutMs: 1_000 })
    await brain.activate(OWNER_A)
    const pending = brain.call(OWNER_A, 'brain.retrieve', { query: 'never logged by supervisor' })
    const incoming = brain.activate(OWNER_B)
    await expect(pending).rejects.toThrow('matrix_local_brain_stopped')
    await incoming
    expect(brain.ready(OWNER_A)).toBe(false)
    expect(brain.ready(OWNER_B)).toBe(true)
    await expect(brain.call(OWNER_A, 'brain.info')).rejects.toThrow('matrix_local_brain_unavailable')
    await brain.stop()
  })

  it('keeps owner, method, and payload-size validation ahead of provider dispatch', async () => {
    const brain = supervisor()
    await brain.activate(OWNER_A)
    expect(MATRIX_LOCAL_BRAIN_METHODS).toEqual([
      'brain.info', 'brain.ingest', 'brain.fence', 'brain.withdraw', 'brain.correct', 'brain.retrieve', 'brain.reportCoverage', 'brain.coverage'
    ])
    expect(() => brain.call({ ...OWNER_A, accountKey: 'not-an-account' }, 'brain.info')).toThrow('matrix_local_brain_owner_invalid')
    await expect(brain.call(OWNER_A, 'brain.export')).rejects.toThrow('matrix_local_brain_method_denied')
    await expect(brain.call(OWNER_A, 'brain.ingest', { content: { text: 'x'.repeat(64 * 1024 * 1024) } }))
      .rejects.toThrow('matrix_local_brain_request_too_large')
    expect(brain.ready(OWNER_A)).toBe(true)
    await brain.stop()
  })

  it('fences unknown dispatched outcomes, collateral calls, and waits for a drained provider before an explicit restart', async () => {
    const input = fixture('delayed-outcome')
    const brain = supervisor(input, { requestTimeoutMs: 20, stopTimeoutMs: 1_000 })
    await brain.activate(OWNER_A)
    const root = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain')
    const first = brain.call(OWNER_A, 'brain.ingest', { operationId: 'one' })
    const collateral = brain.call(OWNER_A, 'brain.retrieve', { query: 'two' })
    const outcomes = await Promise.allSettled([first, collateral])

    expect(outcomes).toHaveLength(2)

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'matrix_local_brain_request_outcome_unknown' }) })
    }

    // The timeout rejects the caller before async provider cleanup finishes. On a saturated CI
    // host the child may persist the already-dispatched frame during that drain, so observe the
    // marker instead of racing a synchronous read against the child process scheduler.
    await vi.waitFor(() => expect(existsSync(join(root, 'persisted.jsonl'))).toBe(true))
    const persisted = readFileSync(join(root, 'persisted.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))

    expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'brain.ingest' })]))
    expect(brain.ready(OWNER_A)).toBe(false)
    await expect(brain.call(OWNER_A, 'brain.info')).rejects.toThrow('matrix_local_brain_unavailable')

    // Explicitly starting again may queue immediately, but must not spawn while
    // the prior provider has a late, already-persisted response to drain.
    const restart = brain.activate(OWNER_A)
    expect(brain.ready(OWNER_A)).toBe(false)
    await restart

    expect(existsSync(join(root, 'late-response.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'restart-after-drain.json'), 'utf8'))).toEqual({ drained: true })
    expect(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(brain.ready(OWNER_A)).toBe(true)
    await brain.stop()
  })

  it('transports a full-size multilingual awareness payload without a 64 KiB truncation', async () => {
    const brain = supervisor()
    await brain.activate(OWNER_A)
    const params = { content: { text: 'Đ'.repeat(65_536) } }
    await expect(brain.call(OWNER_A, 'brain.ingest', params)).resolves.toEqual({ method: 'brain.ingest', params })
    await brain.stop()
  })

  it('rejects startup on the provider failure notification and cleans up the child', async () => {
    const input = fixture('failed')
    const brain = supervisor(input)
    await expect(brain.activate(OWNER_A)).rejects.toThrow('matrix_local_brain_failed')
    expect(brain.ready(OWNER_A)).toBe(false)
    await expect(brain.call(OWNER_A, 'brain.info')).rejects.toThrow('matrix_local_brain_unavailable')
  })

  it('fences a stopped startup and treats an early provider exit as unavailable', async () => {
    const input = fixture('delayed-ready')
    const brain = supervisor(input)
    const starting = brain.activate(OWNER_A)
    const launch = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'launch.json')
    await vi.waitFor(() => expect(existsSync(launch)).toBe(true))
    await brain.stop()
    await expect(starting).rejects.toThrow('matrix_local_brain_stopped')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(brain.ready(OWNER_A)).toBe(false)

    await expect(supervisor(fixture('exit')).activate(OWNER_A)).rejects.toThrow('matrix_local_brain_exited')
  })

  it('handles an asynchronous child spawn error without waiting for termination deadlines', async () => {
    const child = Object.assign(new EventEmitter(), {
      stderr: Object.assign(new EventEmitter(), { resume: () => {} }),
      stdin: Object.assign(new EventEmitter(), { end: () => {}, write: () => true }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} })
    })

    const brain = supervisor(fixture(), {
      spawn: (() => {
        queueMicrotask(() => child.emit('error', new Error('fixture spawn failure')))

        return child
      }) as never
    })

    await expect(brain.activate(OWNER_A)).rejects.toThrow('matrix_local_brain_spawn_failed')
  })

  it('preserves split UTF-8 protocol frames and reaps a grandchild after its provider parent exits', async () => {
    const unicode = supervisor(fixture('unicode-ready'))
    await expect(unicode.activate(OWNER_A)).resolves.toBeUndefined()
    await unicode.stop()

    const input = fixture('grandchild')
    const brain = supervisor(input)
    await brain.activate(OWNER_A)
    const pidPath = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'grandchild.pid')
    await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true))
    const grandchild = Number(readFileSync(pidPath, 'utf8'))
    await brain.stop()
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow())
  })

  it('checks real process-group metadata on a denied probe and still reaps a live grandchild', async () => {
    const input = fixture('grandchild')
    const brain = supervisor(input)
    await brain.activate(OWNER_A)
    const pidPath = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain', 'grandchild.pid')
    await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true))
    const grandchild = Number(readFileSync(pidPath, 'utf8'))
    const originalKill = process.kill.bind(process)

    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0) {throw Object.assign(new Error('denied group probe'), { code: 'EPERM' })}

      return originalKill(pid, signal)
    })

    try {
      await brain.stop()
    } finally {
      probe.mockRestore()
    }

    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow())
  })


  it('leaves no provider or grandchild behind when the app exits during a wedged shutdown', async () => {
    const input = fixture('stubborn')
    // A graceful stop that would take a minute: the quit path cannot wait for it.
    const brain = supervisor(input, { stopTimeoutMs: 20_000 })
    await brain.activate(OWNER_A)
    const root = join(input.userData, 'accounts', OWNER_A.accountKey, 'local-brain')
    await vi.waitFor(() => expect(existsSync(join(root, 'grandchild.pid'))).toBe(true))
    const grandchild = Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'))
    const provider = JSON.parse(readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n')[0]).pid as number

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)

        return true
      } catch {
        return false
      }
    }

    const graceful = brain.stop()
    void graceful.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(alive(provider)).toBe(true)

    const app = new EventEmitter()
    const exiting = new EventEmitter()
    installMatrixExitBarrier({ app, process: exiting, kill: () => brain.killNow() })
    app.emit('will-quit')

    await vi.waitFor(() => {
      expect(alive(provider)).toBe(false)
      expect(alive(grandchild)).toBe(false)
    }, { timeout: 3_000 })
    // Node's own exit runs the barrier again; nothing is left to signal.
    expect(() => exiting.emit('exit')).not.toThrow()
    expect(brain.killNow()).toBe(0)
    await graceful
  })
})
