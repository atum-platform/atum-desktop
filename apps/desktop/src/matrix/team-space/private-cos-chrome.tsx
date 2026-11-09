import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Bell, BellOff, MoreHorizontal, Palette } from '@/lib/icons'

import type { MatrixRoom } from '../../../shared/matrix'
import { matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import { useChatCopy } from '../chat-copy'
import { CompanyAIAvatar } from '../company-ai-status'
import { useRoomFlag } from '../conversation-menu'
import { runMatrixCommand } from '../text-document-actions'

import { useTeamSpaceCopy } from './copy'
import { teamSpaceKey } from './keys'
import { $companyPrivateCos } from './private-cos-store'

type PrivateCosRoom = Pick<MatrixRoom, 'companyPrivateCos' | 'id' | 'muted'>

/**
 * The company's Chief of Staff, as its row in the workspace names it ("Chief of Staff" in the
 * reader's language): the open private chat, its header and its box all use this one name.
 */
export function usePrivateCosName(): string {
  const { locale } = useI18n()

  return matrixCompanyBoardCopy(locale).chiefOfStaff
}

/**
 * The open private chat's face: the same Chief of Staff avatar as its workspace row (an assistant,
 * so a circle), keyed by the platform binding's agent. Never the person's own assistant.
 */
export function PrivateCosFaceFor({ accountKey, className, room }: {
  accountKey: string
  className: string
  room: PrivateCosRoom
}) {
  const name = usePrivateCosName()
  const companyId = room.companyPrivateCos?.companyId
  const key = companyId ? teamSpaceKey(accountKey, companyId) : ''
  const state = useStore($companyPrivateCos, { keys: [key] })[key]

  const principal = state && 'binding' in state.view
    ? state.view.binding.agentPrincipal
    : room.companyPrivateCos?.membershipIncarnation ?? room.id

  return <CompanyAIAvatar className={className} name={name} principal={principal} />
}

/**
 * The private chat's header menu. Like a company conversation's, it has no leave, delete, rename
 * or block: the room is the platform's, bound to this person's membership. What stays is this
 * person's own view of it: notifications and the chat's background.
 */
export function PrivateCosMenu({ fail, onBackground, room }: {
  fail?(cause?: unknown): void
  onBackground?: () => void
  room: PrivateCosRoom
}) {
  const chat = useChatCopy()
  const { team } = useTeamSpaceCopy()
  const mute = useRoomFlag(Boolean(room.muted))

  return (
    <DropdownMenu>
      <Tip label={team.conversationMenu}>
        <DropdownMenuTrigger asChild>
          <Button aria-label={team.conversationMenu} data-matrix-private-cos-menu size="icon-sm" variant="ghost">
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          disabled={mute.busy}
          onSelect={() => mute.change(
            !mute.value,
            () => runMatrixCommand({ kind: 'mute', roomId: room.id, muted: !mute.value }),
            fail ?? (() => {})
          )}
        >
          {mute.value ? <Bell aria-hidden /> : <BellOff aria-hidden />}
          {mute.value ? chat.unmute : chat.mute}
        </DropdownMenuItem>
        {onBackground && (
          <DropdownMenuItem onSelect={onBackground}>
            <Palette aria-hidden />
            {chat.background}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
