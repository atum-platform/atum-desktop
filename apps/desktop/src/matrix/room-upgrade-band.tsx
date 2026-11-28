import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Info } from '@/lib/icons'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { useConversationAction } from './conversation-controls'
import { useRoomUpgradeCopy } from './room-upgrade-copy'

function Line({ action, label, onClick, disabled }: { action: string; disabled: boolean; label: string; onClick(): void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">
      <Info aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{label}</span>
      <Button disabled={disabled} onClick={onClick} size="sm" variant="text">
        {action}
      </Button>
    </div>
  )
}

/**
 * An upgraded room says so in its own chat, with one action: go to the new room (joined here only on
 * this click) or, on the new room, see the earlier messages. A replacement that cannot be confirmed
 * or reached is one line and no action. The old history is never hidden by any of it.
 */
export function RoomUpgradeBand({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const copy = useRoomUpgradeCopy()
  const action = useConversationAction()
  const idle = snapshot.state === 'ready' && !action.pending
  const { predecessor, successor } = room

  if (!successor && !predecessor) {
    return null
  }

  return (
    <section data-room-upgrade>
      {successor &&
        (action.error || successor.state === 'unconfirmed' ? (
          <NoticeBand data-room-upgrade-state="unavailable" role="status" tone="notice">
            {action.error ? copy.unavailable : copy.unconfirmed}
          </NoticeBand>
        ) : (
          <Line
            action={successor.state === 'open' ? copy.open : copy.join}
            disabled={!idle}
            label={copy.moved}
            onClick={() => action.run({ kind: 'joinSuccessor', roomId: room.id })}
          />
        ))}
      {predecessor && (
        <Line
          action={copy.earlier}
          disabled={!idle}
          label={copy.continues}
          onClick={() => action.run({ kind: 'select', roomId: predecessor.roomId })}
        />
      )}
    </section>
  )
}
