import type { MatrixUnverifiedOwnDevice } from './matrix-device-trust'

/** Display state only. Recovery secrets are never included in snapshots. */
export interface MatrixVerification {
  id: string
  userId: string
  deviceId: string
  /** The verification's own transaction ID, the same on both devices (the SDK's
   * `transactionId`): the key request after an approval names the comparison it follows
   * (device-approval.ts). */
  flowId?: string
  incoming: boolean
  state: 'requested' | 'ready' | 'started' | 'compare' | 'done' | 'cancelled'
  decimals?: number[]
  /** Standard SDK [symbol, description] pairs, in SAS order. */
  emoji?: [string, string][]
  /** Why it ended, once `cancelled`: the protocol's own closed code (`m.key_mismatch`,
   * `m.user`, `m.timeout`…), for logs and the agent check's failure. Never free text. */
  cancelCode?: string
  /** Who ended it, when the two sides are different people (an agent and its owner). */
  cancelledBy?: 'self' | 'peer'
}

export interface MatrixSecurity {
  verification?: MatrixVerification
  recovery: 'idle' | 'working' | 'ready' | 'failed'
  /** Read-only SDK confirmation of a backup version, not proof that it contains any key. */
  backupAvailable?: boolean
  restored?: number
  /**
   * Whether the account already has a recovery key on the server (its default secret
   * storage key), from synced account data; absent until the first sync. Presentation
   * only: it picks the one action the recovery step offers, never what is allowed.
   */
  storage?: 'present' | 'absent'
  /**
   * `device`: this Mac made the account's recovery key quietly at first run and keeps it in
   * protected storage, and the person has not yet confirmed writing it down. Presentation
   * only: Settings offers to write it down, and signing out asks for that first.
   */
  custody?: 'device'
  /**
   * This Mac keeps the person's recovery key (electron/matrix/owner-keys.ts), so signing in
   * again here unlocks by itself, and the person can show the key to set up another device.
   * Presentation only; never the key.
   */
  kept?: true
  /**
   * A new device of the person's waiting to be approved (synced account data
   * `io.atum.device_approval`, written by that device): which one, and until when. No secret.
   */
  approvalMarker?: { deviceId: string; requestedAt: number; expiresAt: number }
  /** Approving a new device, or being approved, as main runs it (device-approval.ts). */
  approval?: MatrixApprovalView
  /** The key's copy in iCloud Keychain (electron/matrix/icloud-keychain.ts), present only in a
   * build whose Atum Keys helper works: `on` (the default) or `off`. */
  icloud?: 'on' | 'off'
  /**
   * The key this Mac keeps no longer opens the account's recovery (owner-unlock.ts `stale`): it
   * was changed from another device or sign-in. Atum never changes it by itself, so the key form
   * says so, and nothing here asks other devices or accepts a key from one. Presentation only.
   */
  keyStale?: true
  /** How many times the person's identity that this device verified was replaced while this SDK
   * ran (reset from another device or sign-in): main checks the kept key again when it moves,
   * so the stale notice shows without a relaunch. No secret. */
  identityChanges?: number
  /** How many times this SDK heard the person's own device list change (a device signed in,
   * out, or was signed) while it ran: main reads the list again when it moves (`ownDevices`).
   * No secret, no device. */
  ownDevicesChanges?: number
  /** The person's own devices, seen recently, that their identity has not signed: main fills
   * it from `ownDevices` (electron/matrix/unverified-devices.ts) for the window's reminder.
   * Display facts only. */
  unverifiedDevices?: MatrixUnverifiedOwnDevice[]
}

/**
 * One of the person's devices approving another (electron/matrix/device-approval.ts), as the
 * window shows it. `request`: this Mac asks (it has no key yet); `approve`: another device asks
 * this one. A standard Matrix decimal SAS and a device name only; never a key,
 * never a raw device ID.
 */
export type MatrixApprovalNumbers = [number, number, number]

