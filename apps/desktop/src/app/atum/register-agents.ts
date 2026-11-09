import { atom, computed } from 'nanostores'

import { adoptDefaultProfileIdentity } from '@/hermes'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { $atumAccountScopeId, $atumAccountStatus, $atumIsAuthenticated } from '@/store/atum-messaging'
import { refreshProfiles } from '@/store/profile'

import { $atumAgents, type AtumAgent } from './agents'
import {
  $atumAssistantDirectory,
  atumAssistantDirectoryWriteEpoch,
  hostedAtumAssistant,
  recordAtumAssistantDirectoryEntry
} from './assistant-directory'
import { ATUM_ASSISTANT_NAME_MAX } from './create-agent'

/**
 * Registration: telling the plane which assistants this person has.
 *
 * Each assistant registers under the identity its backend minted, never under
 * its profile name. The plane answers one of three ways and each is honoured
 * here: `registered` (the row now reflects this device), `stale` (a newer
 * revision is already stored — the stored name stands), and `adopt` — the
 * default assistant already has an identity on the plane, because it is one
 * per PERSON there and one per MACHINE here, so this machine takes the plane's
 * identity for its default profile and re-reads its agents.
 *
 * Best-effort and idempotent: it runs whenever the person is signed in and the
 * set of agents (or their revisions) changes, and again on the next sign-in,
 * so a failure now is a retry later rather than a lost registration. Only
 * assistants Atum made are registered; a profile a person made by hand is
 * Hermes organisation and never leaves the machine.
 */

/**
 * The master assistant IS Atum, so an account that has no default row on the
 * plane yet registers one under the product name rather than the generic
 * "Trợ lý" the S1 backfill used. Only ever sent when `planeDefault` is absent:
 * an account that already has a default keeps the name the plane holds, so a
 * rename a person made is never overwritten from here.
 *
 * The plane reserves this name (`assistants_display_name_valid`), carved out
 * for `is_default` rows — so the platform migration must be deployed before a
 * client that sends this.
 */
const DEFAULT_ASSISTANT_NAME = 'Atum'

export interface AtumAgentRegistrationSummary {
  registered: number
  stale: number
  adopted: number
  failed: number
  skipped: number
}

/** The last run's outcome, for the settings surface and for tests. */
export const $atumAgentRegistration = atom<AtumAgentRegistrationSummary | null>(null)

// Account and messaging snapshots can arrive separately during a handoff.
// Do not send profile metadata until they agree on the signed-in account.
const $registrationAccount = computed(
  [$atumIsAuthenticated, $atumAccountScopeId, $atumAccountStatus],
  (authenticated, scope, account) => (authenticated && scope && scope === account.account?.id ? scope : null)
)

/** Everything that should cause a (re)registration, folded into one string. */
export const $atumAgentRegistrationKey = computed([$registrationAccount, $atumAgents], (account, agents) =>
  account ? JSON.stringify([account, agents.map(agent => [agent.id, agent.identityId, agent.lifecycleRevision])]) : ''
)

function registrable(agent: AtumAgent): boolean {
  if (!agent.isManaged || agent.identityId.length === 0 || agent.localProfileId === null) {return false}
  const hosted = hostedAtumAssistant($atumAssistantDirectory.get(), agent.identityId, agent.isDefault)

  // The cloud lifecycle is authoritative. A retired row must never return via
  // best-effort registration, and definition CAS owns identity writes after a
  // definition exists (legacy lifecycle metadata is deliberately frozen).
  return hosted?.status !== 'retired' && !(hosted && (hosted.definitionRevision ?? 0) > 0)
}

let running: Promise<AtumAgentRegistrationSummary> | null = null
let queued = false

/**
 * Never rejects. Registration is best-effort by design, and it is started
 * from a store subscription that nobody awaits, so a thrown error here would
 * be an unhandled rejection rather than a retry.
 */
export async function registerAtumAgents(): Promise<AtumAgentRegistrationSummary> {
  if (running) {
    queued = true

    return running
  }

  running = drain().finally(() => {
    running = null
  })

  return running
}

async function drain(): Promise<AtumAgentRegistrationSummary> {
  let summary: AtumAgentRegistrationSummary

  do {
    queued = false
    summary = await run()
  } while (queued && $registrationAccount.get())

  return summary
}

