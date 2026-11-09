import { expect, it } from 'vitest'

import {
  formatMatrixGoogleFenceFailure,
  MatrixGoogleFenceFailure,
  MatrixGoogleFenceNotices,
  type MatrixGoogleFenceOwner,
  matrixGoogleFenceSender,
  matrixGoogleFenceSenderRefused
} from './google-fence'
import { MatrixGoogleFenceLog } from './google-fence-log'
import type { MatrixLocalBrain } from './local-brain'

const ACCOUNT_A = 'a'.repeat(64)
const ACCOUNT_B = 'b'.repeat(64)

interface Deferred<T> {
  promise: Promise<T>
  reject(error: Error): void
  resolve(value: T): void
}

interface BrainCall {
  method: string
  owner: MatrixGoogleFenceOwner
  params: unknown
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, reject, resolve }
}

function owner(accountKey = ACCOUNT_A): MatrixGoogleFenceOwner {
  return {
    accountKey,
    generation: 1,
    host: {},
    identity: { userId: '@owner:test', deviceId: 'DEVICE' }
  }
}

function active(since: number) {
  return { fence: { active: true, since } }
}

function inactive() {
  return { fence: { active: false, since: null } }
}

function fence(since: number) {
  return { active: true, since }
}

function fixture(overrides: { ready?: boolean } = {}) {
  let current: MatrixGoogleFenceOwner | null = owner()
  let ready = overrides.ready ?? true
  const calls: BrainCall[] = []
  const replies: Array<(call: BrainCall) => Promise<unknown> | unknown> = []

  const brain: Pick<MatrixLocalBrain, 'call' | 'ready'> = {
    ready: () => ready,
    call: (bound, method, params) => {
      const native = bound as MatrixGoogleFenceOwner
      const call = { method, owner: { ...native, identity: { ...native.identity } }, params }
      calls.push(call)
      const next = replies.shift()

      if (!next) {
        return Promise.reject(new Error('unexpected_brain_call'))
      }

      return Promise.resolve(next(call))
    }
  }

  const notices = new MatrixGoogleFenceNotices(brain, () => current)

  return {
    calls,
    notices,
    reply(value: (call: BrainCall) => Promise<unknown> | unknown) {
      replies.push(value)
    },
    setOwner(value: MatrixGoogleFenceOwner | null) {
      current = value
    },
    setReady(value: boolean) {
      ready = value
    }
  }
}

async function settled() {
  await Promise.resolve()
  await Promise.resolve()
}

it('reports a whitelisted local-brain RPC failure with its exact stage and code', async () => {
  const f = fixture()
  f.reply(() => Promise.reject(new Error('matrix_local_brain_request_outcome_unknown')))

  const error = await f.notices.observe({ state: 'current', since: 50 }).catch(error => error)

  expect(error).toMatchObject({
    stage: 'initial_info_rpc',
    code: 'matrix_local_brain_request_outcome_unknown',
    message: 'matrix_local_brain_request_outcome_unknown'
  })
  expect(formatMatrixGoogleFenceFailure(error)).toBe(
    '[Matrix] google_fence_unavailable stage=initial_info_rpc code=matrix_local_brain_request_outcome_unknown'
  )
})

it.each([
  {
    name: 'fence RPC',
    replies: [() => inactive(), () => Promise.reject(new Error('matrix_local_brain_owner_invalid'))],
    stage: 'fence_rpc',
    code: 'matrix_local_brain_owner_invalid'
  },
  {
    name: 'fence acknowledgement',
    replies: [() => inactive(), () => inactive()],
    stage: 'fence_ack',
    code: 'rpc_failed'
  },
  {
    name: 'verify RPC',
    replies: [() => inactive(), () => fence(50), () => Promise.reject(new Error('matrix_local_brain_spawn_failed'))],
    stage: 'verify_rpc',
    code: 'matrix_local_brain_spawn_failed'
  },
  {
    name: 'verify receipt',
    replies: [() => inactive(), () => fence(50), () => active(80)],
    stage: 'verify_receipt',
    code: 'rpc_failed'
  }
])('reports the $name stage without changing fence behavior', async ({ replies, stage, code }) => {
  const f = fixture()

  for (const reply of replies) {
    f.reply(reply)
  }

  const error = await f.notices.observe({ state: 'current', since: 50 }).catch(error => error)

  expect(error).toMatchObject({ stage, code })
  expect(formatMatrixGoogleFenceFailure(error)).toBe(
    `[Matrix] google_fence_unavailable stage=${stage} code=${code}`
  )
})

