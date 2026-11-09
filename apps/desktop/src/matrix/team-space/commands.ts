import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import type { CompanyChannelCommand14Request, CompanyChannelCommand15Request } from '../../../shared/matrix-company-team-space'

import type { MutationOutcome, TeamSpaceMutate } from './outcome'
import { requestTeamSpace } from './request'

export interface ChannelGenerations {
  /** The channel's own generation: any join, leave, invitation or removal advances it. */
  channel: number
  /** The viewer's admission generation, for the commands that act on it (leave, accept). */
  admission: number
}

/**
 * Every 1.4 command except create carries the channel generation it was decided at, and a stale
 * one is refused rather than overwritten. A person acting on a channel therefore acts on what the
 * platform says *now*: read the admitted snapshot just before the command, never the directory
 * drawn a minute ago. A read that fails is a command that does not start.
 */
export async function freshChannelGenerations(
  bridge: MatrixCompanyBridge,
  companyId: string,
  channelId: string
): Promise<ChannelGenerations | undefined> {
  const result = await requestTeamSpace(bridge, { action: 'read-admitted-channel', companyId, channelId })

  return result.ok
    ? { channel: result.value.channel.channelGeneration, admission: result.value.selfAdmission.admissionGeneration }
    : undefined
}

const UNAVAILABLE: MutationOutcome = { ok: false, error: 'unavailable', uncertain: false }

/** The fresh generations, then the command built from them, through the workspace's journal. */
export async function runChannelCommand(
  bridge: MatrixCompanyBridge,
  mutate: TeamSpaceMutate,
  target: { companyId: string; channelId: string },
  build: (generations: ChannelGenerations) => CompanyChannelCommand14Request | CompanyChannelCommand15Request
): Promise<MutationOutcome | undefined> {
  const generations = await freshChannelGenerations(bridge, target.companyId, target.channelId)

  if (!generations) {
    return UNAVAILABLE
  }

  return mutate({ action: 'channel-command', companyId: target.companyId, channelId: target.channelId, command: build(generations) })
}

/** One person's place in a new channel: added, refused (with the outcome), or left with the workspace's Retry. */
export type ChannelAddResult =
  | { memberRef: string; state: 'added' | 'pending' }
  | { memberRef: string; state: 'failed'; outcome: Extract<MutationOutcome, { ok: false }> }

/**
 * Adds people to a channel directly (company channel command 1.1 `add`), one at a time: each add advances the
 * channel's generation, so every one is decided on a fresh read and they never race. A refusal does not stop the
 * rest; an unclear answer is left to the workspace's Retry (never re-sent here under a new id). Create a channel
 * uses it only for the people its create command could not take, and for their Try again.
 */
export async function addToChannel(
  bridge: MatrixCompanyBridge,
  mutate: TeamSpaceMutate,
  target: { companyId: string; channelId: string },
  memberRefs: readonly string[]
): Promise<ChannelAddResult[]> {
  const results: ChannelAddResult[] = []

  for (const memberRef of memberRefs) {
    const outcome = await runChannelCommand(bridge, mutate, target, generations => ({
      requestId: globalThis.crypto.randomUUID(),
      operation: 'add',
      memberRef,
      expectedChannelGeneration: generations.channel
    }))

    if (!outcome) {
      results.push({ memberRef, state: 'failed', outcome: { ok: false, error: 'unavailable', uncertain: false, notAllowed: true } })
    } else if (outcome.ok) {
      results.push({ memberRef, state: 'added' })
    } else if (outcome.uncertain) {
      results.push({ memberRef, state: 'pending' })
    } else {
      results.push({ memberRef, state: 'failed', outcome })
    }
  }

  return results
}