export interface MatrixApprovalView {
  role: 'request' | 'approve'
  /** `asked`: on the approving device, before the person says it is them. */
  state: 'asked' | 'waiting' | 'compare' | 'unlocking' | 'done' | 'mismatch' | 'declined' | 'timeout' | 'failed'
  /** The other device's own name, when it has one. */
  deviceName?: string
  /** request: all three four-digit values from the standard Matrix decimal SAS. */
  numbers?: MatrixApprovalNumbers
  /** approve: three complete decimal SAS candidates, exactly one matching the other device. */
  choices?: MatrixApprovalNumbers[]
  /** When this state began (the window says when a wait is slow). */
  since: number
  /** request, at `compare`: a new Mac with nothing to check the person's identity against waits
   * for their "I picked this code" before it confirms its side (device-approval.ts). */
  confirm?: true
  /** approve, at `compare`: the person picked the right row here; the rows are gone and the sheet
   * says to tap "I picked this code" on the other device. */
  picked?: true
  /** approve, at `failed`: why, as one closed code (absent means `here`). */
  failure?: MatrixApprovalFailure
}

/**
 * Why an approval failed on the approving device. `there`: this Mac approved that device, but it
 * never finished there (its older messages may stay closed). `here`: this Mac's own part did not
 * finish (it could not approve that device), so trying again later can help.
 */
export type MatrixApprovalFailure = 'there' | 'here'

/** Presentation only: a terminal confirmation banner must not obscure native views. */
export function isMatrixVerificationPending(request: MatrixVerification | undefined): boolean {
  return Boolean(request && request.state !== 'done' && request.state !== 'cancelled')
}

export type MatrixSecurityCommand =
  | { kind: 'verificationStart'; userId: string; deviceId: string }
  | { kind: 'verificationRespond'; id: string; action: 'accept' | 'start' | 'confirm' | 'mismatch' | 'cancel' }
  | { kind: 'recoveryCreateKey' }
  | { kind: 'recoverySetUp'; id: string }
  | { kind: 'recoveryDiscard' }
  | { kind: 'recoveryRestore'; key: string }

export interface MatrixRecoveryKey {
  id: string
  key: string
}

/** Native main/isolated SDK only. Never accepted by the visible UI command parser. */
export type MatrixNativeSecurityCommand =
  /** Main-only quiet agent-trust handshake. Unlike a person-started verification, this may yield
   * to an incoming verification from another device on the owner's own account. */
  | { kind: 'agentVerificationStart'; userId: string; deviceId: string }
  | { kind: 'peerIdentityRead'; roomId: string; userId: string }
  | { kind: 'peerIdentityStart'; roomId: string; userId: string }
  | { kind: 'peerIdentityContinue'; roomId: string; userId: string }
  | { kind: 'securityStatus' }
  /** Main-only: signs an already server-bound owner-reader device with this owner's own keys. */
  | { kind: 'ownerReaderCrossSignDevice'; deviceId: string }
  /** Native enrollment-bound standard SAS; values never enter display snapshots. */
  | { kind: 'ownerReaderVerificationPrepare'; deviceId: string; expiresAt: number }
  | { kind: 'ownerReaderVerificationRead'; deviceId: string }
  | {
      kind: 'ownerReaderVerificationRespond'
      deviceId: string
      flowId: string
      decimal: [number, number, number]
      action: 'confirm' | 'mismatch'
    }
  | { kind: 'agentIdentityStatus' }
  | { kind: 'agentIdentityCreate'; key: string }
  | { kind: 'agentIdentityRestore'; key: string }
  | { kind: 'agentRecoveryGenerate' }
  | MatrixAgentIdentityToDeviceSend
  | MatrixAgentIdentityToDeviceRead
  | { kind: 'agentRecoveryKey'; userId: string; ownerKey: string; key?: string }
  | { kind: 'ownerRecovery'; command: Extract<MatrixSecurityCommand, { kind: 'recoverySetUp' | 'recoveryRestore' }> }
  /** Read-only: what this device still lacks of the person's identity (MatrixOwnerStatus). */
  | { kind: 'ownerStatus' }
  /** Read-only: whether a key is the account's current recovery key (MatrixRecoveryCheck). */
  | { kind: 'recoveryCheck'; key: string }
  /** Silent, complete unlock with a key main keeps: signing, then the key backup, then every
   * old message key in the background (MatrixOwnerRestore). Never creates or replaces anything. */
  | { kind: 'ownerRestore'; key: string }
  /** Read-only: what this device's store knows about one other device and its identity
   * (MatrixAgentTrustStatus): public keys and trust flags only. */
  | { kind: 'agentTrustStatus'; peer: { userId: string; deviceId: string } }
  /** Asks the person's other devices to approve this one (device-approval.ts). */
  | { kind: 'approvalRequest' }
  /** The person's other devices: names, when last active, signed by their identity, and whether
   * this device trusts that identity (MatrixOwnDevices). */
  | { kind: 'ownDevices' }
  /** This device waiting to be approved, in account data for a device that wakes later. */
  | { kind: 'approvalMarker'; marker: { deviceId: string; requestedAt: number; expiresAt: number } | null }
  /** Signs one of the person's own devices just approved here (crossSignDevice). */
  | { kind: 'approveOwnDevice'; deviceId: string }
  /** Names this device ("Atum · {Mac's name}") when it has no name of its own, so another
   * device's approval sheet never shows a raw ID. Never renames a device the person named. */
  | { kind: 'nameOwnDevice'; name: string }
  | MatrixOwnerRecoveryToDeviceSend
  | MatrixOwnerRecoveryToDeviceRead
  | MatrixOwnerRecoveryChannelOpen
  | MatrixOwnerRecoveryDropsRead