it('reports receipt failures by the initial receipt stage without changing the compatible error message', async () => {
  const f = fixture()
  f.reply(() => ({ fence: { active: true, since: 'bad' } }))

  const error = await f.notices.observe({ state: 'current', since: 50 }).catch(error => error)

  expect(error).toMatchObject({
    stage: 'initial_info_receipt',
    code: 'rpc_failed',
    message: 'matrix_google_fence_receipt_invalid'
  })
  expect(formatMatrixGoogleFenceFailure(error)).toBe(
    '[Matrix] google_fence_unavailable stage=initial_info_receipt code=rpc_failed'
  )
})

it('sanitizes an unknown RPC error while retaining the actual RPC stage', async () => {
  const f = fixture()
  f.reply(() => Promise.reject(new Error('PRIVATE_SMOKE_CONTENT')))

  const error = await f.notices.observe({ state: 'current', since: 50 }).catch(error => error)
  const diagnostic = formatMatrixGoogleFenceFailure(error)

  expect(error).toMatchObject({ stage: 'initial_info_rpc', code: 'rpc_failed' })
  expect(diagnostic).toBe('[Matrix] google_fence_unavailable stage=initial_info_rpc code=rpc_failed')
  expect(diagnostic).not.toContain('PRIVATE_SMOKE_CONTENT')
})

it('classifies a synchronous local-brain call failure with a whitelisted code', async () => {
  const f = fixture()
  f.reply(() => { throw new Error('matrix_local_brain_owner_invalid') })

  const error = await f.notices.observe({ state: 'current', since: 50 }).catch(error => error)

  expect(error).toMatchObject({
    stage: 'initial_info_rpc',
    code: 'matrix_local_brain_owner_invalid',
    message: 'matrix_local_brain_owner_invalid'
  })
})

it('keeps validation distinct from an unclassified formatter fallback', async () => {
  const f = fixture()
  const validation = await f.notices.observe({ state: 'current', since: -1 }).catch(error => error)
  const forged = new MatrixGoogleFenceFailure('validation', 'rpc_failed', 'safe')
  Object.assign(forged, { stage: 'PRIVATE_SMOKE_CONTENT', code: 'PRIVATE_SMOKE_CONTENT' })

  expect(formatMatrixGoogleFenceFailure(validation)).toBe(
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed'
  )

  for (const error of [
    new Error('PRIVATE_SMOKE_CONTENT'),
    new Error('matrix_local_brain_unavailable PRIVATE_SMOKE_CONTENT'),
    forged
  ]) {
    const diagnostic = formatMatrixGoogleFenceFailure(error)

    expect(diagnostic).toBe('[Matrix] google_fence_unavailable stage=unclassified code=rpc_failed')
    expect(diagnostic).not.toContain('PRIVATE_SMOKE_CONTENT')
  }
})

it('sends only additive notices for the earliest valid observation', async () => {
  const f = fixture()

  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.observe({ state: 'current', since: 50 })

  f.reply(() => active(50))
  await f.notices.observe({ state: 'current', since: 80 })

  f.reply(() => active(50))
  f.reply(() => fence(20))
  f.reply(() => active(20))
  await f.notices.observe({ state: 'current', since: 20 })

  expect(f.calls.map(call => [call.method, call.params])).toEqual([
    ['brain.info', undefined],
    ['brain.fence', { v: 1, since: 50 }],
    ['brain.info', undefined],
    ['brain.info', undefined],
    ['brain.info', undefined],
    ['brain.fence', { v: 1, since: 20 }],
    ['brain.info', undefined]
  ])
})

it('accepts an earlier persisted provider fence without sending a later notice', async () => {
  const f = fixture()
  f.reply(() => active(10))

  await f.notices.observe({ state: 'current', since: 50 })

  expect(f.calls.map(call => call.method)).toEqual(['brain.info'])
})

