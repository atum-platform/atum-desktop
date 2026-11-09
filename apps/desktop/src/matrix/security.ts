import { type MatrixClient, MatrixError, Method } from 'matrix-js-sdk'
import {
  canAcceptVerificationRequest,
  type CryptoCallbacks,
  type GeneratedSecretStorageKey,
  type ShowSasCallbacks,
  type UserVerificationStatus,
  VerificationPhase,
  type VerificationRequest,
  VerificationRequestEvent,
  type Verifier,
  VerifierEvent
} from 'matrix-js-sdk/lib/crypto-api'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key'
import type { SecretStorageKeyDescriptionAesV1 } from 'matrix-js-sdk/lib/secret-storage'

import type {
  MatrixAgentTrustStatus,
  MatrixNativeSecurityCommand,
  MatrixOwnDevice,
  MatrixOwnDevices,
  MatrixOwnerRestore,
  MatrixOwnerStatus,
  MatrixRecoveryCheck,
  MatrixSecurity,
  MatrixSecurityCommand,
  MatrixVerification
} from '../../shared/matrix-security'

import { matrixContinueChangedPeer, matrixPeerIdentityReview } from './peer-identity'
import { loadIdentityForVerification } from './sdk-device-verification'
import { agentRecoverySlot, currentSecretStorage } from './secret-storage'

/** A new device waiting to be approved by the person's other devices (device-approval.ts). */
const APPROVAL_MARKER = 'io.atum.device_approval'

/** A peer with no published cross-signing identity stays unknown through every trust poll
 * (electron/matrix/agent-trust.ts asks every 500 ms for 5 s). One explicit import per this
 * window bounds that; an identity that becomes known is re-read first and clears the entry. */
const IDENTITY_IMPORT_RETRY_MS = 10 * 60_000

/** Per peer: the import concurrent callers share, and the retry window after one found nothing. */
interface IdentityImport {
  inFlight?: Promise<UserVerificationStatus>
  retryAfter?: number
}

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.device_approval': Record<string, unknown>
  }
}

/** Only operation-scoped key custody. Matrix owns the format, encryption and store. */
export function recoveryKeyCache() {
  let current: { id: string; key: Uint8Array<ArrayBuffer> } | undefined

  const clear = () => {
    current?.key.fill(0)
    current = undefined
  }

  const set = (id: string, key: Uint8Array<ArrayBuffer>) => {
    clear()
    current = { id, key: new Uint8Array(key) }
  }

  const callbacks: CryptoCallbacks = {
    getSecretStorageKey: async ({ keys }) =>
      current && keys[current.id] ? [current.id, new Uint8Array(current.key)] : null,
    cacheSecretStorageKey: (id, _info, key) => set(id, key)
  }

  return { callbacks, set, clear }
}

/** The protocol's closed cancel code and, between two people, which side ended it. */
export function verificationCancellation(
  request: Pick<VerificationRequest, 'cancellationCode' | 'cancellingUserId' | 'otherUserId'>,
  me: string | null
): Pick<MatrixVerification, 'cancelCode' | 'cancelledBy'> {
  const code = request.cancellationCode
  const by = request.cancellingUserId

  return {
    ...(typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code) ? { cancelCode: code } : {}),
    ...(by && me && request.otherUserId !== me ? { cancelledBy: by === me ? ('self' as const) : ('peer' as const) } : {})
  }
}

