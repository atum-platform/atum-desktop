import type { MatrixIdentity, MatrixSdkCommand } from '../../shared/matrix'
import type { MatrixAgentIdentityStatus, MatrixAgentTrustStatus, MatrixRecoveryKey } from '../../shared/matrix-security'

import { verifyOwnedMatrixAgent } from './agent-verification'

export interface MatrixAgentTrustPort {
  identity: MatrixIdentity
  command(value: MatrixSdkCommand): Promise<unknown>
}

/**
 * How the owner and the agent came to trust each other: by cross-signing they already had
 * (`cross_signed`: each side's identity signed the other's, and each device is signed by its own
 * identity, so nothing else is needed), or by a handshake now (`verified`, SAS: an identity just
 * made or reset, or a signature the stores have not seen yet).
 */
export type MatrixAgentTrustResult = 'cross_signed' | 'verified'

/** Closed, value-free diagnostics. Unknown device keys are not reported as unequal keys. */
function trustDiagnostic(
  log: ((line: string) => void) | undefined,
  branch: 'initializer_denied' | 'peer_identity_unknown' | 'peer_status',
  owner?: MatrixAgentTrustStatus,
  agent?: MatrixAgentTrustStatus
) {
  const flags = owner && agent
    ? ` owner_peer_identity_known=${owner.peerIdentityKnown} agent_peer_identity_known=${agent.peerIdentityKnown}` +
      ` owner_signed=${owner.ownDeviceCrossSigned} agent_signed=${agent.ownDeviceCrossSigned}` +
      ` owner_peer_signed=${owner.peerDeviceCrossSigned} agent_peer_signed=${agent.peerDeviceCrossSigned}` +
      ` owner_key_equal=${agent.peerKey === undefined ? 'unknown' : agent.peerKey === owner.ownKey}` +
      ` agent_key_equal=${owner.peerKey === undefined ? 'unknown' : owner.peerKey === agent.ownKey}`
    : ''

  try {
    log?.(`[Matrix] agent trust branch=${branch}${flags}`)
  } catch {
    // Diagnostic delivery cannot change trust or authorize a fallback.
  }
}

/** How long to wait for a store to learn a device it has not seen yet (a new executor, a new
 * human device) before falling back to the handshake. */
const PEER_WAIT_MS = 5_000
const PEER_POLL_MS = 500

function trustView(value: unknown): MatrixAgentTrustStatus {
  const view = value as MatrixAgentTrustStatus | null
  const key = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128

  if (
    !view ||
    typeof view !== 'object' ||
    !key(view.ownKey) ||
    (view.peerKey !== undefined && !key(view.peerKey)) ||
    typeof view.peerIdentityKnown !== 'boolean' ||
    typeof view.peerIdentityVerified !== 'boolean' ||
    typeof view.peerDeviceCrossSigned !== 'boolean' ||
    typeof view.ownDeviceCrossSigned !== 'boolean'
  ) {
    throw new Error('matrix_agent_identity_invalid')
  }

  return view
}

/** One native operation. Caller serializes owner SSSS/SAS across its agents. The
 * platform's permanent initializer claim serializes initial creation across Macs.
 * Matrix itself owns all cryptography, backup, signing and verification. */
