/**
 * The owner side of a cloud agent's identity handoff (atum.cloud-execution/1 §8; S1 WS-3b).
 *
 * Lifted unchanged in behaviour from `packages/browser-client/src/cloud-handoff.ts`, which now
 * imports it from here, so the desktop and the browser proof run one implementation. On the
 * desktop, Electron main drives it through the owner's own Matrix SDK host, so the enrollment's
 * `ownerDevice` is this Mac: it answers the cloud controller's `io.atum.agent_identity.request`
 * (restore: the agent's recovery key, to that device only) and `io.atum.agent_identity.escrow`
 * (store a new agent's key, only into the empty slot it derives itself), after checking every
 * binding against DA's enrollment list and its own roster. It keeps only the enrollment IDs its
 * own create or handoff calls returned, and never returns or retains a recovery key.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER = /^@[!-9;-~]+:[!-~]+$/
const DEVICE = /^[!-~]{1,255}$/
const NONCE = /^[A-Za-z0-9_-]{43}$/
const RECOVERY_KEY = /^[A-Za-z0-9 ]{1,256}$/
const SLOT = /^io\.atum\.agent-recovery\.[A-Za-z0-9_-]{1,1072}$/
const MAX_EVENTS = 32

export interface CloudHandoffEvent {
  type: string
  content: unknown
  senderUserId: string
  senderDeviceId: string
}

export interface CloudOwnerHandoffOptions {
  deviceId: string
  enrollments(): Promise<unknown>
  roster(): Promise<unknown>
  receive(sender: { userId: string; deviceId: string }): Promise<unknown>
  send(recipient: { userId: string; deviceId: string }, event: { type: string; content: unknown }): Promise<void>
  /** Reads when key is omitted; writes only into the agent-derived secret-storage slot when supplied. */
  recoveryKey(agentUserId: string, key?: string): Promise<string | null>
}

