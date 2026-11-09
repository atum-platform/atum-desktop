import { atom } from 'nanostores'

import { COMPANY_SHORTCUT_SLOTS } from './company-switcher'

/** Which company to move to: the Nth in the shown order (1-9), or a step before or after the current one. */
export type CompanyTarget = { slot: number } | { step: 1 | -1 }

/**
 * Things other parts of the window ask the Team Space workspace to do: the channel header's menu
 * asks for a roster, a member list, a confirmation. The workspace owns the dialogs and the single
 * pending-change journal, so a request is a note left here, never a second place that sends.
 */
export type TeamSpaceIntent =
  | { kind: 'browse-channels' }
  | { kind: 'create-channel' }
  | { kind: 'invite-members' }
  /** `field` opens the details on that field (the channel intro's "Add a description"). */
  | { kind: 'channel-details'; channelId: string; field?: 'purpose' }
  | { kind: 'channel-members'; channelId: string }
  | { kind: 'add-people'; channelId: string }
  | { kind: 'leave-channel'; channelId: string }
  | { kind: 'archive-channel'; channelId: string }
  | { kind: 'restore-channel'; channelId: string }
  | { kind: 'conversation-add-people'; conversationId: string }
  | { kind: 'conversation-hide'; conversationId: string }
  | { kind: 'switch-company'; to: CompanyTarget }
  /** A Chief of Staff thread line said the company is out of Protons: the owner opens its wallet. */
  | { kind: 'open-wallet'; companyId: string }

export interface TeamSpaceIntentRequest {
  id: number
  intent: TeamSpaceIntent
}

export const $teamSpaceIntent = atom<TeamSpaceIntentRequest | undefined>(undefined)

let sequence = 0

export function requestTeamSpaceIntent(intent: TeamSpaceIntent): void {
  $teamSpaceIntent.set({ id: ++sequence, intent })
}

/**
 * The shell's handlers for the company shortcuts, by keybind action id (`lib/keybinds/actions.ts`). The shell does
 * not know the companies; it leaves a note and the workspace, which does, moves.
 */
export function companyShortcutHandlers(): Record<string, () => void> {
  const move = (to: CompanyTarget) => () => requestTeamSpaceIntent({ kind: 'switch-company', to })

  return {
    'nav.companyPrev': move({ step: -1 }),
    'nav.companyNext': move({ step: 1 }),
    ...Object.fromEntries(
      Array.from({ length: COMPANY_SHORTCUT_SLOTS }, (_, index) => [`nav.company.${index + 1}`, move({ slot: index + 1 })])
    )
  }
}
