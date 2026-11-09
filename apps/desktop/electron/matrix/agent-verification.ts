import type { MatrixDevice, MatrixIdentity } from '../../shared/matrix'
import type { MatrixNativeSecurityCommand, MatrixSecurityCommand, MatrixVerification } from '../../shared/matrix-security'

/** A native SDK host used solely for owner-to-owned-agent SAS verification. */
export interface MatrixAgentVerificationPort {
  identity: MatrixIdentity
  command(
    value:
      | MatrixSecurityCommand
      | Extract<MatrixNativeSecurityCommand, { kind: 'agentVerificationStart' | 'securityStatus' }>
      | { kind: 'devices'; userId: string }
  ): Promise<unknown>
}

export interface MatrixAgentVerificationOptions {
  /** Tests may advance a deterministic clock instead of waiting for the network. */
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  /** Capped at one minute even when a caller accidentally asks for more. */
  timeoutMs?: number
  pollMs?: number
}

const MAX_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 100
const SAS_DECIMAL_MIN = 1_000
const SAS_DECIMAL_MAX = 9_191

type BoundIdentity = Readonly<MatrixIdentity>
type BoundDevice = Readonly<MatrixDevice>
type Pair = { owner: MatrixVerification; agent: MatrixVerification }

function failure(code: string): Error {
  return new Error(`matrix_agent_verification_${code}`)
}

/**
 * A cancelled handshake fails at once, naming the protocol's code and which side ended it
 * (`matrix_agent_verification_cancelled:m.key_mismatch:owner`): an owner that cancels right
 * after the agent's MAC is a device whose keys changed under the same ID, not a slow network.
 */