export type MatrixAgentIdentityToDeviceEvent =
  | {
      type: 'io.atum.agent_identity.request'
      content: {
        v: 1
        enrollmentId: string
        executorId: string
        agentUserId: string
        deviceId: string
        purpose: 'restore' | 'escrow'
        nonce: string
        expiresAt: number
      }
    }
  | {
      type: 'io.atum.agent_identity.grant'
      content: { v: 1; enrollmentId: string; nonce: string; recoveryKey: string }
    }
  | {
      type: 'io.atum.agent_identity.escrow'
      content: {
        v: 1
        enrollmentId: string
        executorId: string
        agentUserId: string
        expiresAt: number
        nonce: string
        slot: string
        recoveryKey: string
      }
    }
  | { type: 'io.atum.agent_identity.escrowed'; content: { v: 1; enrollmentId: string; nonce: string; slot: string } }
  | {
      type: 'io.atum.agent_identity.refused'
      content: {
        v: 1
        enrollmentId: string
        nonce: string
        reason:
          | 'unknown_enrollment'
          | 'wrong_state'
          | 'device_mismatch'
          | 'expired'
          | 'no_key'
          | 'declined'
          | 'recovery_unavailable'
      }
    }

/** Native main/SDK only. The renderer never receives recovery-bearing events. */
export interface MatrixAgentIdentityToDeviceSend {
  kind: 'agentIdentityToDeviceSend'
  recipient: { userId: string; deviceId: string }
  event: MatrixAgentIdentityToDeviceEvent
}

export interface MatrixAgentIdentityToDeviceRead {
  kind: 'agentIdentityToDeviceRead'
  sender: { userId: string; deviceId: string }
  limit?: number
}

export interface MatrixAgentIdentityStatus {
  recovery: boolean
  ready: boolean
}

/** What this device still lacks of the person's identity. Flags and a public key id only. */
export interface MatrixOwnerStatus {
  /** The account's recovery (its default secret-storage key), from synced account data;
   * absent until the first sync. */
  storage?: 'present' | 'absent'
  /** Which key unlocks it: a public id, never the key. */
  keyId?: string
  /** This device holds the account's signing keys. */
  signing: boolean
  /** This device is signed by the account's identity, as this device sees it. */
  deviceSigned: boolean
  /** The message-key backup is in use here and its decryption key is cached. */
  backup: boolean
  /** This device's own Ed25519 key (public), for the device ledger (device-ledger.ts). */
  ownKey?: string
}

export interface MatrixRecoveryCheck {
  valid: boolean
  /** The key id it unlocks, when valid. */
  keyId?: string
}

export interface MatrixOwnerRestore {
  keyId: string
  /** This device is now signed by the person's identity. */
  signed: boolean
  /** The message-key backup is in use with its key cached; old messages restore in the
   * background. False when the account has no backup or its key could not be loaded. */
  backup: boolean
}