export async function prepareMatrixAgentTrust(input: {
  owner: MatrixAgentTrustPort
  agent: MatrixAgentTrustPort
  ownerKey: string | undefined
  claim: () => Promise<boolean>
  assertCurrent: () => void
  /** Main's logger; only fixed branch names and boolean facts are emitted. */
  log?: (line: string) => void
  /** Tests advance a clock instead of waiting for a store to learn a device. */
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<MatrixAgentTrustResult> {
  const { owner, agent, ownerKey, assertCurrent } = input
  assertCurrent()

  if (!ownerKey) {
    throw new Error('matrix_owner_recovery_required')
  }

  const run = async (port: MatrixAgentTrustPort, value: MatrixSdkCommand) => {
    assertCurrent()
    const result = await port.command(value)
    assertCurrent()

    return result
  }

  const raw = await run(owner, { kind: 'agentRecoveryKey', userId: agent.identity.userId, ownerKey })

  if (raw !== null && (typeof raw !== 'string' || !raw || raw.length > 256)) {
    throw new Error('matrix_agent_recovery_invalid')
  }

  let key = raw as string | null
  const status = (await run(agent, { kind: 'agentIdentityStatus' })) as MatrixAgentIdentityStatus | null

  if (!status || typeof status.ready !== 'boolean' || typeof status.recovery !== 'boolean') {
    throw new Error('matrix_agent_identity_invalid')
  }

  if (!status.ready) {
    if (status.recovery) {
      if (!key) {
        throw new Error('matrix_agent_recovery_missing')
      }

      await run(agent, { kind: 'agentIdentityRestore', key })
    } else {
      // Read-only discovery is insufficient to create. A losing/expired/missing
      // claim cannot turn into a new identity, even if a cache looks empty.
      const initializer = await input.claim()
      assertCurrent()

      if (!initializer) {
        trustDiagnostic(input.log, 'initializer_denied')
        throw new Error('matrix_agent_initialization_pending')
      }

      if (!key) {
        const made = (await run(agent, { kind: 'recoveryCreateKey' })) as MatrixRecoveryKey | null

        if (!made || typeof made.key !== 'string' || !made.key || made.key.length > 256) {
          throw new Error('matrix_agent_recovery_invalid')
        }

        key = made.key
        const persisted = await run(owner, { kind: 'agentRecoveryKey', userId: agent.identity.userId, ownerKey, key })

        if (persisted !== key) {
          throw new Error('matrix_agent_recovery_incomplete')
        }
      }

      await run(agent, { kind: 'agentIdentityCreate', key })
    }
  } else if (!key) {
    // Existing identity without portable custody is not a blank account.
    throw new Error('matrix_agent_recovery_missing')
  }

  // What each store already knows of the other device . A store that has not seen the other device yet (a new
  // executor or a new human device) learns it within a sync; wait briefly before deciding.
  const now = input.now ?? Date.now
  const wait = input.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const deadline = now() + PEER_WAIT_MS
  let ownerView: MatrixAgentTrustStatus
  let agentView: MatrixAgentTrustStatus

  for (;;) {
    ownerView = trustView(await run(owner, { kind: 'agentTrustStatus', peer: agent.identity }))
    agentView = trustView(await run(agent, { kind: 'agentTrustStatus', peer: owner.identity }))

    if (
      (ownerView.peerKey && agentView.peerKey && ownerView.peerIdentityKnown && agentView.peerIdentityKnown) ||
      now() >= deadline
    ) {
      break
    }

    await wait(PEER_POLL_MS)
  }

  // Device keys may arrive before a freshly bootstrapped master identity. A SAS
  // started then can verify only that device, leaving every restored/cloud device
  // untrusted. Let sync import both identities before the real handshake begins.
  if (!ownerView.peerIdentityKnown || !agentView.peerIdentityKnown) {
    trustDiagnostic(input.log, 'peer_identity_unknown', ownerView, agentView)
    throw new Error('matrix_agent_initialization_pending')
  }

  trustDiagnostic(input.log, 'peer_status', ownerView, agentView)

  // The agent's device came back with new keys under the same ID (its local store was lost, as
  // Atum Moon's on 2026-10-04): the owner's store keeps the first keys it saw for that ID and
  // refuses the new ones for good, so a handshake can only be cancelled. The device must be
  // replaced (main re-enrolls the agent here).
  if (ownerView.peerKey && ownerView.peerKey !== agentView.ownKey) {
    throw new Error('matrix_agent_device_replaced')
  }

  // The same for the person's own device on this Mac: only signing in again (a new device)
  // mends it.
  if (agentView.peerKey && agentView.peerKey !== ownerView.ownKey) {
    throw new Error('matrix_owner_device_replaced')
  }

  // Each identity already signed the other (the person's user-signing key over the agent's
  // master key, and the agent's over the person's: the CH5 pairing), and each device is signed
  // by its own identity: both sides already trust each other, with nothing to compare.
  if (
    ownerView.peerKey === agentView.ownKey &&
    agentView.peerKey === ownerView.ownKey &&
    ownerView.peerIdentityVerified &&
    ownerView.peerDeviceCrossSigned &&
    ownerView.ownDeviceCrossSigned &&
    agentView.peerIdentityVerified &&
    agentView.peerDeviceCrossSigned &&
    agentView.ownDeviceCrossSigned
  ) {
    assertCurrent()

    return 'cross_signed'
  }

  await verifyOwnedMatrixAgent(owner, agent, assertCurrent)
  assertCurrent()

  const ownerDeviceKey = ownerView.ownKey
  const agentDeviceKey = agentView.ownKey
  const signedBy = now() + PEER_WAIT_MS

  for (;;) {
    ownerView = trustView(await run(owner, { kind: 'agentTrustStatus', peer: agent.identity }))
    agentView = trustView(await run(agent, { kind: 'agentTrustStatus', peer: owner.identity }))

    if (ownerView.ownKey !== ownerDeviceKey || (agentView.peerKey && agentView.peerKey !== ownerDeviceKey)) {
      throw new Error('matrix_owner_device_replaced')
    }

    if (agentView.ownKey !== agentDeviceKey || (ownerView.peerKey && ownerView.peerKey !== agentDeviceKey)) {
      throw new Error('matrix_agent_device_replaced')
    }

    if (
      ownerView.peerKey === agentDeviceKey &&
      agentView.peerKey === ownerDeviceKey &&
      ownerView.peerIdentityVerified &&
      ownerView.peerDeviceCrossSigned &&
      ownerView.ownDeviceCrossSigned &&
      agentView.peerIdentityVerified &&
      agentView.peerDeviceCrossSigned &&
      agentView.ownDeviceCrossSigned
    ) {
      return 'verified'
    }

    if (now() >= signedBy) {
      throw new Error('matrix_agent_verification_incomplete')
    }

    await wait(PEER_POLL_MS)
  }
}

/** A failure's closed code for a log line (`matrix_…` with up to two stages), never raw text. */
function trustLogCode(error: unknown): string {
  return error instanceof Error && /^matrix_[a-z0-9_]+(?::[A-Za-z0-9._-]+){0,2}$/.test(error.message)
    ? error.message
    : 'unexpected'
}

/**
 * Owner–agent trust in the background (0.20, owner decision D1): it only serves encrypted rooms
 * (an encrypted group, or a main room that has not moved to a plain one yet), so it never holds
 * an agent's readiness or a new agent's connection. One line when it fails; the trust step logs
 * its own result when it runs.
 */
export function backgroundAgentTrust(
  trust: () => Promise<unknown>,
  stage: 'readiness' | 'connect',
  log: (line: string) => void
): void {
  void trust().catch(error =>
    log(`[Matrix] agent trust background stage=${stage} outcome=failed code=${trustLogCode(error)}`)
  )
}

/**
 * When an agent's host is ready again, its routines resume. While its main room is still
 * encrypted they wait for trust as before (their posts need the room keys); once it is plain they
 * resume whatever trust does, which then only serves encrypted rooms.
 */
export function resumeAfterAgentTrust(
  trust: () => Promise<unknown>,
  mainRoomPlain: boolean,
  resume: () => void
): Promise<void> {
  return mainRoomPlain
    ? trust()
        .catch(() => {})
        .then(resume)
    : trust().then(resume, () => {})
}