async function run(): Promise<AtumAgentRegistrationSummary> {
  const summary: AtumAgentRegistrationSummary = { registered: 0, stale: 0, adopted: 0, failed: 0, skipped: 0 }
  const account = $registrationAccount.get()

  if (!account) {
    $atumAgentRegistration.set(summary)

    return summary
  }

  // A change invalidates this run permanently, including A -> B -> A. Compare
  // at every async boundary before sending more metadata or adopting a reply.
  let valid = true

  const stop = $registrationAccount.listen(next => {
    if (next !== account) {
      valid = false
    }
  })

  const isCurrent = () => valid && $registrationAccount.get() === account

  try {
    await registerSnapshot(summary, isCurrent)
  } catch {
    summary.failed += 1
  } finally {
    stop()
  }

  if (isCurrent()) {
    $atumAgentRegistration.set(summary)
  }

  return summary
}

async function registerSnapshot(summary: AtumAgentRegistrationSummary, isCurrent: () => boolean): Promise<void> {
  // No bridge — a renderer outside the desktop runtime, or a test that never
  // installed one. Nothing to register into; say so and stop.
  let client: ReturnType<typeof atumMessagingClient>

  try {
    client = atumMessagingClient()
  } catch {
    summary.failed += 1

    return
  }

  const agents = $atumAgents.get()
  const directoryWriteEpoch = atumAssistantDirectoryWriteEpoch()

  // What the plane already holds. Only needed for the default assistant, whose
  // name and avatar live on the plane (the backfill named it after the person's
  // Trợ lý) and must not be overwritten by a machine that has nothing to say.
  // A failed read is not an empty registry. In particular, never turn it into
  // a higher-revision placeholder write that erases the hosted default name.
  const planeRows = await client.listAssistants()
  const planeDefault = planeRows.find(row => row.isDefault) ?? null

  if (!isCurrent()) {
    return
  }

  // The directory is account-scoped and mirrors both registry reads and
  // registration outcomes. This makes an existing hosted master immediately
  // available to the roster without treating local profile fields as hosted
  // identity.
  for (const row of planeRows) {
    recordAtumAssistantDirectoryEntry(row, undefined, undefined, { writeEpoch: directoryWriteEpoch })
  }

  let adoptIdentity: string | null = null

  for (const agent of agents) {
    if (!isCurrent()) {
      return
    }

    if (!registrable(agent)) {
      summary.skipped += 1

      continue
    }

    // A legacy Atum profile may predate the 40-character plane contract.
    // Never truncate it into a different identity, or report it registered
    // when main would reject the payload. The roster offers its Rename action.
    if (!agent.isDefault && agent.title.trim().length > ATUM_ASSISTANT_NAME_MAX) {
      summary.skipped += 1

      continue
    }

    try {
      const result = await client.registerAssistant(
        agent.isDefault
          ? {
              identityId: agent.identityId,
              displayName: planeDefault?.displayName || DEFAULT_ASSISTANT_NAME,
              avatar: planeDefault?.avatar ?? '',
              isDefault: true,
              // This payload is a hosted snapshot, not a local metadata edit.
              // A local identity revision must not let it win over a rename
              // that arrived on the plane after listAssistants returned.
              lifecycleRevision: planeDefault?.lifecycleRevision ?? 1
            }
          : {
              identityId: agent.identityId,
              displayName: agent.title,
              avatar: agent.avatar,
              isDefault: false,
              lifecycleRevision: agent.lifecycleRevision
            }
      )

      if (!isCurrent()) {
        return
      }

      recordAtumAssistantDirectoryEntry(result.assistant, undefined, undefined, { writeEpoch: directoryWriteEpoch })

      if (result.outcome === 'adopt') {
        adoptIdentity = result.assistant.identityId
        summary.adopted += 1
      } else if (result.outcome === 'stale') {
        summary.stale += 1
      } else {
        summary.registered += 1
      }
    } catch {
      summary.failed += 1
    }
  }

  // Adopt after the loop so one failure elsewhere cannot leave the default
  // half-moved, and re-read agents so the roster carries the adopted identity.
  if (adoptIdentity && isCurrent()) {
    try {
      await adoptDefaultProfileIdentity(adoptIdentity)

      if (!isCurrent()) {
        return
      }

      await refreshProfiles()
    } catch {
      summary.failed += 1
    }
  }
}

/**
 * Register whenever the person is signed in and the agents change. Returns
 * the unsubscribe. Runs once immediately if there is already something to do.
 */
export function startAtumAgentRegistration(): () => void {
  let last = ''

  return $atumAgentRegistrationKey.subscribe(key => {
    if (!key) {
      last = ''
      $atumAgentRegistration.set(null)

      return
    }

    if (key === last) {
      return
    }

    last = key
    void registerAtumAgents().catch(() => undefined)
  })
}