/** One device's view of another (agent trust). Public keys and flags only. */
export interface MatrixAgentTrustStatus {
  /** This device's own Ed25519 key. */
  ownKey: string
  /** The peer device's Ed25519 key as this store knows it; absent when it does not know it. */
  peerKey?: string
  /** The SDK has imported the peer's master identity, so SAS can verify it. */
  peerIdentityKnown: boolean
  /** This store trusts the peer's identity (cross-signed). */
  peerIdentityVerified: boolean
  /** The peer device is signed by that trusted identity. */
  peerDeviceCrossSigned: boolean
  /** This device is signed by its own account's identity. */
  ownDeviceCrossSigned: boolean
}

/** The person's own devices, for approval (device-approval.ts). Display facts only. */
export interface MatrixOwnDevice {
  deviceId: string
  name?: string
  lastSeenAt?: number
  /** Signed by the identity the server serves now (cross-signed), trusted or not. */
  signedByOwner: boolean
  /** Signed by an identity this device has verified. */
  crossSigningVerified: boolean
  /** Verified by hand on this device (an out-of-band fingerprint check), signed or not. */
  locallyVerified?: true
}

/**
 * The person's other devices, and what this device knows of their identity (`ownDevices`):
 * `verified` (it trusts the identity the server serves now), `new` (it never verified one: a new
 * Mac has nothing to check it against), `changed` (it verified an earlier one, and the server now
 * serves another: replaced from another device or sign-in).
 */
export interface MatrixOwnDevices {
  devices: MatrixOwnDevice[]
  identity: 'verified' | 'new' | 'changed'
}

/** Between one person's own devices only (owner-recovery-carrier.ts). `txn` is the transaction
 * ID of the comparison the request follows (`MatrixVerification.flowId`); `nonce` is new for each
 * request run and binds the grant to it. */
export type MatrixOwnerRecoveryEvent =
  | { type: 'io.atum.owner_recovery.request'; content: { v: 1; nonce: string; txn: string } }
  | {
      type: 'io.atum.owner_recovery.grant'
      content: { v: 1; nonce: string; txn: string; recoveryKey: string; keyId: string }
    }

export type MatrixOwnerRecoveryMessage = MatrixOwnerRecoveryEvent & { senderDeviceId: string; receivedAt: number }

/** Native main/SDK only. The window never receives a grant. */
export interface MatrixOwnerRecoveryToDeviceSend {
  kind: 'ownerRecoveryToDeviceSend'
  recipient: { userId: string; deviceId: string }
  event: MatrixOwnerRecoveryEvent
}

/**
 * Native main/SDK only. Opens the encrypted channel to one of the person's other devices (an Olm
 * session, with a `m.dummy` message that carries nothing) before anything is asked over it.
 * Without it the key request and the approving device's own secret sharing both start a session
 * at the moment the comparison finishes, and the two collide (owner-recovery-carrier.ts).
 */
export interface MatrixOwnerRecoveryChannelOpen {
  kind: 'ownerRecoveryChannelOpen'
  recipient: { userId: string; deviceId: string }
}

export interface MatrixOwnerRecoveryToDeviceRead {
  kind: 'ownerRecoveryToDeviceRead'
  senderDeviceId: string
}

/** Why the carrier (owner-recovery-carrier.ts) dropped an owner-recovery message: closed codes
 * for main's log, never the message, its sender or its device. */
export const MATRIX_OWNER_RECOVERY_DROP_REASONS = [
  'not_encrypted',
  'unverified_sender',
  'unknown_sender',
  'other_person',
  'own_device',
  'invalid',
  'overflow'
] as const

export type MatrixOwnerRecoveryDropReason = (typeof MATRIX_OWNER_RECOVERY_DROP_REASONS)[number]

export interface MatrixOwnerRecoveryDrop {
  reason: MatrixOwnerRecoveryDropReason
  count: number
}

/** Native main/SDK only: the carrier's drops since the last read (recent ones only), cleared on
 * read. */
export interface MatrixOwnerRecoveryDropsRead {
  kind: 'ownerRecoveryDrops'
}