/** A presentation adapter around SDK-owned verification requests and key backup. */
export function matrixSecurity(client: MatrixClient, cache: ReturnType<typeof recoveryKeyCache>, changed: () => void) {
  const crypto = client.getCrypto()!
  let freshStorage: ReturnType<typeof currentSecretStorage> | undefined
  const storageNow = () => (freshStorage ??= currentSecretStorage(client, cache))
  const state: MatrixSecurity = { recovery: 'idle' }
  let live = true

  let active:
    | {
        id: string
        request: VerificationRequest
        detach: () => void
        sas?: ShowSasCallbacks
        /** The other device, once the SDK named it: the Rust SDK forgets it when the request is
         * done or cancelled (`otherDeviceId` is then undefined), and both the finished approval
         * and `approveOwnDevice` need it then. */
        deviceId?: string
        /** An enrollment-bound owner-reader SAS: compared only through the native owner domain. */
        native?: boolean
        /** Main's quiet agent-trust request, never a person-started peer verification. */
        quietAgent?: boolean
        accepting?: boolean
      }
    | undefined

  let readerPeer: { deviceId: string; expiresAt: number; timer: ReturnType<typeof setTimeout> } | undefined
  let staged: { id: string; key: GeneratedSecretStorageKey; timer: ReturnType<typeof setTimeout> } | undefined
  let working = false
  let recoveryWork: Promise<void> | undefined
  let preparing = false
  let preparation = 0
  let requesting = false

  /** Scoped to this client, never shared across accounts (a sign-out replaces the instance). */
  const identityImports = new Map<string, IdentityImport>()

  /** Join the import already running for `userId`, skip a peer whose last import found no
   * identity until its window passes, or start one. Resolves with the identity read after the
   * import, or undefined when skipped. A failed import is not remembered: its error propagates
   * exactly as before and the next call retries. */
  function importIdentity(userId: string): Promise<UserVerificationStatus> | undefined {
    const existing = identityImports.get(userId)

    if (existing?.inFlight) {
      return existing.inFlight
    }

    if (existing?.retryAfter !== undefined && Date.now() < existing.retryAfter) {
      return undefined
    }

    const entry: IdentityImport = {}

    const running = (async (): Promise<UserVerificationStatus> => {
      await loadIdentityForVerification(crypto, userId)
      const imported = await crypto.getUserVerificationStatus(userId)

      if (imported.known === true) {
        identityImports.delete(userId)
      } else {
        entry.retryAfter = Date.now() + IDENTITY_IMPORT_RETRY_MS
      }

      entry.inFlight = undefined

      return imported
    })()

    const shared = running.catch(error => {
      if (identityImports.get(userId) === entry) {
        identityImports.delete(userId)
      }

      throw error
    })

    entry.inFlight = shared
    identityImports.set(userId, entry)

    return shared
  }

  const notify = () => {
    if (live) {
      changed()
    }
  }

  const requireLive = () => {
    if (!live) {
      throw new Error('matrix_security_stopped')
    }
  }

  function discard() {
    preparation++

    if (staged) {
      clearTimeout(staged.timer)
      staged.key.privateKey.fill(0)
      staged = undefined
    }
  }

  function watch(request: VerificationRequest, quietAgent = false) {
    if (!live) {
      void request.cancel().catch(() => {})

      return
    }

    // A replayed terminal request can neither help the phone nor own the active slot.
    if (!request.pending) {
      void request.cancel().catch(() => {})

      return
    }

    if (active?.request.pending && active.request !== request) {
      const ownerDeviceRequest =
        !request.initiatedByMe && request.isSelfVerification && request.otherUserId === client.getUserId()

      const quietAgentRequest =
        active.quietAgent === true && active.request.initiatedByMe && !active.request.isSelfVerification

      // The SDK permits only one verification at a time. A quiet background check of an agent
      // must never make the owner's phone look hung: stop that outgoing cross-user check and put
      // the live incoming self-verification in front of the person. Explicit peer and owner-device
      // checks keep the normal one-at-a-time refusal. The agent gate retries its trust check before
      // work, while the phone's short-lived request cannot be recovered later.
      if (ownerDeviceRequest && quietAgentRequest) {
        const previous = active
        previous.detach()
        active = undefined
        void previous.request.cancel().catch(() => {})
      } else {
        void request.cancel().catch(() => {})

        return
      }
    }

    if (active?.request === request) {
      active.quietAgent ||= quietAgent

      return
    }

    active?.detach()
    const id = globalThis.crypto.randomUUID()
    let verifier: Verifier | undefined

    const show = (sas: ShowSasCallbacks) => {
      if (!live || active?.id !== id) {
        return
      }

      active.sas = sas
      update()
    }

    const update = () => {
      if (!live || active?.id !== id) {
        return
      }

      const phase = request.phase

      if (request.verifier && request.verifier !== verifier) {
        verifier?.off(VerifierEvent.ShowSas, show)
        verifier = request.verifier
        verifier.on(VerifierEvent.ShowSas, show)
        active.sas = verifier.getShowSasCallbacks() ?? undefined
        // Do not await a minutes-long human interaction on a command/IPC call.
        void verifier
          .verify()
          .catch(() => {})
          .finally(update)
      }

      const terminal = phase === VerificationPhase.Done || phase === VerificationPhase.Cancelled

      if (terminal) {
        active.sas = undefined
      }

      if (active.native) {
        // Enrollment-bound SAS is compared only through the native owner domain.
        // Neither the request nor its tuple is a renderer presentation value.
        if (state.verification?.id === id) {delete state.verification}

        if (!terminal && !readerCurrent(active)) {
          void request.cancel().catch(() => {})
        } else if (!terminal && canAcceptVerificationRequest(request) && !active.accepting) {
          const current = active
          current.accepting = true
          void request.accept().catch(() => request.cancel().catch(() => {})).finally(() => {
            current.accepting = false
          })
        }

        return
      }

      const cancelled = phase === VerificationPhase.Cancelled ? verificationCancellation(request, client.getUserId()) : {}

      if (request.otherDeviceId) {
        active.deviceId = request.otherDeviceId
      }

      state.verification = {
        id,
        userId: request.otherUserId,
        deviceId: request.otherDeviceId ?? active.deviceId ?? '',
        ...(request.transactionId ? { flowId: request.transactionId } : {}),
        incoming: !request.initiatedByMe,
        state:
          phase === VerificationPhase.Done
            ? 'done'
            : phase === VerificationPhase.Cancelled
              ? 'cancelled'
              : active.sas
                ? 'compare'
                : phase === VerificationPhase.Started
                  ? 'started'
                  : phase === VerificationPhase.Ready
                    ? 'ready'
                    : 'requested',
        ...(active.sas ? { decimals: active.sas.sas.decimal, emoji: active.sas.sas.emoji } : {}),
        ...cancelled
      }
      notify()
    }

    active = {
      id,
      request,
      quietAgent,
      native: !!readerPeer && readerPeer.expiresAt > Date.now() && request.isSelfVerification &&
        request.otherUserId === client.getUserId() && request.otherDeviceId === readerPeer.deviceId,
      detach: () => {
        request.off(VerificationRequestEvent.Change, update)
        verifier?.off(VerifierEvent.ShowSas, show)
      }
    }
    request.on(VerificationRequestEvent.Change, update)
    update()
  }

  const received = (request: VerificationRequest) => watch(request)
  client.on(CryptoEvent.VerificationRequestReceived, received)

  function readerCurrent(value: NonNullable<typeof active>) {
    return live && active === value && value.native && !!readerPeer && readerPeer.expiresAt > Date.now() &&
      value.request.isSelfVerification && value.request.otherUserId === client.getUserId() &&
      value.request.otherDeviceId === readerPeer.deviceId
  }

  function clearReaderPeer() {
    clearTimeout(readerPeer?.timer)
    readerPeer = undefined

    if (active?.native && active.request.pending) {void active.request.cancel().catch(() => {})}
  }

  // The person's identity that this device verified was replaced (reset from another device or
  // sign-in): main checks its kept key again (electron/matrix/main.ts `ownerUnlock`), so the
  // reset shows without a relaunch. This device verifying the identity itself never counts.
  const identityChanged = (
    userId: string,
    trust: { isCrossSigningVerified(): boolean; wasCrossSigningVerified(): boolean }
  ) => {
    if (userId === client.getUserId() && trust?.wasCrossSigningVerified() && !trust.isCrossSigningVerified()) {
      state.identityChanges = (state.identityChanges ?? 0) + 1
      notify()
    }
  }

  client.on(CryptoEvent.UserTrustStatusChanged, identityChanged)

  // The person's own device list changed (a new sign-in such as a phone, a sign-out, a device
  // signed): main reads `ownDevices` again for the window's reminder about unverified ones. A
  // count only; nothing is read here.
  const devicesChanged = (users: string[]) => {
    const me = client.getUserId()

    if (me && users.includes(me)) {
      state.ownDevicesChanges = (state.ownDevicesChanges ?? 0) + 1
      notify()
    }
  }

  client.on(CryptoEvent.DevicesUpdated, devicesChanged)

  async function requireNoBackup() {
    // The crypto status helpers swallow network errors as null. Only an explicit
    // protocol-level absence permits setup: bootstrap may delete old backups.
    try {
      await client.http.authedRequest(Method.Get, '/room_keys/version', undefined, undefined, {
        prefix: '/_matrix/client/v3'
      })
    } catch (error) {
      if (error instanceof MatrixError && error.httpStatus === 404 && error.errcode === 'M_NOT_FOUND') {
        return
      }

      throw error
    }

    throw new Error('matrix_recovery_exists')
  }

  async function safeToCreate(fresh = false) {
    // Never ask bootstrap to invent a replacement for an existing unknown identity.
    await crypto.getUserDeviceInfo([client.getUserId()!], true)
    const signing = await crypto.getCrossSigningStatus()

    if (
      (await (fresh ? storageNow() : client.secretStorage).getDefaultKeyId()) ||
      (signing.publicKeysOnDevice && !Object.values(signing.privateKeysCachedLocally).every(Boolean))
    ) {
      throw new Error('matrix_recovery_exists')
    }

    await requireNoBackup()
    requireLive()
  }

  function run(work: () => Promise<number | undefined>) {
    if (working || preparing) {
      throw new Error('matrix_recovery_pending')
    }

    working = true
    state.recovery = 'working'
    delete state.restored
    notify()

    const pending = work()
      .then(
        restored => {
          if (live) {
            state.recovery = 'ready'
            state.restored = restored
          }
        },
        () => {
          if (live) {
            state.recovery = 'failed'
          }
        }
      )
      .finally(() => {
        cache.clear()
        working = false
        notify()
      })

    recoveryWork = pending

    return pending
  }

  /** Checks the key against the account's current recovery and caches it for this
   * operation; returns the key id it unlocks. */
  async function unlock(key: Uint8Array<ArrayBuffer>, fresh = false): Promise<string> {
    const storage = fresh ? storageNow() : client.secretStorage
    const info = await storage.getKey()
    requireLive()

    const description = info?.[1] as Partial<SecretStorageKeyDescriptionAesV1> | undefined

    // A key description without its check (`iv` and `mac`) "opens" with any key (the SDK's
    // checkKey assumes the key is right): a kept key gone stale would never show as stale, and
    // whoever controls the account could write one. Atum's own recovery always carries both.
    if (
      !info ||
      description?.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2' ||
      typeof description.iv !== 'string' ||
      !description.iv ||
      typeof description.mac !== 'string' ||
      !description.mac ||
      !(await storage.checkKey(key, description as SecretStorageKeyDescriptionAesV1))
    ) {
      throw new Error('matrix_recovery_key_invalid')
    }

    requireLive()
    cache.set(info[0], key)

    return info[0]
  }

  /** This device is signed by the person's identity, as this device sees it. */
  async function ownDeviceSigned(): Promise<boolean> {
    const status = await crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!)

    return Boolean(status?.crossSigningVerified)
  }

  /** The key backup is in use here with its decryption key cached (the key never leaves). */
  async function backupReady(): Promise<boolean> {
    if (!(await crypto.getActiveSessionBackupVersion())) {
      return false
    }

    const key = await crypto.getSessionBackupPrivateKey()
    key?.fill(0)

    return Boolean(key)
  }

  async function restoreSigning() {
    // bootstrapCrossSigning creates an identity if secrets are absent. Require
    // all three in the same SDK store it consumes before calling it.
    for (const name of ['m.cross_signing.master', 'm.cross_signing.self_signing', 'm.cross_signing.user_signing']) {
      if (!(await client.secretStorage.get(name))) {
        throw new Error('matrix_recovery_incomplete')
      }
    }

    await crypto.getUserDeviceInfo([client.getUserId()!], true)
    requireLive()
    await crypto.bootstrapCrossSigning({})
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    requireLive()

    if (working || preparing) {
      throw new Error('matrix_recovery_pending')
    }

    preparing = true

    try {
      return await work()
    } finally {
      cache.clear()
      preparing = false
    }
  }

  async function nativeCommand(command: Exclude<MatrixNativeSecurityCommand,
    {kind:'agentRecoveryGenerate'|'agentIdentityToDeviceSend'|'agentIdentityToDeviceRead'|'ownerRecoveryToDeviceSend'|'ownerRecoveryToDeviceRead'|'ownerRecoveryChannelOpen'|'ownerRecoveryDrops'}>): Promise<unknown> {
    requireLive()

    if (command.kind === 'agentVerificationStart') {
      if (requesting || active?.request.pending) {
        throw new Error('matrix_verification_pending')
      }

      if (command.userId === client.getUserId() && command.deviceId === client.getDeviceId()) {
        throw new Error('matrix_verification_self')
      }

      requesting = true

      try {
        watch(await crypto.requestDeviceVerification(command.userId, command.deviceId), true)
      } finally {
        requesting = false
      }

      return null
    }

    if (command.kind === 'peerIdentityRead') {
      return matrixPeerIdentityReview(client, command.roomId, command.userId, () => live)
    }

    if (command.kind === 'peerIdentityContinue') {
      if (requesting || active?.request.pending) {throw new Error('matrix_verification_pending')}

      return exclusive(() => matrixContinueChangedPeer(client, command.roomId, command.userId, () => live && !requesting && !active?.request.pending))
    }

    if (command.kind === 'peerIdentityStart') {
      if (requesting || active?.request.pending || preparing || working) {throw new Error('matrix_verification_pending')}
      requesting = true

      try {
        if (!(await matrixPeerIdentityReview(client, command.roomId, command.userId, () => live))) {
          throw new Error('matrix_identity_review_stale')
        }

        requireLive()
        const room = client.getRoom(command.roomId)
        const request = await crypto.requestVerificationDM(command.userId, command.roomId)

        if (!live || client.getRoom(command.roomId) !== room || room?.getMyMembership() !== 'join' ||
            room.getMember(command.userId)?.membership !== 'join' || !room.hasEncryptionStateEvent()) {
          await request.cancel().catch(() => {})
          throw new Error('matrix_identity_review_stale')
        }

        watch(request)

        return null
      } finally { requesting = false }
    }

    if (command.kind === 'securityStatus') {
      return structuredClone(state)
    }

    // One-tap approval (device-approval.ts): this device asks the person's other devices.
    if (command.kind === 'approvalRequest') {
      if (requesting || active?.request.pending) {
        throw new Error('matrix_verification_pending')
      }

      requesting = true

      try {
        watch(await crypto.requestOwnUserVerification())

        // Main needs the request identity even if its first published snapshot
        // already contains a fast refusal. No key material crosses this reply.
        return state.verification ? structuredClone(state.verification) : null
      } finally {
        requesting = false
      }
    }

    // `signedByOwner` is worked out against the identity the server serves now, which may not be
    // one this device ever verified (replaced from another sign-in): `identity` says which, and a
    // device that trusts the person's identity needs `crossSigningVerified` (device-approval.ts).
    if (command.kind === 'ownDevices') {
      const me = client.getUserId()!
      const info = await crypto.getUserDeviceInfo([me], true)
      const listed = new Map(((await client.getDevices().catch(() => null))?.devices ?? []).map(device => [device.device_id, device]))
      const trust = await crypto.getUserVerificationStatus(me)
      const devices: MatrixOwnDevice[] = []

      for (const device of info.get(me)?.values() ?? []) {
        if (device.deviceId === client.getDeviceId()) {
          continue
        }

        const status = await crypto.getDeviceVerificationStatus(me, device.deviceId)
        const row = listed.get(device.deviceId)
        const name = (row?.display_name ?? device.displayName)?.trim().slice(0, 120)
        const seen = row?.last_seen_ts

        devices.push({
          deviceId: device.deviceId,
          ...(name ? { name } : {}),
          ...(typeof seen === 'number' && Number.isFinite(seen) ? { lastSeenAt: seen } : {}),
          signedByOwner: Boolean(status?.signedByOwner),
          crossSigningVerified: Boolean(status?.crossSigningVerified),
          ...(status?.localVerified ? { locallyVerified: true as const } : {})
        })
      }

      requireLive()

      return {
        devices,
        identity: trust.isCrossSigningVerified() ? 'verified' : trust.wasCrossSigningVerified() ? 'changed' : 'new'
      } satisfies MatrixOwnDevices
    }

    // No secret: which device waits, and until when, for a device that wakes later.
    if (command.kind === 'approvalMarker') {
      const marker = command.marker

      if (
        marker !== null &&
        (marker?.deviceId !== client.getDeviceId() ||
          !Number.isSafeInteger(marker.requestedAt) ||
          !Number.isSafeInteger(marker.expiresAt) ||
          marker.expiresAt <= marker.requestedAt)
      ) {
        throw new Error('matrix_approval_invalid')
      }

      await client.setAccountData(APPROVAL_MARKER, marker ?? {})

      return null
    }

    if (command.kind === 'nameOwnDevice') {
      const name = command.name

      if (typeof name !== 'string' || !name.trim() || name.length > 100 || /\p{Cc}/u.test(name)) {
        throw new Error('matrix_device_name_invalid')
      }

      const current = (await client.getDevice(client.getDeviceId()!).catch(() => null))?.display_name?.trim()
      requireLive()

      if (current) {
        return { named: false }
      }

      await client.setDeviceDetails(client.getDeviceId()!, { display_name: name })

      return { named: true }
    }

    // Only the device this one just finished comparing with, of the same person.
    if (command.kind === 'approveOwnDevice') {
      const request = active?.request
      const me = client.getUserId()

      if (
        !request ||
        request.phase !== VerificationPhase.Done ||
        request.otherUserId !== me ||
        (request.otherDeviceId ?? active?.deviceId) !== command.deviceId ||
        command.deviceId === client.getDeviceId()
      ) {
        throw new Error('matrix_verification_stale')
      }

      const status = await crypto.getDeviceVerificationStatus(me!, command.deviceId)

      if (!status?.crossSigningVerified) {
        await crypto.crossSignDevice(command.deviceId)
      }

      return null
    }

    // Read-only facts for main's unlock and agent-trust decisions: flags and public keys only.
    if (command.kind === 'ownerStatus') {
      const me = client.getUserId()!
      await crypto.getUserDeviceInfo([me], true)
      const known = storage()
      const keyId = known === 'present' ? await client.secretStorage.getDefaultKeyId() : null
      const signing = await crypto.isCrossSigningReady()
      const deviceSigned = await ownDeviceSigned()
      const backup = await backupReady()
      const ownKey = (await crypto.getOwnDeviceKeys()).ed25519
      requireLive()

      return {
        ...(known ? { storage: known } : {}),
        ...(typeof keyId === 'string' && keyId ? { keyId } : {}),
        signing,
        deviceSigned,
        backup,
        ...(typeof ownKey === 'string' && ownKey ? { ownKey } : {})
      } satisfies MatrixOwnerStatus
    }

    if (command.kind === 'agentTrustStatus') {
      const { userId, deviceId } = command.peer

      if (typeof userId !== 'string' || !/^@[^:]+:.+$/.test(userId) || typeof deviceId !== 'string' || !deviceId) {
        throw new Error('matrix_agent_identity_invalid')
      }

      let identity = await crypto.getUserVerificationStatus(userId)

      if (identity.known !== true) {
        identity = (await importIdentity(userId)) ?? identity
      } else {
        // The identity arrived (by import, sync or another device); a stale negative window must
        // never suppress the next import if it is reset again while unknown.
        identityImports.delete(userId)
      }

      const devices = await crypto.getUserDeviceInfo([userId], false)
      const peer = devices.get(userId)?.get(deviceId)
      const peerDevice = await crypto.getDeviceVerificationStatus(userId, deviceId)
      const ownKey = (await crypto.getOwnDeviceKeys()).ed25519
      const ownDeviceCrossSigned = await ownDeviceSigned()
      requireLive()
      const peerKey = peer?.getFingerprint()

      return {
        ownKey,
        ...(peerKey ? { peerKey } : {}),
        peerIdentityKnown: identity.known === true,
        peerIdentityVerified: identity.isCrossSigningVerified(),
        peerDeviceCrossSigned: Boolean(peerDevice?.crossSigningVerified),
        ownDeviceCrossSigned
      } satisfies MatrixAgentTrustStatus
    }

    if (command.kind === 'recoveryCheck') {
      return exclusive(async (): Promise<MatrixRecoveryCheck> => {
        let raw: Uint8Array<ArrayBuffer>

        try {
          raw = decodeRecoveryKey(command.key)
        } catch {
          return { valid: false }
        }

        try {
          return { valid: true, keyId: await unlock(raw, true) }
        } catch (error) {
          if (error instanceof Error && error.message === 'matrix_recovery_key_invalid') {
            return { valid: false }
          }

          throw error
        } finally {
          raw.fill(0)
        }
      })
    }

    // The silent unlock with a key main keeps (owner-unlock.ts): the same SDK steps as the
    // person's own restore, without the visible recovery state, and the backup download in the
    // background so the native queue is never held by it. Nothing is ever created or replaced.
    if (command.kind === 'ownerRestore') {
      return exclusive(async (): Promise<MatrixOwnerRestore> => {
        let raw: Uint8Array<ArrayBuffer>

        try {
          raw = decodeRecoveryKey(command.key)
        } catch {
          throw new Error('matrix_recovery_key_invalid')
        }

        try {
          const keyId = await unlock(raw, true)
          const me = client.getUserId()!
          await crypto.getUserDeviceInfo([me], true)
          const cached = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally

          if (!cached.masterKey || !cached.selfSigningKey || !cached.userSigningKey) {
            // The account's signing keys come from its recovery, and this device is signed
            // with them (the SDK's own import; never a new identity: restoreSigning).
            await restoreSigning()
          } else if (!(await ownDeviceSigned())) {
            // The keys are already here: sign this device with them, nothing else.
            await crypto.crossSignDevice(client.getDeviceId()!)
          }

          requireLive()
          let backup = false

          try {
            await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
            await crypto.checkKeyBackupAndEnable()
            backup = await backupReady()
          } catch {
            // An account without a backup, or one whose key is not in recovery: signing still
            // counts. Main logs `backup=false`.
            backup = false
          }

          requireLive()
          const signed = await ownDeviceSigned()

          if (backup) {
            // Every old message key, in the background: the chats redraw as each one decrypts.
            void crypto.restoreKeyBackup().catch(() => {})
          }

          return { keyId, signed, backup }
        } finally {
          raw.fill(0)
        }
      })
    }

    if (command.kind === 'ownerReaderVerificationPrepare') {
      if (!/^ATUM_COMPANION_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(command.deviceId) ||
        !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= Date.now() || command.expiresAt > Date.now()+600000 ||
        !(await crypto.isCrossSigningReady())) {throw Error('matrix_owner_reader_invalid')}

      requireLive()

      if (active?.request.pending && (!active.request.isSelfVerification || active.request.otherUserId !== client.getUserId() ||
        active.request.otherDeviceId !== command.deviceId)) {throw Error('matrix_verification_pending')}

      if (readerPeer && readerPeer.deviceId !== command.deviceId) {clearReaderPeer()}
      clearTimeout(readerPeer?.timer)
      readerPeer = {deviceId:command.deviceId,expiresAt:command.expiresAt,
        timer:setTimeout(clearReaderPeer,Math.max(1,command.expiresAt-Date.now()))}

      if (active?.request.pending) {
        active.native = true
        delete state.verification

        if (canAcceptVerificationRequest(active.request)) {await active.request.accept()}
      }

      return null
    }

    if (command.kind === 'ownerReaderVerificationRead' || command.kind === 'ownerReaderVerificationRespond') {
      const current = active

      if (!current || !readerCurrent(current) || command.deviceId !== readerPeer?.deviceId || !current.request.pending) {return null}
      const flowId=current.request.transactionId, decimal=current.sas?.sas.decimal

      if (current.request.phase !== VerificationPhase.Started || current.request.chosenMethod !== 'm.sas.v1' ||
        !flowId || !/^[!-~]{1,255}$/.test(flowId) || !Array.isArray(decimal) || decimal.length !== 3 ||
        !decimal.every(n=>Number.isSafeInteger(n) && n>=1000 && n<=9191)) {return null}

      if (command.kind === 'ownerReaderVerificationRead') {return {flowId,decimal:[...decimal]}}

      if (command.flowId !== flowId || !Array.isArray(command.decimal) || command.decimal.length !== 3 ||
        !command.decimal.every((n,i)=>n === decimal[i])) {throw Error('matrix_owner_reader_stale')}

      requireLive()

      if (command.action === 'confirm') {await current.sas!.confirm()}
      else if (command.action === 'mismatch') {current.sas!.mismatch()}
      else {throw Error('matrix_owner_reader_invalid')}

      requireLive()

      return null
    }

    if (command.kind === 'ownerReaderCrossSignDevice') {
      // The caller binds this device to a live server enrollment. This SDK boundary
      // still accepts only the canonical companion device label and never starts a SAS flow or
      // receives a recovery key from main/renderer.
      if (typeof command.deviceId !== 'string' || !/^ATUM_COMPANION_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(command.deviceId)) {
        throw new Error('matrix_owner_reader_invalid')
      }

      if (!(await crypto.isCrossSigningReady())) {
        throw new Error('matrix_owner_reader_cross_signing_unavailable')
      }

      requireLive()
      const ownerUserId = client.getUserId()

      if (!ownerUserId) {throw new Error('matrix_owner_reader_device_unavailable')}
      // The SDK's normal device-info read can stay stale for the tracked self
      // user. Force a server key query, then ensure the enrollment-bound reader
      // is the exact device that will be signed.
      await crypto.userHasCrossSigningKeys(ownerUserId, true)
      requireLive()
      const devices = await crypto.getUserDeviceInfo([ownerUserId], false)

      if (!devices.get(ownerUserId)?.has(command.deviceId)) {
        throw new Error('matrix_owner_reader_device_unavailable')
      }

      requireLive()
      await crypto.crossSignDevice(command.deviceId)
      requireLive()

      return null
    }

    if (command.kind === 'ownerRecovery') {
      const key =
        command.command.kind === 'recoveryRestore'
          ? command.command.key
          : staged?.id === command.command.id
            ? staged.key.encodedPrivateKey
            : undefined

      if (!key) {
        throw new Error('matrix_recovery_stale')
      }

      // Public recovery remains asynchronous; the native wrapper waits for the
      // exact operation before saving the key in the OS-backed account vault.
      await api.command(command.command)
      await recoveryWork
      requireLive()

      if (state.recovery !== 'ready') {
        throw new Error('matrix_recovery_incomplete')
      }

      // Revalidate against the current server key before native persistence;
      // an overlapping recovery or changed account cannot save a stale key.
      await exclusive(async () => {
        const raw = decodeRecoveryKey(key)

        try {
          await unlock(raw, true)
        } finally {
          raw.fill(0)
        }
      })

      return key
    }

    return exclusive(async () => {
      if (command.kind === 'agentIdentityStatus') {
        await crypto.getUserDeviceInfo([client.getUserId()!], true)
        const recovery = Boolean(await storageNow().getDefaultKeyId())
        const verified = await crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!)
        requireLive()

        return {
          recovery,
          ready: recovery && (await crypto.isCrossSigningReady()) && Boolean(verified?.crossSigningVerified)
        }
      }

      const encoded = command.kind === 'agentRecoveryKey' ? command.ownerKey : command.key
      const key = decodeRecoveryKey(encoded)

      try {
        if (command.kind === 'agentRecoveryKey') {
          const authoritativeStorage = storageNow()
          const slot = agentRecoverySlot(command.userId)

          if (command.userId === client.getUserId()) {
            throw new Error('matrix_agent_identity_invalid')
          }

          await unlock(key, true)

          if (!(await crypto.isCrossSigningReady())) {
            await restoreSigning()
          }

          const raw = await authoritativeStorage.get(slot)
          requireLive()
          let stored: { version?: unknown; userId?: unknown; recoveryKey?: unknown } | undefined

          if (raw !== undefined) {
            if (raw.length > 2048) {
              throw new Error('matrix_agent_recovery_invalid')
            }

            stored = JSON.parse(raw)

            if (stored?.version !== 1 || stored.userId !== command.userId || typeof stored.recoveryKey !== 'string') {
              throw new Error('matrix_agent_recovery_invalid')
            }

            decodeRecoveryKey(stored.recoveryKey).fill(0)
          }

          if (command.key !== undefined) {
            decodeRecoveryKey(command.key).fill(0)

            if (stored && stored.recoveryKey !== command.key) {
              throw new Error('matrix_agent_recovery_conflict')
            }

            if (!stored) {
              requireLive()
              await authoritativeStorage.store(
                slot,
                JSON.stringify({ version: 1, userId: command.userId, recoveryKey: command.key })
              )
              const persisted = await authoritativeStorage.get(slot)
              requireLive()

              if (!persisted || JSON.parse(persisted).recoveryKey !== command.key) {
                throw new Error('matrix_agent_recovery_incomplete')
              }
            }

            return command.key
          }

          return stored?.recoveryKey ?? null
        }

        if (command.kind === 'agentIdentityCreate') {
          discard()
          await safeToCreate(true)
          await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: request => request({}) })
          await requireNoBackup()
          requireLive()
          await crypto.bootstrapSecretStorage({
            createSecretStorageKey: async () => ({ privateKey: key, encodedPrivateKey: encoded }),
            setupNewKeyBackup: true
          })
        } else {
          await unlock(key)
          await restoreSigning()
          await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
          await crypto.checkKeyBackupAndEnable()
        }

        requireLive()

        if (!(await crypto.isSecretStorageReady()) || !(await crypto.getActiveSessionBackupVersion())) {
          throw new Error('matrix_recovery_incomplete')
        }

        if (command.kind === 'agentIdentityRestore' && (await backupReady())) {
          // The owner-authorized restore also imports history for a replacement executor,
          // just as the human restore does. Do not keep the recovery operation open for it.
          void crypto.restoreKeyBackup().catch(() => {})
        }

        return null
      } finally {
        key.fill(0)
      }
    })
  }

  /** A new device of the person's waiting to be approved (no secret in it). */
  function approvalMarker(): MatrixSecurity['approvalMarker'] {
    const content = client.getAccountData(APPROVAL_MARKER)?.getContent() as
      | { deviceId?: unknown; requestedAt?: unknown; expiresAt?: unknown }
      | undefined

    return typeof content?.deviceId === 'string' &&
      /^[!-~]{1,255}$/.test(content.deviceId) &&
      typeof content.requestedAt === 'number' &&
      Number.isSafeInteger(content.requestedAt) &&
      typeof content.expiresAt === 'number' &&
      Number.isSafeInteger(content.expiresAt)
      ? { deviceId: content.deviceId, requestedAt: content.requestedAt, expiresAt: content.expiresAt }
      : undefined
  }

  /** Synced account data, so a new Mac knows to ask for the key rather than to make one. */
  function storage(): MatrixSecurity['storage'] {
    if (!client.isInitialSyncComplete()) {
      return undefined
    }

    const key = client.getAccountData('m.secret_storage.default_key')?.getContent()?.key

    return typeof key === 'string' && key ? 'present' : 'absent'
  }

  const api = {
    snapshot: (): MatrixSecurity => {
      const known = storage()
      const marker = approvalMarker()

      return {
        ...structuredClone(state),
        ...(known ? { storage: known } : {}),
        ...(marker ? { approvalMarker: marker } : {})
      }
    },
    nativeCommand,
    async command(command: MatrixSecurityCommand): Promise<unknown> {
      requireLive()

      switch (command.kind) {
        case 'verificationStart': {
          if (requesting || active?.request.pending) {
            throw new Error('matrix_verification_pending')
          }

          if (command.userId === client.getUserId() && command.deviceId === client.getDeviceId()) {
            throw new Error('matrix_verification_self')
          }

          requesting = true

          try {
            watch(await crypto.requestDeviceVerification(command.userId, command.deviceId))
          } finally {
            requesting = false
          }

          return null
        }

        case 'verificationRespond': {
          const current = active

          if (!current || current.native || current.id !== command.id || !current.request.pending) {
            throw new Error('matrix_verification_stale')
          }

          const request = current.request

          switch (command.action) {
            case 'accept':
              if (request.initiatedByMe || request.phase !== VerificationPhase.Requested) {
                throw new Error('matrix_verification_phase')
              }

              await request.accept()

              break

            case 'start':
              if (request.phase !== VerificationPhase.Ready) {
                throw new Error('matrix_verification_phase')
              }

              await request.startVerification('m.sas.v1')

              break

            case 'confirm':
              if (!current.sas) {
                throw new Error('matrix_verification_phase')
              }

              await current.sas.confirm()

              break

            case 'mismatch':
              if (!current.sas) {
                throw new Error('matrix_verification_phase')
              }

              current.sas.mismatch()

              break

            case 'cancel':
              await request.cancel()

              break
          }

          return null
        }

        case 'recoveryCreateKey': {
          if (working || preparing) {
            throw new Error('matrix_recovery_pending')
          }

          discard()
          const generation = preparation
          preparing = true
          let key: GeneratedSecretStorageKey | undefined

          try {
            await safeToCreate()
            key = await crypto.createRecoveryKeyFromPassphrase()
            requireLive()

            if (generation !== preparation) {
              throw new Error('matrix_recovery_stale')
            }

            const id = globalThis.crypto.randomUUID()
            staged = { id, key, timer: setTimeout(discard, 120_000) }

            return { id, key: key.encodedPrivateKey }
          } finally {
            preparing = false

            if (key && key !== staged?.key) {
              key.privateKey.fill(0)
            }
          }
        }

        case 'recoveryDiscard':
          discard()

          return null
        case 'recoverySetUp': {
          if (!staged || command.id !== staged.id || working) {
            throw new Error('matrix_recovery_stale')
          }

          const key = staged.key
          clearTimeout(staged.timer)
          staged = undefined
          run(async () => {
            try {
              await safeToCreate()
              await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: request => request({}) })
              // Re-read after the network-bound signing step, before backup creation.
              await requireNoBackup()
              requireLive()
              await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => key, setupNewKeyBackup: true })

              if (!(await crypto.isSecretStorageReady()) || !(await crypto.getActiveSessionBackupVersion())) {
                throw new Error('matrix_recovery_incomplete')
              }

              return undefined
            } finally {
              key.privateKey.fill(0)
            }
          })

          return null
        }

        case 'recoveryRestore': {
          if (working || preparing) {
            throw new Error('matrix_recovery_pending')
          }

          discard()
          const key = decodeRecoveryKey(command.key)
          run(async () => {
            try {
              await unlock(key)
              await restoreSigning()
              await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
              await crypto.checkKeyBackupAndEnable()
              requireLive()
              const result = await crypto.restoreKeyBackup()

              return result.imported
            } finally {
              key.fill(0)
            }
          })

          return null
        }
      }
    },
    stop() {
      live = false
      clearReaderPeer()
      discard()
      cache.clear()
      client.off(CryptoEvent.VerificationRequestReceived, received)
      client.off(CryptoEvent.UserTrustStatusChanged, identityChanged)
      client.off(CryptoEvent.DevicesUpdated, devicesChanged)
      active?.detach()

      if (active?.request.pending) {
        void active.request.cancel().catch(() => {})
      }

      active = undefined
    }
  }

  return api
}