it('does not turn unknown, absence, or malformed observations into a notice', async () => {
  const f = fixture()

  await f.notices.observe({ state: 'unknown' })
  await f.notices.observe({ state: 'current', since: null })
  await expect(f.notices.observe({ state: 'current', since: -1 })).rejects.toThrow('matrix_google_fence_invalid')
  await expect(f.notices.observe({ state: 'current', since: 1, extra: true })).rejects.toThrow('matrix_google_fence_invalid')

  expect(f.calls).toEqual([])
})

it.each([
  ['info', [() => ({ fence: { active: true, since: 'bad' } })]],
  ['ack', [() => inactive(), () => ({ active: true, since: 'bad' })]]
])('retains a failed %s receipt for explicit reconciliation without automatic restart', async (_kind, malformed) => {
  const f = fixture()

  for (const reply of malformed) {
    f.reply(reply)
  }

  await expect(f.notices.observe({ state: 'current', since: 50 })).rejects.toThrow('matrix_google_fence_receipt_invalid')
  const failedCalls = f.calls.length
  await Promise.resolve()
  expect(f.calls).toHaveLength(failedCalls)

  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.reconcile()

  expect(f.calls.slice(failedCalls).map(call => [call.method, call.params])).toEqual([
    ['brain.info', undefined],
    ['brain.fence', { v: 1, since: 50 }],
    ['brain.info', undefined]
  ])
})

it('holds a valid notice until an explicit reconcile finds the provider ready', async () => {
  const f = fixture({ ready: false })

  await f.notices.observe({ state: 'current', since: 50 })
  expect(f.calls).toEqual([])

  f.setReady(true)
  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.reconcile()

  expect(f.calls.map(call => call.method)).toEqual(['brain.info', 'brain.fence', 'brain.info'])
})

it('coalesces an earlier notice arriving while provider info awaits', async () => {
  const f = fixture()
  const info = deferred<unknown>()
  f.reply(() => info.promise)

  const first = f.notices.observe({ state: 'current', since: 50 })
  const second = f.notices.observe({ state: 'current', since: 20 })
  f.reply(() => fence(20))
  f.reply(() => active(20))
  f.reply(() => active(20))
  info.resolve(inactive())
  await Promise.all([first, second])

  expect(f.calls.map(call => [call.method, call.params])).toEqual([
    ['brain.info', undefined],
    ['brain.fence', { v: 1, since: 20 }],
    ['brain.info', undefined],
    ['brain.info', undefined]
  ])
})

it('retains a lost acknowledgement for explicit restart and reconcile only', async () => {
  const f = fixture()
  f.reply(() => inactive())
  f.reply(() => Promise.reject(new Error('matrix_local_brain_request_outcome_unknown')))

  await expect(f.notices.observe({ state: 'current', since: 50 })).rejects.toThrow('matrix_local_brain_request_outcome_unknown')
  const failedCalls = f.calls.length
  await Promise.resolve()
  expect(f.calls).toHaveLength(failedCalls)

  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.reconcile()

  expect(f.calls.at(-2)).toMatchObject({ method: 'brain.fence', params: { v: 1, since: 50 } })
})

it.each(['host', 'userId', 'deviceId', 'accountKey', 'generation'] as const)(
  'drops a stale owner change after %s during provider info',
  async field => {
    const f = fixture()
    const info = deferred<unknown>()
    f.reply(() => info.promise)
    const pending = f.notices.observe({ state: 'current', since: 50 })
    const before = f.calls[0]!.owner
    const next = owner(field === 'accountKey' ? ACCOUNT_B : ACCOUNT_A)
    next.generation = field === 'generation' ? 2 : before.generation
    next.host = field === 'host' ? {} : before.host
    next.identity = {
      userId: field === 'userId' ? '@other:test' : before.identity.userId,
      deviceId: field === 'deviceId' ? 'OTHER' : before.identity.deviceId
    }
    f.setOwner(next)
    info.resolve(inactive())

    await pending
    expect(f.calls.map(call => call.method)).toEqual(['brain.info'])
  }
)