interface Enrollment {
  enrollmentId: string
  executorId: string
  deviceId: string
  agentPrincipal: string
  ownerDevice: string
  handoffUntil: number
}
interface Request {
  enrollmentId: string
  executorId: string
  agentUserId: string
  deviceId?: string
  nonce: string
  expiresAt: number
  purpose: 'restore' | 'escrow'
  slot?: string
  recoveryKey?: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const identifier = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const user = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && USER.test(value)
const device = (value: unknown): value is string => typeof value === 'string' && DEVICE.test(value)

const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every(key => allowed.includes(key))

function slotFor(agentUserId: string): string {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(agentUserId)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

  return `io.atum.agent-recovery.${encoded}`
}

function enrollmentList(value: unknown): Enrollment[] | undefined {
  const root = object(value) ? value : undefined
  const rows = root ? root.enrollments : value

  if (!Array.isArray(rows) || rows.length > 64) {
    return undefined
  }

  const result: Enrollment[] = []

  for (const item of rows) {
    // A list contains every cloud enrollment. Only awaiting-trust rows carry
    // a live handoff, so another agent's active/revoked row cannot poison it.
    if (!object(item) || item.state !== 'awaiting_trust') {
      continue
    }

    if (
      !identifier(item.enrollmentId) ||
      item.kind !== 'cloud' ||
      !identifier(item.executorId) ||
      !identifier(item.agentPrincipal) ||
      !device(item.deviceId) ||
      !device(item.ownerDevice) ||
      !timestamp(item.handoffUntil)
    ) {
      return undefined
    }

    result.push({
      enrollmentId: item.enrollmentId,
      executorId: item.executorId,
      deviceId: item.deviceId,
      agentPrincipal: item.agentPrincipal,
      ownerDevice: item.ownerDevice,
      handoffUntil: item.handoffUntil
    })
  }

  return result
}

function rosterUser(value: unknown, principal: string): string | undefined {
  const root = object(value) ? value : undefined
  const rows = root ? root.agents : value

  if (!Array.isArray(rows) || rows.length > 64) {
    return undefined
  }

  const matches: string[] = []

  for (const item of rows) {
    if (!object(item)) {
      continue
    }

    const listedPrincipal = item.principal ?? item.agentPrincipal
    const listedUser = item.matrixUser ?? item.agentMatrixUser

    if (
      (item.principal !== undefined && item.agentPrincipal !== undefined && item.principal !== item.agentPrincipal) ||
      (item.matrixUser !== undefined && item.agentMatrixUser !== undefined && item.matrixUser !== item.agentMatrixUser)
    ) {
      return undefined
    }

    if (listedPrincipal === principal && user(listedUser)) {
      matches.push(listedUser)
    }
  }

  return matches.length === 1 ? matches[0] : undefined
}

function requestFor(event: CloudHandoffEvent): Request | undefined {
  if (!user(event.senderUserId) || !device(event.senderDeviceId) || !object(event.content)) {
    return undefined
  }

  const c = event.content

  if (event.type === 'io.atum.agent_identity.request') {
    if (
      !keys(c, ['v', 'enrollmentId', 'executorId', 'agentUserId', 'deviceId', 'purpose', 'nonce', 'expiresAt']) ||
      c.v !== 1 ||
      !identifier(c.enrollmentId) ||
      !identifier(c.executorId) ||
      !user(c.agentUserId) ||
      !device(c.deviceId) ||
      (c.purpose !== 'restore' && c.purpose !== 'escrow') ||
      typeof c.nonce !== 'string' ||
      !NONCE.test(c.nonce) ||
      !timestamp(c.expiresAt)
    ) {
      return undefined
    }

    return {
      enrollmentId: c.enrollmentId,
      executorId: c.executorId,
      agentUserId: c.agentUserId,
      deviceId: c.deviceId,
      purpose: c.purpose,
      nonce: c.nonce as string,
      expiresAt: c.expiresAt
    }
  }

  if (event.type === 'io.atum.agent_identity.escrow') {
    if (
      !keys(c, ['v', 'enrollmentId', 'executorId', 'agentUserId', 'expiresAt', 'nonce', 'slot', 'recoveryKey']) ||
      c.v !== 1 ||
      !identifier(c.enrollmentId) ||
      !identifier(c.executorId) ||
      !user(c.agentUserId) ||
      !timestamp(c.expiresAt) ||
      typeof c.nonce !== 'string' ||
      !NONCE.test(c.nonce) ||
      typeof c.slot !== 'string' ||
      !SLOT.test(c.slot) ||
      typeof c.recoveryKey !== 'string' ||
      !RECOVERY_KEY.test(c.recoveryKey)
    ) {
      return undefined
    }

    return {
      enrollmentId: c.enrollmentId,
      executorId: c.executorId,
      agentUserId: c.agentUserId,
      purpose: 'escrow',
      nonce: c.nonce as string,
      expiresAt: c.expiresAt,
      slot: c.slot,
      recoveryKey: c.recoveryKey
    }
  }

  return undefined
}

/**
 * Browser-side proof holder for the cloud identity handoff. It keeps only enrollment IDs
 * returned by this browser's own create/renew calls and never returns or retains recovery keys.
 */
export class CloudOwnerHandoff {
  private readonly createdHere = new Set<string>()
  private stopped = false
  private pumping: Promise<void> | undefined
  constructor(
    private readonly options: CloudOwnerHandoffOptions,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Call only with the ID returned by this browser's successful cloud create or handoff POST. */
  remember(enrollmentId: string): void {
    if (identifier(enrollmentId)) {
      this.createdHere.add(enrollmentId)
    }
  }

  stop(): void {
    this.stopped = true
  }

  pump(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }

    return (this.pumping ??= this.pumpOnce()
      .catch(() => {})
      .finally(() => {
        this.pumping = undefined
      }))
  }

  private async pumpOnce(): Promise<void> {
    const [enrollmentValue, rosterValue] = await Promise.all([this.options.enrollments(), this.options.roster()])

    if (this.stopped) {
      return
    }

    const enrollments = enrollmentList(enrollmentValue)

    if (!enrollments) {
      return
    }

    for (const enrollment of enrollments) {
      if (
        this.stopped ||
        !this.createdHere.has(enrollment.enrollmentId) ||
        enrollment.ownerDevice !== this.options.deviceId ||
        this.now() >= enrollment.handoffUntil
      ) {
        continue
      }

      const agentUserId = rosterUser(rosterValue, enrollment.agentPrincipal)

      if (!agentUserId) {
        continue
      }

      let received: unknown

      try {
        received = await this.options.receive({ userId: agentUserId, deviceId: enrollment.deviceId })
      } catch {
        continue
      }

      if (!Array.isArray(received) || received.length > MAX_EVENTS) {
        continue
      }

      for (const raw of received) {
        if (
          this.stopped ||
          !object(raw) ||
          typeof raw.type !== 'string' ||
          raw.senderUserId !== agentUserId ||
          raw.senderDeviceId !== enrollment.deviceId
        ) {
          continue
        }

        const event = raw as unknown as CloudHandoffEvent
        const request = requestFor(event)

        if (!request) {
          continue
        }

        await this.answer(event, request, enrollments, rosterValue)
      }
    }
  }

