import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixInvocationWatch } from '../../shared/matrix'
import { EncryptedStore } from '../encrypted-store'

import { MatrixAccount } from './account'
import { matrixConfigurationKey } from './config'
import { MatrixContinuousListening } from './continuous-listening'
import { MatrixCredentialRenewal, matrixRenewedWatchEnd, renewMatrixAgentHost } from './credential-renewal'
import { MatrixHermesListener } from './hermes-listener'
import { MatrixExecutorLease } from './lease'
import { admitMatrixEnrollmentSetup } from './main-enrollment'
import { boundSdkConfiguration, matrixAgentSdkRefresh, MatrixSdkHost } from './sdk-host'

const minute = 60_000
const directories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

/** Candidate-class composition, not a provider/crypto or installed wall-clock proof.
 * Only HTTP answers and the OS encryption/SDK process boundaries are disposable fixtures;
 * account custody, response parsing, lease, scheduler, host refresh and listening are real. */
it('rotates retained custody into a listening v2 host through the first hour, then fences a persisted refusal', async () => {
  vi.useFakeTimers()
  const startedAt = new Date('2026-10-01T00:00:00Z').getTime()
  vi.setSystemTime(startedAt)

  const directory = mkdtempSync(path.join(tmpdir(), 'atum-runtime-candidate-'))
  directories.push(directory)
  const vaultPath = path.join(directory, 'vault.json')

  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }

  const store = new EncryptedStore(vaultPath, storage)

  const config = {
    issuer: 'https://id.test/',
    server: 'https://matrix.test',
    nativeClientId: 'matrix',
    callbackPort: 21881,
    domain: { nativeClientId: 'domain', resource: 'https://api.test' }
  }

  const owner = { issuer: config.issuer, subject: 'alice', principal: '12345678-1234-1234-1234-123456789abc' }
  const agentPrincipal = '22345678-1234-1234-1234-123456789abc'
  const leaseToken = '32345678-1234-1234-1234-123456789abc'
  store.setItem(
    'matrix-account',
    JSON.stringify({
      version: 1,
      configurationKey: matrixConfigurationKey(config),
      issuer: config.issuer,
      subject: owner.subject,
      userId: '@alice:test',
      deviceId: 'OWNER',
      storageKey: Buffer.alloc(32, 1).toString('base64'),
      accessToken: 'human-fixture-token',
      refreshToken: 'human-fixture-refresh',
      domain: {
        ...owner,
        accessToken: 'domain-fixture-token',
        refreshToken: 'domain-fixture-refresh',
        sessionId: 'domain'
      }
    })
  )

  let issued = 0
  let rotating = false
  let rotationLeaseRefusals = 0
  let denyLease = false
  let finishRotation: (() => void) | undefined
  const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = []

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer domain-fixture-token')
    const endpoint = new URL(url).pathname
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    requests.push({ endpoint, body })

    if (endpoint === '/me') {
      return json(owner)
    }

    if (endpoint === '/assistant') {
      return json({ agentPrincipal, matrixUser: '@assistant:test' })
    }

    if (endpoint === '/local-hermes') {
      const response = json({
        ...owner,
        executorId: body.executorId,
        agentPrincipal,
        userId: '@assistant:test',
        deviceId: 'AGENT',
        accessToken: `agent-fixture-token-${++issued}`,
        expiresAt: Date.now() + 60 * minute
      })

      // The real provider temporarily denies lease calls while this exact executor rotates.
      if (issued === 2) {
        rotating = true
        await new Promise<void>(resolve => {
          finishRotation = () => {
            rotating = false
            resolve()
          }
        })
      }

      return response
    }

    expect(endpoint).toBe('/local-hermes/lease')
    expect(body.protocol).toBe(2)

    if (body.operation === 'release') {
      return json({ held: false })
    }

    if (rotating || denyLease) {
      rotationLeaseRefusals += rotating ? 1 : 0

      return json({ error: 'matrix_denied' }, 403)
    }

    return json({
      held: true,
      executorId: body.executorId,
      acquiredAt: startedAt,
      expiresAt: Date.now() + 90_000,
      leaseToken,
      boundary: startedAt
    })
  })

  const openBrowser = vi.fn(async () => {})
  const clearProfile = vi.fn(async () => {})
  const account = new MatrixAccount(config, store, openBrowser, clearProfile)
  const enrolled = await account.enrollHermes(false)
  expect(enrolled.state).toBe('ready')
  const identity = enrolled.identity!
  const profile = path.join(directory, 'retained-hermes')
  account.retainHermesProfile(profile)
  const custody = JSON.parse(store.getItem('matrix-account')!)
  const digest = (token: string) => createHash('sha256').update(token).digest('hex')
  let sdkConfiguration = boundSdkConfiguration(account, 'agent', identity, 'host-fixture-handle')
  let sdkHolds = digest(sdkConfiguration.accessToken)
  let renewing: Promise<void> | undefined
  let continuous: MatrixContinuousListening
  let hostEnded = false
  let hostExpiry: ReturnType<typeof setTimeout>
  const commands: Array<{ kind: string; watch?: MatrixInvocationWatch }> = []
  const completed: string[] = []

  const listener = new MatrixHermesListener(
    async (target, _watch, signal) => {
      signal.throwIfAborted()
      expect(lease.held(identity.executorId)?.signal.aborted).toBe(false)
      expect(sdkConfiguration.accessToken).toBe(account.agentSdkConfiguration().accessToken)
      completed.push(target.eventId)

      return { state: 'published' }
    },
    () => continuous?.listenerChanged()
  )

  const lease = new MatrixExecutorLease({
    request: (operation, executorId, metadata) => account.lease(operation, executorId, metadata),
    onChange: () => continuous?.reconcile(),
    random: () => 0.5
  })

  const queue = new MatrixSdkHost(
    (id, value) => {
      const command = value as { kind: string; watch?: MatrixInvocationWatch }
      commands.push(structuredClone(command))

      void (async () => {
        if (command.kind === 'renewed') {
          const answer = await matrixAgentSdkRefresh({
            handle: 'host-fixture-handle',
            expected: 'host-fixture-handle',
            configuration: () => boundSdkConfiguration(account, 'agent', identity, 'host-fixture-handle'),
            holds: sdkHolds,
            digest,
            renewing: () => renewing
          })

          expect(answer.result.ok).toBe(true)

          if (answer.result.ok) {
            sdkHolds = answer.holds!
            sdkConfiguration = { ...sdkConfiguration, accessToken: answer.result.accessToken }
          }
        }

        queue.result(id, true, undefined)
      })()
    },
    () => {}
  )

  continuous = new MatrixContinuousListening({
    store: store.scope('candidate-listening:'),
    context: () =>
      lease.held(identity.executorId) ? { state: 'ready' } : { state: 'waiting', reason: 'lease_elsewhere' },
    arm: async (preference, signal) => {
      const watch: MatrixInvocationWatch = {
        id: 'candidate-watch',
        roomId: preference.roomId,
        sender: account.identity()!,
        since: Date.now(),
        until: account.enrollment().identity!.expiresAt
      }

      listener.prepare(watch)
      await queue.command({ kind: 'watchInvocations', watch })
      signal.throwIfAborted()
      expect(listener.commit(watch.id)).toBe(true)
    },
    stop: () => listener.stop(),
    listener: () => listener.snapshot(),
    changed: () => {}
  })

  const expireAt = (at: number) => {
    clearTimeout(hostExpiry)
    hostExpiry = setTimeout(() => {
      hostEnded = true
      listener.stop('expired')
    }, at - Date.now())
  }

  expireAt(identity.expiresAt)
  const logs: string[] = []

  const renewal = new MatrixCredentialRenewal({
    label: 'assistant',
    expiresAt: () => account.enrollment().identity?.expiresAt,
    random: () => 0,
    log: line => logs.push(line),
    renew: () => {
      renewing = renewMatrixAgentHost({
        current: () => !hostEnded,
        identity,
        rotate: () => account.renewAgentExecutor(),
        expireAt,
        notify: () => void queue.command({ kind: 'renewed' }),
        extend: at => {
          const watch = listener.extend(current => matrixRenewedWatchEnd(current, at, continuous.roomId, 15 * minute))

          if (watch) {
            void queue.command({ kind: 'watchInvocations', watch })
          }
        },
        changed: () => continuous.reconcile()
      })

      return renewing
    }
  })

  try {
    lease.start(identity.executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const held = lease.held(identity.executorId)!
    continuous.enable('a'.repeat(64), '!candidate:test')
    await vi.advanceTimersByTimeAsync(0)
    renewal.start()

    listener.offer({ watchId: 'candidate-watch', roomId: '!candidate:test', eventId: '$before-rotation' })
    await vi.advanceTimersByTimeAsync(30 * minute + 30_000)
    expect(rotating).toBe(true)
    expect(rotationLeaseRefusals).toBeGreaterThan(0)
    expect(lease.held(identity.executorId)?.signal).toBe(held.signal)
    expect(account.enrollment().state).toBe('ready')

    const refusedSdkToken = matrixAgentSdkRefresh({
      handle: 'host-fixture-handle',
      expected: 'host-fixture-handle',
      configuration: () => boundSdkConfiguration(account, 'agent', identity, 'host-fixture-handle'),
      holds: sdkHolds,
      digest,
      renewing: () => renewing
    })

    finishRotation!()
    await vi.advanceTimersByTimeAsync(0)
    expect((await refusedSdkToken).result).toMatchObject({
      ok: true,
      accessToken: account.agentSdkConfiguration().accessToken
    })
    await vi.advanceTimersByTimeAsync(31 * minute)

    expect(Date.now()).toBeGreaterThan(identity.expiresAt)
    expect(issued).toBe(3)
    expect(logs.filter(line => line.includes('credential renewed'))).toHaveLength(2)
    expect(hostEnded).toBe(false)
    expect(lease.held(identity.executorId)?.signal).toBe(held.signal)
    expect(held.signal.aborted).toBe(false)
    expect(continuous.snapshot()).toMatchObject({ state: 'listening', mode: 'continuous' })
    expect(commands.filter(command => command.kind === 'renewed')).toHaveLength(2)
    expect(commands.filter(command => command.watch).map(command => command.watch!.id)).toEqual([
      'candidate-watch',
      'candidate-watch',
      'candidate-watch'
    ])
    listener.offer({ watchId: 'candidate-watch', roomId: '!candidate:test', eventId: '$after-original-expiry' })
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toEqual(['$before-rotation', '$after-original-expiry'])

    const reopened = new MatrixAccount(config, new EncryptedStore(vaultPath, storage), openBrowser, clearProfile)
    expect(reopened.agentSdkConfiguration()).toEqual(account.agentSdkConfiguration())
    expect(reopened.enrollment().identity).toMatchObject({
      ...identity,
      expiresAt: account.enrollment().identity!.expiresAt
    })

    denyLease = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
    expect(held.signal.aborted).toBe(true)
    expect(account.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    const withdrawn = JSON.parse(store.getItem('matrix-account')!)
    expect(withdrawn.enrollment).toMatchObject({
      state: 'withdrawn',
      executorId: custody.enrollment.executorId,
      storageKey: custody.enrollment.storageKey,
      credential: { userId: identity.userId, deviceId: identity.deviceId, accessToken: sdkConfiguration.accessToken }
    })
    expect(withdrawn.localHermes).toEqual(custody.localHermes)
    expect(reopened.enrollment()).toEqual({ state: 'withdrawn', identity: null })
    const setup = vi.fn(async () => {})
    expect(await admitMatrixEnrollmentSetup(() => reopened.enrollment(), setup)).toEqual({
      ok: false,
      code: 'authority_withdrawn'
    })
    await expect(reopened.enrollHermes(false)).rejects.toThrow('matrix_enrollment_withdrawn')
    expect(setup).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    expect(clearProfile).not.toHaveBeenCalled()
    expect(requests.filter(request => request.endpoint === '/local-hermes')).toHaveLength(3)
  } finally {
    renewal.stop()
    continuous.dispose()
    listener.clear()
    queue.close()
    clearTimeout(hostExpiry!)
    await lease.stop()
  }
})