it.each(['host', 'userId', 'deviceId', 'accountKey', 'generation'] as const)(
  'drops a stale owner change after %s during a fence acknowledgement',
  async field => {
    const f = fixture()
    const ack = deferred<unknown>()
    f.reply(() => inactive())
    f.reply(() => ack.promise)
    const pending = f.notices.observe({ state: 'current', since: 50 })
    await settled()
    const before = f.calls[1]!.owner
    const next = owner(field === 'accountKey' ? ACCOUNT_B : ACCOUNT_A)
    next.generation = field === 'generation' ? 2 : before.generation
    next.host = field === 'host' ? {} : before.host
    next.identity = {
      userId: field === 'userId' ? '@other:test' : before.identity.userId,
      deviceId: field === 'deviceId' ? 'OTHER' : before.identity.deviceId
    }
    f.setOwner(next)
    ack.resolve(fence(50))

    await pending
    expect(f.calls.map(call => call.method)).toEqual(['brain.info', 'brain.fence'])
  }
)

it('keeps account notices isolated across account-root changes', async () => {
  const f = fixture()
  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.observe({ state: 'current', since: 50 })

  f.setOwner(owner(ACCOUNT_B))
  f.reply(() => inactive())
  f.reply(() => fence(20))
  f.reply(() => active(20))
  await f.notices.observe({ state: 'current', since: 20 })

  f.setOwner(owner(ACCOUNT_A))
  f.reply(() => inactive())
  f.reply(() => fence(50))
  f.reply(() => active(50))
  await f.notices.reconcile()

  expect(f.calls.filter(call => call.method === 'brain.fence').map(call => [call.owner.accountKey, call.params])).toEqual([
    [ACCOUNT_A, { v: 1, since: 50 }],
    [ACCOUNT_B, { v: 1, since: 20 }],
    [ACCOUNT_A, { v: 1, since: 50 }]
  ])
})

it('drops agent and app hosts\' observations without a word, and refuses only a stranger human host', () => {
  const humanHost = {}
  const fenceOwner = { host: humanHost }

  // Six agent hosts sync every 30 seconds: none of that is the owner's fence, or a failure.
  for (const role of ['agent', 'agent:alfred', 'app:moon']) {
    expect(matrixGoogleFenceSender(role, {}, fenceOwner)).toBe('ignore')
  }

  // No fence owner yet (the local brain isn't active): nowhere to deliver, nothing to log.
  expect(matrixGoogleFenceSender('human', humanHost, null)).toBe('ignore')
  expect(matrixGoogleFenceSender('human', humanHost, fenceOwner)).toBe('observe')
  expect(matrixGoogleFenceSender('human', {}, fenceOwner)).toBe('refuse')
  expect(formatMatrixGoogleFenceFailure(matrixGoogleFenceSenderRefused())).toBe(
    '[Matrix] google_fence_unavailable stage=sender code=rpc_failed'
  )
})

it('writes the first of each distinct fence failure, then one line per window counting the repeats', () => {
  const lines: string[] = []
  let now = 0
  const log = new MatrixGoogleFenceLog(line => lines.push(line), 10 * 60_000, () => now)
  const validation = new MatrixGoogleFenceFailure('validation', 'rpc_failed', 'matrix_google_fence_invalid')

  for (let sync = 0; sync < 40; sync++) {
    log.failure(validation)
    log.failure(new Error('raw text that must never be logged'))
    now += 30_000
  }

  expect(lines).toEqual([
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed',
    '[Matrix] google_fence_unavailable stage=unclassified code=rpc_failed',
    // Twenty syncs every ten minutes: one line that says so, this one included.
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed count=20',
    '[Matrix] google_fence_unavailable stage=unclassified code=rpc_failed count=20'
  ])
})

it('counts only what happened since its last line, and keeps distinct failures apart', () => {
  const lines: string[] = []
  let now = 0
  const log = new MatrixGoogleFenceLog(line => lines.push(line), 10 * 60_000, () => now)
  const validation = new MatrixGoogleFenceFailure('validation', 'rpc_failed', 'matrix_google_fence_invalid')
  const sender = matrixGoogleFenceSenderRefused()

  log.failure(validation)
  log.failure(validation)
  log.failure(sender)
  now += 10 * 60_000
  log.failure(validation)
  // An hour of quiet, then once more: one line, counting itself.
  now += 60 * 60_000
  log.failure(validation)

  expect(lines).toEqual([
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed',
    '[Matrix] google_fence_unavailable stage=sender code=rpc_failed',
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed count=2',
    '[Matrix] google_fence_unavailable stage=validation code=rpc_failed count=1'
  ])
})