  private async answer(
    event: CloudHandoffEvent,
    request: Request,
    enrollments: Enrollment[],
    roster: unknown
  ): Promise<void> {
    const recipient = { userId: event.senderUserId, deviceId: event.senderDeviceId }

    const refuse = async (
      reason: 'unknown_enrollment' | 'wrong_state' | 'device_mismatch' | 'expired' | 'no_key' | 'recovery_unavailable'
    ) => {
      await this.options.send(recipient, {
        type: 'io.atum.agent_identity.refused',
        content: { v: 1, enrollmentId: request.enrollmentId, nonce: request.nonce, reason }
      })
    }

    if (!this.createdHere.has(request.enrollmentId)) {
      return refuse('unknown_enrollment')
    }

    const enrollment = enrollments.find(item => item.enrollmentId === request.enrollmentId)

    if (!enrollment) {
      return refuse('unknown_enrollment')
    }

    const rosterUserId = rosterUser(roster, enrollment.agentPrincipal)

    if (
      !rosterUserId ||
      enrollment.ownerDevice !== this.options.deviceId ||
      enrollment.executorId !== request.executorId ||
      rosterUserId !== request.agentUserId
    ) {
      return refuse('wrong_state')
    }

    if (
      event.senderUserId !== rosterUserId ||
      event.senderDeviceId !== enrollment.deviceId ||
      (request.deviceId !== undefined && request.deviceId !== enrollment.deviceId)
    ) {
      return refuse('device_mismatch')
    }

    // Strict inequalities bind the original encrypted event to the current, still-open window.
    if (
      request.expiresAt > enrollment.handoffUntil ||
      this.now() >= request.expiresAt ||
      this.now() >= enrollment.handoffUntil
    ) {
      return refuse('expired')
    }

    if (request.purpose === 'restore') {
      if (request.deviceId === undefined) {
        return refuse('wrong_state')
      }

      let key: string | null

      try {
        key = await this.options.recoveryKey(rosterUserId)
      } catch {
        if (await this.stillCurrent(event, request, enrollment.agentPrincipal)) {
          return refuse('recovery_unavailable')
        }

        return
      }

      if (!(await this.stillCurrent(event, request, enrollment.agentPrincipal))) {
        return
      }

      if (!key) {
        return refuse('no_key')
      }

      try {
        await this.options.send(recipient, {
          type: 'io.atum.agent_identity.grant',
          content: { v: 1, enrollmentId: request.enrollmentId, nonce: request.nonce, recoveryKey: key }
        })
      } catch {
        /* operation errors intentionally disclose neither a secret nor a transport detail */
      }

      return
    }

    if (!request.slot || !request.recoveryKey || request.slot !== slotFor(rosterUserId)) {
      return refuse('wrong_state')
    }

    try {
      const existing = await this.options.recoveryKey(rosterUserId)

      if (!(await this.stillCurrent(event, request, enrollment.agentPrincipal))) {
        return
      }

      if (existing) {
        return refuse('wrong_state')
      }

      const written = await this.options.recoveryKey(rosterUserId, request.recoveryKey)

      if (!(await this.stillCurrent(event, request, enrollment.agentPrincipal))) {
        return
      }

      if (written !== request.recoveryKey) {
        return refuse('recovery_unavailable')
      }

      await this.options.send(recipient, {
        type: 'io.atum.agent_identity.escrowed',
        content: { v: 1, enrollmentId: request.enrollmentId, nonce: request.nonce, slot: request.slot }
      })
    } catch {
      if (await this.stillCurrent(event, request, enrollment.agentPrincipal)) {
        await refuse('recovery_unavailable')
      }
    }
  }

  /** Re-fetch authority facts after a secret-storage await, before any key leaves this device. */
  private async stillCurrent(
    event: CloudHandoffEvent,
    request: Request,
    expectedAgentPrincipal: string
  ): Promise<boolean> {
    if (this.stopped || !this.createdHere.has(request.enrollmentId)) {
      return false
    }

    try {
      const [enrollmentValue, rosterValue] = await Promise.all([this.options.enrollments(), this.options.roster()])
      const enrollments = enrollmentList(enrollmentValue)
      const enrollment = enrollments?.find(item => item.enrollmentId === request.enrollmentId)
      const rosterUserId = enrollment ? rosterUser(rosterValue, enrollment.agentPrincipal) : undefined

      return Boolean(
        enrollment &&
        enrollment.agentPrincipal === expectedAgentPrincipal &&
        rosterUserId &&
        enrollment.ownerDevice === this.options.deviceId &&
        enrollment.executorId === request.executorId &&
        rosterUserId === request.agentUserId &&
        event.senderUserId === rosterUserId &&
        event.senderDeviceId === enrollment.deviceId &&
        (request.deviceId === undefined || request.deviceId === enrollment.deviceId) &&
        request.expiresAt <= enrollment.handoffUntil &&
        this.now() < request.expiresAt &&
        this.now() < enrollment.handoffUntil &&
        !this.stopped
      )
    } catch {
      return false
    }
  }
}