function cancelled(request: MatrixVerification, host: 'owner' | 'agent'): Error {
  const code =
    typeof request.cancelCode === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(request.cancelCode)
      ? request.cancelCode
      : 'unknown'

  const other = host === 'owner' ? 'agent' : 'owner'
  const by = request.cancelledBy === 'self' ? host : request.cancelledBy === 'peer' ? other : 'unknown'

  return failure(`cancelled:${code}:${by}`)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function identity(value: MatrixIdentity): BoundIdentity {
  if (typeof value?.userId !== 'string' || !value.userId || typeof value.deviceId !== 'string' || !value.deviceId) {
    throw failure('identity')
  }

  return { userId: value.userId, deviceId: value.deviceId }
}

function sameIdentity(left: MatrixIdentity, right: BoundIdentity): boolean {
  return left?.userId === right.userId && left?.deviceId === right.deviceId
}

function device(value: unknown, expected: BoundIdentity): BoundDevice | undefined {
  const row = object(value)

  if (
    !row ||
    row.userId !== expected.userId ||
    row.deviceId !== expected.deviceId ||
    typeof row.fingerprint !== 'string' ||
    !row.fingerprint ||
    typeof row.verified !== 'boolean'
  ) {
    return undefined
  }

  return {
    userId: expected.userId,
    deviceId: expected.deviceId,
    fingerprint: row.fingerprint,
    verified: row.verified
  }
}

function verification(value: unknown): MatrixVerification | undefined {
  const request = object(value)
  const recovery = new Set(['idle', 'working', 'ready', 'failed'])

  if (!request || typeof request.recovery !== 'string' || !recovery.has(request.recovery)) {
    throw failure('malformed')
  }

  if (request.verification === undefined) {
    return undefined
  }

  const current = object(request.verification)
  const states = new Set(['requested', 'ready', 'started', 'compare', 'done', 'cancelled'])

  if (
    !current ||
    typeof current.id !== 'string' ||
    !current.id ||
    typeof current.userId !== 'string' ||
    !current.userId ||
    typeof current.deviceId !== 'string' ||
    typeof current.incoming !== 'boolean' ||
    typeof current.state !== 'string' ||
    !states.has(current.state) ||
    (current.decimals !== undefined && !Array.isArray(current.decimals))
  ) {
    throw failure('malformed')
  }

  return current as unknown as MatrixVerification
}

function exactDecimals(value: number[] | undefined): readonly [number, number, number] | undefined {
  if (
    !value ||
    value.length !== 3 ||
    !value.every(decimal => Number.isInteger(decimal) && decimal >= SAS_DECIMAL_MIN && decimal <= SAS_DECIMAL_MAX)
  ) {
    return undefined
  }

  return [value[0], value[1], value[2]]
}

function sameDecimals(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Runs the normal Matrix SAS handshake between exactly the two native-owned SDK
 * hosts. It intentionally consumes only local SDK snapshots and device lists:
 * room events, renderer values and remote trust state are never authority here.
 */
export async function verifyOwnedMatrixAgent(
  owner: MatrixAgentVerificationPort,
  agent: MatrixAgentVerificationPort,
  assertCurrent: () => void,
  options: MatrixAgentVerificationOptions = {}
): Promise<void> {
  const ownerIdentity = identity(owner.identity)
  const agentIdentity = identity(agent.identity)

  if (ownerIdentity.userId === agentIdentity.userId && ownerIdentity.deviceId === agentIdentity.deviceId) {
    throw failure('self')
  }

  const now = options.now ?? Date.now
  const wait = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? MAX_TIMEOUT_MS))
  const pollMs = Math.max(1, Math.min(timeoutMs, options.pollMs ?? DEFAULT_POLL_MS))
  const deadline = now() + timeoutMs
  let ownerRequestId: string | undefined
  let agentRequestId: string | undefined
  let ownerDevice: BoundDevice | undefined
  let agentDevice: BoundDevice | undefined
  const ignoredOwnerTerminalIds = new Set<string>()
  const ignoredAgentTerminalIds = new Set<string>()
  let stopped = false

  const current = () => {
    if (stopped) {
      throw failure('stopped')
    }

    assertCurrent()

    if (!sameIdentity(owner.identity, ownerIdentity) || !sameIdentity(agent.identity, agentIdentity)) {
      throw failure('stale')
    }

    if (now() >= deadline) {
      stopped = true
      throw failure('timeout')
    }
  }

  const beforeDeadline = current

  const command = async (
    port: MatrixAgentVerificationPort,
    value: Parameters<MatrixAgentVerificationPort['command']>[0]
  ) => {
    beforeDeadline()
    const result = await port.command(value)
    current()

    return result
  }

  const readDevice = async (port: MatrixAgentVerificationPort, expected: BoundIdentity): Promise<BoundDevice> => {
    const result = await command(port, { kind: 'devices', userId: expected.userId })

    if (!Array.isArray(result)) {
      throw failure('devices')
    }

    const matches = result.map(row => device(row, expected)).filter((row): row is BoundDevice => Boolean(row))

    if (matches.length !== 1) {
      throw failure('device')
    }

    return matches[0]
  }

  const guardDevices = async () => {
    const currentOwner = await readDevice(owner, ownerIdentity)
    const currentAgent = await readDevice(agent, agentIdentity)

    if (!ownerDevice || !agentDevice) {
      ownerDevice = currentOwner
      agentDevice = currentAgent
    } else if (
      ownerDevice.fingerprint !== currentOwner.fingerprint ||
      agentDevice.fingerprint !== currentAgent.fingerprint
    ) {
      throw failure('fingerprint_changed')
    }
  }

  const readSecurity = async (port: MatrixAgentVerificationPort): Promise<MatrixVerification | undefined> => {
    const status = await command(port, { kind: 'securityStatus' })

    return verification(status)
  }

  const observe = (
    request: MatrixVerification | undefined,
    peer: BoundIdentity,
    incoming: boolean,
    id: string | undefined,
    ignoredTerminalIds: ReadonlySet<string>,
    allowDone: boolean
  ) => {
    if (!request) {
      if (id) {
        throw failure('request_replaced')
      }

      return undefined
    }

    if (request.state === 'done' || request.state === 'cancelled') {
      if (ignoredTerminalIds.has(request.id)) {
        return undefined
      }

      // A cancel is final on either side: never wait out the deadline for a "done" that the
      // other side has already refused.
      if (request.state === 'cancelled') {
        throw cancelled(request, incoming ? 'agent' : 'owner')
      }

      if (allowDone && id === request.id) {
        return request
      }

      throw failure('state')
    }

    if (ignoredTerminalIds.has(request.id)) {
      throw failure('request_reused')
    }

    // Rust leaves an outgoing request's otherDeviceId empty until the peer
    // accepts. Main already targeted that exact device. An incoming request,
    // or anything beyond Requested, must carry the full bound device ID.
    const waitingForAccept = !incoming && request.state === 'requested' && request.deviceId === ''

    if (
      request.userId !== peer.userId ||
      (!waitingForAccept && request.deviceId !== peer.deviceId) ||
      request.incoming !== incoming
    ) {
      throw failure('peer')
    }

    if (id && request.id !== id) {
      throw failure('request_replaced')
    }

    return request
  }

  const pair = async (allowDone = false): Promise<Pair | undefined> => {
    const ownerRequest = observe(
      await readSecurity(owner),
      agentIdentity,
      false,
      ownerRequestId,
      ignoredOwnerTerminalIds,
      allowDone
    )

    if (ownerRequest) {
      beforeDeadline()
      ownerRequestId ??= ownerRequest.id
    }

    const agentRequest = observe(
      await readSecurity(agent),
      ownerIdentity,
      true,
      agentRequestId,
      ignoredAgentTerminalIds,
      allowDone
    )

    if (agentRequest) {
      beforeDeadline()
      agentRequestId ??= agentRequest.id
    }

    return ownerRequest && agentRequest ? { owner: ownerRequest, agent: agentRequest } : undefined
  }

  const waitFor = async (predicate: (requests: Pair) => boolean, allowDone = false): Promise<Pair> => {
    for (;;) {
      beforeDeadline()
      const requests = await pair(allowDone)

      if (requests && predicate(requests)) {
        return requests
      }

      if (!allowDone && requests && (requests.owner.state === 'done' || requests.agent.state === 'done')) {
        throw failure('state')
      }

      beforeDeadline()
      await wait(Math.min(pollMs, Math.max(1, deadline - now())))
      current()
    }
  }

  const cancelTracked = () => {
    // A stale/replaced host must never receive an action, even a cancellation.
    let live = false

    try {
      assertCurrent()
      live = sameIdentity(owner.identity, ownerIdentity) && sameIdentity(agent.identity, agentIdentity)
    } catch {
      // The failure path must not send a command to a replacement host.
    }

    if (live && ownerRequestId) {
      void owner.command({ kind: 'verificationRespond', id: ownerRequestId, action: 'cancel' }).catch(() => {})
    }

    if (live && agentRequestId) {
      void agent.command({ kind: 'verificationRespond', id: agentRequestId, action: 'cancel' }).catch(() => {})
    }
  }

  const run = async () => {
    current()
    await guardDevices()

    // An existing request may belong to another device or an older enrollment;
    // do not adopt, cancel or otherwise disturb it.
    const priorOwner = await readSecurity(owner)
    const priorAgent = await readSecurity(agent)

    if (priorOwner?.state === 'done' || priorOwner?.state === 'cancelled') {
      ignoredOwnerTerminalIds.add(priorOwner.id)
    } else if (priorOwner) {
      throw failure('existing')
    }

    if (priorAgent?.state === 'done' || priorAgent?.state === 'cancelled') {
      ignoredAgentTerminalIds.add(priorAgent.id)
    } else if (priorAgent) {
      throw failure('existing')
    }

    beforeDeadline()
    await guardDevices()
    await command(owner, {
      kind: 'agentVerificationStart',
      userId: agentIdentity.userId,
      deviceId: agentIdentity.deviceId
    })

    const accepting = await waitFor(requests => requests.agent.state === 'requested')
    await guardDevices()
    await command(agent, { kind: 'verificationRespond', id: accepting.agent.id, action: 'accept' })

    const ready = await waitFor(requests => requests.owner.state === 'ready' && requests.agent.state === 'ready')
    await guardDevices()

    // Re-observe after the fingerprint guard so this command can only target the
    // stable request just proven to be ready.
    const starting = await waitFor(
      requests =>
        requests.owner.id === ready.owner.id && requests.owner.state === 'ready' && requests.agent.state === 'ready'
    )

    await guardDevices()
    await command(owner, { kind: 'verificationRespond', id: starting.owner.id, action: 'start' })

    const comparing = await waitFor(
      requests => requests.owner.state === 'compare' && requests.agent.state === 'compare'
    )

    const ownerDecimals = exactDecimals(comparing.owner.decimals)
    const agentDecimals = exactDecimals(comparing.agent.decimals)

    if (!ownerDecimals || !agentDecimals || !sameDecimals(ownerDecimals, agentDecimals)) {
      throw failure('sas_mismatch')
    }

    const confirming = await waitFor(
      requests =>
        requests.owner.state === 'compare' &&
        requests.agent.state === 'compare' &&
        sameDecimals(exactDecimals(requests.owner.decimals) ?? [], ownerDecimals) &&
        sameDecimals(exactDecimals(requests.agent.decimals) ?? [], agentDecimals)
    )

    await guardDevices()
    await Promise.all([
      command(owner, { kind: 'verificationRespond', id: confirming.owner.id, action: 'confirm' }),
      command(agent, { kind: 'verificationRespond', id: confirming.agent.id, action: 'confirm' })
    ])

    await waitFor(requests => requests.owner.state === 'done' && requests.agent.state === 'done', true)
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true
      reject(failure('timeout'))
    }, timeoutMs)
  })

  try {
    await Promise.race([run(), timedOut])
  } catch (error) {
    stopped = true
    // Best-effort terminal cancellation must not hold the native security queue
    // beyond the deadline when the failed SDK endpoint is itself unresponsive.
    cancelTracked()
    throw error
  } finally {
    stopped = true

    if (timer) {
      clearTimeout(timer)
    }
  }
}
