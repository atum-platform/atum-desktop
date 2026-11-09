/**
 * A host in the same process as its SDK (G8-36): what a browser client or a headless
 * executor uses in place of the desktop's IPC. The engine is faked; the seam, the queue and
 * the serving are the real ones the desktop uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixNotificationHint, MatrixSdkConfiguration, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixGoogleFenceObservation } from '../../shared/matrix-google-fence'
import type { MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'

import { APP_BOT_ROOM_WAIT_MS } from './app-bot-room-wait'
import type { MatrixAppBotEvent } from './sdk-app-bot'
import type { MatrixSdkHostPort } from './sdk-host-port'
import {
  connectMatrixSdk,
  MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS,
  MATRIX_SDK_COMMAND_TIMEOUT_MS,
  matrixSdkCommandTimeout,
  MatrixSdkHost,
  type MatrixSdkLocalHost
} from './sdk-host-queue'
import { serveMatrixSdk } from './sdk-host-serve'

const configuration: MatrixSdkConfiguration = {
  baseUrl: 'https://matrix.test',
  userId: '@agent:test',
  deviceId: 'AGENT',
  accessToken: 'fixture-token',
  storageKey: btoa('0'.repeat(32))
}

function localHost(): MatrixSdkLocalHost & { snapshots: MatrixSnapshot[]; hints: unknown[]; appBotHints: MatrixAppBotEvent[] } {
  const snapshots: MatrixSnapshot[] = []
  const hints: unknown[] = []
  const appBotHints: MatrixAppBotEvent[] = []

  return {
    snapshots,
    hints,
    appBotHints,
    configuration: vi.fn(async () => configuration),
    refresh: vi.fn(async () => ({ ok: true as const, accessToken: 'new', refreshToken: 'next' })),
    snapshot: value => void snapshots.push(value),
    invocation: value => void hints.push(value),
    appBotEvent: value => void appBotHints.push(value)
  }
}

type Engine = Parameters<typeof serveMatrixSdk>[1]

/** A fake engine that keeps what it was given and hands out what it holds. */
function engine() {
  const held: { command?: unknown; result: { rooms: string[] } } = { result: { rooms: ['!a:test'] } }

  const calls: {
    publish?: (snapshot: MatrixSnapshot) => void
    offer?: (hint: never) => void
    notification?: (hint: MatrixNotificationHint) => void
    googleFence?: (observation: MatrixGoogleFenceObservation) => void
    appBotEvent?: (hint: MatrixAppBotEvent) => void
    undecryptable?: (observation: MatrixUndecryptableObservation) => void
  } = {}

  const sdk = {
    command: vi.fn(async (command: unknown) => {
      held.command = command

      return held.result
    }),
    stop: vi.fn(async () => {})
  }

  const start = vi.fn(async (_config: MatrixSdkConfiguration, _refresh, publish, offer, notification, googleFence, appBotEvent, undecryptable) => {
    calls.publish = publish
    calls.undecryptable = undecryptable
    calls.offer = offer
    calls.notification = notification
    calls.googleFence = googleFence
    calls.appBotEvent = appBotEvent

    return sdk
  }) as unknown as NonNullable<Engine>

  return { sdk, start, held, calls }
}

afterEach(() => vi.useRealTimers())

describe('an SDK hosted in the same process (G8-36)', () => {
  it('keeps native notification delivery optional, copied and unable to break SDK handling', async () => {
    const notification = vi.fn((_hint: MatrixNotificationHint) => {
      throw new Error('retired native host')
    })

    const { port } = connectMatrixSdk({ ...localHost(), notification })
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started
    const hint = { roomId: '!room:test', eventId: '$fresh', sound: true }
    expect(() => fake.calls.notification!(hint)).not.toThrow()
    expect(notification).toHaveBeenCalledExactlyOnceWith(hint)
    expect(notification.mock.calls[0]![0]).not.toBe(hint)
    const withoutNative = connectMatrixSdk(localHost())
    const other = engine()
    await serveMatrixSdk(withoutNative.port, other.start).started
    expect(() => other.calls.notification!(hint)).not.toThrow()
  })

  it('forwards Google-fence observations to a host port, and keeps them optional', async () => {
    const googleFence = vi.fn()

    const host: MatrixSdkHostPort = {
      configuration: async () => configuration,
      refresh: async () => ({ ok: true, accessToken: 'new', refreshToken: 'next' }),
      snapshot: vi.fn(),
      invocation: vi.fn(),
      googleFence,
      commands: vi.fn(),
      result: vi.fn()
    }

    const fake = engine()
    await serveMatrixSdk(host, fake.start).started

    const observation: MatrixGoogleFenceObservation = { state: 'current', since: 42 }
    fake.calls.googleFence!(observation)
    expect(googleFence).toHaveBeenCalledExactlyOnceWith(observation)

    const withoutFence: MatrixSdkHostPort = { ...host, googleFence: undefined }
    const other = engine()
    await serveMatrixSdk(withoutFence, other.start).started
    expect(() => other.calls.googleFence!({ state: 'unknown' })).not.toThrow()
  })

  it('forwards undecryptable-message observations to a host port, and keeps them optional', async () => {
    const undecryptable = vi.fn()

    const host: MatrixSdkHostPort = {
      configuration: async () => configuration,
      refresh: async () => ({ ok: true, accessToken: 'new', refreshToken: 'next' }),
      snapshot: vi.fn(),
      invocation: vi.fn(),
      undecryptable,
      commands: vi.fn(),
      result: vi.fn()
    }

    const fake = engine()
    await serveMatrixSdk(host, fake.start).started

    const observation: MatrixUndecryptableObservation = { roomId: '!a:test', code: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' }
    fake.calls.undecryptable!(observation)
    expect(undecryptable).toHaveBeenCalledExactlyOnceWith(observation)

    const other = engine()
    await serveMatrixSdk({ ...host, undecryptable: undefined }, other.start).started
    expect(() => other.calls.undecryptable!(observation)).not.toThrow()
  })

  it('offers an unknown Google-fence observation when startup fails', async () => {
    const googleFence = vi.fn()

    const host: MatrixSdkHostPort = {
      configuration: async () => configuration,
      refresh: async () => ({ ok: true, accessToken: 'new', refreshToken: 'next' }),
      snapshot: vi.fn(),
      invocation: vi.fn(),
      googleFence,
      commands: vi.fn(),
      result: vi.fn()
    }

    const start = vi.fn(async () => {
      throw new Error('raw detail')
    }) as unknown as NonNullable<Engine>

    await serveMatrixSdk(host, start).started.catch(() => {})
    expect(googleFence).toHaveBeenCalledExactlyOnceWith({ state: 'unknown' })
  })

  it("serves the engine with the host's identity and answers commands, without IPC", async () => {
    const host = localHost()
    const destroy = vi.fn()
    const { port, queue } = connectMatrixSdk(host, destroy)
    const fake = engine()
    const { started } = serveMatrixSdk(port, fake.start)
    await started

    expect(fake.start).toHaveBeenCalledWith(
      configuration,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    )
    // The identity arrives as a copy, as over IPC: the engine holds nothing of the host's.
    expect(vi.mocked(fake.start).mock.calls[0]![0]).not.toBe(configuration)
    await expect(queue.command({ kind: 'devices', userId: '@agent:test' })).resolves.toEqual({ rooms: ['!a:test'] })
    expect(fake.sdk.command).toHaveBeenCalledWith({ kind: 'devices', userId: '@agent:test' })
  })

  it('copies every value that crosses, as IPC would', async () => {
    const host = localHost()
    const { port, queue } = connectMatrixSdk(host)
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started

    const watch = { kind: 'watchInvocations', watch: { roomId: '!a:test' } }
    const result = (await queue.command(watch)) as { rooms: string[] }
    // The controller changing its command, or the result it got, reaches nothing the SDK holds.
    watch.watch.roomId = '!changed:test'
    result.rooms.push('!changed:test')
    expect(fake.held.command).toEqual({ kind: 'watchInvocations', watch: { roomId: '!a:test' } })
    expect(fake.held.result).toEqual({ rooms: ['!a:test'] })

    const snapshot = {
      state: 'ready',
      identity: null,
      rooms: [],
      roomId: null,
      messages: [],
      error: null
    } as MatrixSnapshot

    fake.calls.publish!(snapshot)
    expect(host.snapshots).toEqual([snapshot])
    expect(host.snapshots[0]).not.toBe(snapshot)

    const hint = { watchId: 'watch', roomId: '!a:test', eventId: '$e' }
    fake.calls.offer!(hint as never)
    expect(host.hints).toEqual([hint])
    expect(host.hints[0]).not.toBe(hint)

    const appBotHint = { roomId: '!a:test', eventId: '$bot' }
    fake.calls.appBotEvent!(appBotHint)
    expect(host.appBotHints).toEqual([appBotHint])
    expect(host.appBotHints[0]).not.toBe(appBotHint)
  })

  it('refreshes through the host, and hands the engine a copy', async () => {
    const host = localHost()
    const tokens = { ok: true as const, accessToken: 'new', refreshToken: 'next' }
    vi.mocked(host.refresh).mockResolvedValue(tokens)
    const { port } = connectMatrixSdk(host)
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started
    const refresh = vi.mocked(fake.start).mock.calls[0]![1]

    const refreshed = await refresh('handle')
    expect(refreshed).toEqual(tokens)
    expect(refreshed).not.toBe(tokens)
    expect(host.refresh).toHaveBeenCalledWith('handle')
  })

  it("keeps the engine's event handling going when the host's handlers throw", async () => {
    const host = localHost()

    const snapshot = vi.fn(() => {
      throw new Error('store closed')
    })

    const { port } = connectMatrixSdk({ ...host, snapshot, invocation: snapshot })
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started

    const value = {
      state: 'ready',
      identity: null,
      rooms: [],
      roomId: null,
      messages: [],
      error: null
    } as MatrixSnapshot

    expect(() => fake.calls.publish!(value)).not.toThrow()
    expect(() => fake.calls.offer!({ watchId: 'w', roomId: '!a:test', eventId: '$e' } as never)).not.toThrow()
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('serves one engine per port, and refuses a second', async () => {
    const { port } = connectMatrixSdk(localHost())
    await serveMatrixSdk(port, engine().start).started

    expect(() => port.commands(() => {})).toThrow('matrix_sdk_already_served')
  })

  it('fails a command, never throws, where a browser offers no Web Crypto ids (not a secure context)', async () => {
    const { port, queue } = connectMatrixSdk(localHost())
    await serveMatrixSdk(port, engine().start).started

    const ids = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function')
    })

    try {
      let pending: Promise<unknown> | undefined
      expect(() => (pending = queue.command({ kind: 'devices', userId: '@agent:test' }))).not.toThrow()
      await expect(pending).rejects.toThrow('matrix_operation_failed')
    } finally {
      ids.mockRestore()
    }
  })

  it('stops the engine, closes the queue once, and refuses later commands', async () => {
    const destroy = vi.fn()
    const { port, queue } = connectMatrixSdk(localHost(), destroy)
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started

    await queue.stop()
    expect(fake.sdk.stop).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
    await expect(queue.command({ kind: 'devices', userId: '@agent:test' })).rejects.toThrow('matrix_sdk_stopped')
  })

  it('reports a failed start to the host and fails commands, with nothing raw', async () => {
    const host = localHost()
    const { port, queue } = connectMatrixSdk(host)

    const start = vi.fn(async () => {
      throw new Error('raw detail')
    }) as unknown as NonNullable<Engine>

    await serveMatrixSdk(port, start).started.catch(() => {})

    await vi.waitFor(() => expect(host.snapshots.at(-1)?.error).toBe('matrix_sdk_start_failed'))
    await expect(queue.command({ kind: 'devices', userId: '@agent:test' })).rejects.toThrow('matrix_operation_failed')
    expect(JSON.stringify(host.snapshots)).not.toContain('raw detail')
  })

  it('fails at once a command sent before the SDK is served, and a result that cannot be copied', async () => {
    const { port, queue } = connectMatrixSdk(localHost())
    await expect(queue.command({ kind: 'devices', userId: '@agent:test' })).rejects.toThrow('matrix_operation_failed')

    const fake = engine()
    fake.sdk.command.mockResolvedValueOnce({ callback: () => {} } as never)
    await serveMatrixSdk(port, fake.start).started
    await expect(queue.command({ kind: 'devices', userId: '@agent:test' })).rejects.toThrow('matrix_operation_failed')
  })

  it("lets the Founder chat's two refusals through by code, and nothing else an error says", async () => {
    const { port, queue } = connectMatrixSdk(localHost())
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started

    for (const code of ['matrix_founder_unready', 'matrix_founder_recipient_unready']) {
      fake.sdk.command.mockRejectedValueOnce(new Error(code))
      await expect(queue.command({ kind: 'send', roomId: '!founder:test', body: 'hi' })).rejects.toThrow(code)
    }

    // A code-shaped message that is not on the list, or a code inside other words, stays generic.
    for (const raw of ['matrix_not_ready', 'matrix_founder_unready: device ABC', 'private detail']) {
      fake.sdk.command.mockRejectedValueOnce(new Error(raw))
      const failed = queue.command({ kind: 'send', roomId: '!founder:test', body: 'hi' })
      await expect(failed).rejects.toThrow('matrix_operation_failed')
      await expect(failed).rejects.not.toThrow(raw)
    }
  })

  it('preserves the assembled bot and Store refusals through the served command queue', async () => {
    const { port, queue } = connectMatrixSdk(localHost())
    const fake = engine()
    await serveMatrixSdk(port, fake.start).started

    for (const [command, code] of [
      [{ kind: 'appBotRooms' }, 'matrix_app_bot_mode_required'],
      [{ kind: 'storeRunsRead', assistantId: 'proof' }, 'matrix_store_runs_readonly'],
      [{ kind: 'devices', userId: '@app-moon:test' }, 'matrix_bot_device_keys_mismatch'],
      [{ kind: 'attach', roomId: '!room:test', name: 'large.pdf', bytes: new Uint8Array() }, 'matrix_file_invalid'],
      [{ kind: 'attach', roomId: '!room:test', name: 'slow.pdf', bytes: new Uint8Array() }, 'matrix_send_failed']
    ] as const) {
      fake.sdk.command.mockRejectedValueOnce(new Error(code))
      await expect(queue.command(command)).rejects.toThrow(code)
    }

    fake.sdk.command.mockRejectedValueOnce(new Error('matrix_bot_device_keys_mismatch:syt_secret_token'))
    const refused = queue.command({ kind: 'appBotRooms' })
    await expect(refused).rejects.toThrow('matrix_operation_failed')
    await expect(refused).rejects.not.toThrow('syt_secret_token')
    await queue.stop()
  })

  it('keeps a failure from the far side of IPC to the same short list', () => {
    const sent: string[] = []
    const queue = new MatrixSdkHost(id => void sent.push(id), () => {})
    const refused = queue.command({ kind: 'send', roomId: '!founder:test', body: 'hi' })
    const other = queue.command({ kind: 'send', roomId: '!founder:test', body: 'hi' })
    queue.result(sent[0]!, false, 'matrix_founder_unready')
    queue.result(sent[1]!, false, { code: 'matrix_founder_unready' })

    return Promise.all([
      expect(refused).rejects.toThrow('matrix_founder_unready'),
      expect(other).rejects.toThrow('matrix_operation_failed')
    ])
  })

  it("times a command out as the desktop's queue does", async () => {
    vi.useFakeTimers()
    const { port, queue } = connectMatrixSdk(localHost())
    const fake = engine()
    fake.sdk.command.mockReturnValue(new Promise(() => {}))
    await serveMatrixSdk(port, fake.start).started

    const pending = queue.command({ kind: 'devices', userId: '@agent:test' }, 1_000).catch(error => error.message)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBe('matrix_operation_timeout')
    queue.close()
  })

  it('keeps media-bearing commands alive past 30 seconds for bounded SDK transfer', async () => {
    vi.useFakeTimers()
    let id = ''

    const queue = new MatrixSdkHost(next => {
      id = next
    }, vi.fn())

    const attachment = { kind: 'attach', roomId: '!room:test', name: 'report.pdf', bytes: new Uint8Array([1]) }

    expect(matrixSdkCommandTimeout({ kind: 'rooms' })).toBe(MATRIX_SDK_COMMAND_TIMEOUT_MS)
    expect(matrixSdkCommandTimeout(attachment)).toBe(MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS)
    expect(matrixSdkCommandTimeout({ kind: 'appBotReadMedia' })).toBe(MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS)
    expect(matrixSdkCommandTimeout({ kind: 'appBotApiSend', photo: { bytes_base64: 'AA==' } })).toBe(MATRIX_SDK_ATTACHMENT_COMMAND_TIMEOUT_MS)
    expect(matrixSdkCommandTimeout({ kind: 'appBotApiSend' })).toBe(MATRIX_SDK_COMMAND_TIMEOUT_MS)

    const pending = queue.command(attachment, matrixSdkCommandTimeout(attachment))
    await vi.advanceTimersByTimeAsync(MATRIX_SDK_COMMAND_TIMEOUT_MS + 1_000)
    queue.result(id, true, '$sent-once')

    await expect(pending).resolves.toBe('$sent-once')
    queue.close()
  })

  it('lets opening an official bot’s chat spend its wait for the room on top of the ordinary bound', async () => {
    vi.useFakeTimers()
    let id = ''
    const queue = new MatrixSdkHost(next => { id = next }, vi.fn())
    const open = { kind: 'openAppBotDm', appId: 'app', botUserId: '@bot:test' }

    // The SDK ends the wait with its own closed code at APP_BOT_ROOM_WAIT_MS; the queue's bound must
    // not cut it short, and still bounds the command when the SDK says nothing.
    for (const command of [open, { kind: 'openAppBotRoom', appId: 'app', botUserId: '@bot:test', roomId: '!r:test' }]) {
      expect(matrixSdkCommandTimeout(command)).toBe(MATRIX_SDK_COMMAND_TIMEOUT_MS + APP_BOT_ROOM_WAIT_MS)
    }

    // The other steps of an app's chat keep the ordinary bound.
    for (const kind of ['findAppBotDm', 'makeAppBotDm', 'leaveAppBotDm']) {
      expect(matrixSdkCommandTimeout({ kind, appId: 'app', botUserId: '@bot:test' })).toBe(MATRIX_SDK_COMMAND_TIMEOUT_MS)
    }

    const pending = queue.command(open, matrixSdkCommandTimeout(open))
    await vi.advanceTimersByTimeAsync(MATRIX_SDK_COMMAND_TIMEOUT_MS + 1_000)
    queue.result(id, false, 'matrix_app_bot_syncing')

    await expect(pending).rejects.toThrow('matrix_app_bot_syncing')
    queue.close()
  })
})

it('reports ordinary pending SDK work for native policy-change admission', async () => {
  let id = ''
  const queue = new MatrixSdkHost(next => { id = next }, vi.fn())
  expect(queue.busy).toBe(false)
  const sent = queue.command({ kind: 'send', roomId: '!room:test', body: 'Draft' })
  expect(queue.busy).toBe(true)
  queue.result(id, true, '$sent')
  await expect(sent).resolves.toBe('$sent')
  expect(queue.busy).toBe(false)
  const pending = queue.command({ kind: 'devices', userId: '@owner:test' })
  const refused = expect(pending).rejects.toThrow('matrix_sdk_stopped')
  queue.close()
  await refused
  expect(queue.busy).toBe(false)
})
