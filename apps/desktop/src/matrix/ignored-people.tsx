import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'

import type { MatrixSnapshot } from '../../shared/matrix'

import { useConversationAction } from './conversation-controls'
import { useConversationCopy } from './conversation-copy'
import { useModerationCopy } from './moderation-copy'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { personHandleText } from './person-handle-line'
import { useMatrixPeople } from './person-handles'
import { type MatrixPeopleContext, matrixPersonLabel } from './person-name'
import { SettingsRow, SettingsSection } from './settings-row'

/** Who an ignored person is, as the chats know them: the name of a direct chat with them,
 * else their verified @handle, else the word for someone unnamed. Never a Matrix ID. */
export function ignoredPersonName(
  snapshot: MatrixSnapshot,
  userId: string,
  { handles, unnamed }: Pick<MatrixPeopleContext, 'handles' | 'unnamed'>
): string {
  const direct = snapshot.rooms.find(
    room => room.direct && room.name?.trim() && room.participants?.some(participant => participant.userId === userId)
  )

  return (
    direct?.name?.trim() ||
    // As before, an address is not spelled out here: the list only takes an ignore back.
    matrixPersonLabel({ handle: handles?.[userId], unnamed, userId }).name
  )
}

/**
 * Account-keyed UI. The list comes only from SDK account data, never local state. Ignoring
 * someone happens beside them, in a chat's people list; here a section of its own says who
 * is ignored and takes it back, one row each. The count shows only when there is someone
 * in it; with nobody, one quiet row says how ignoring works.
 */
export function IgnoredPeople({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useModerationCopy()
  const conversation = useConversationCopy()
  const action = useConversationAction()
  const ready = snapshot.state === 'ready' && !action.pending
  const users = snapshot.ignoredUsers ?? []
  const people = useMatrixPeople(undefined, snapshot.identity?.userId)
  useMatrixHandleContacts(snapshot.identity?.userId, users, Boolean(snapshot.domainEnabled))

  return (
    <SettingsSection
      data-matrix-ignored-people
      help={copy.ignoredHelp}
      title={users.length > 0 ? `${copy.ignoredPeople} (${users.length})` : copy.ignoredPeople}
    >
      {users.length === 0 ? (
        <SettingsRow className="atum-settings-row-quiet" help={copy.ignoredHow} title={copy.empty} />
      ) : (
        users.map(userId => {
          const name = ignoredPersonName(snapshot, userId, people)
          const handle = personHandleText(people.handles?.[userId])

          return (
            <SettingsRow
              control={
                <Button
                  aria-label={`${copy.unignore} ${name}`}
                  disabled={!ready}
                  onClick={() => action.run({ kind: 'ignore', userId, ignored: false })}
                  size="sm"
                  variant="secondary"
                >
                  {copy.unignore}
                </Button>
              }
              // Who they are, when the directory vouched for their @handle (never an address).
              help={handle !== name ? handle : undefined}
              key={userId}
              title={<span className="truncate">{name}</span>}
            />
          )
        })
      )}
      {action.error && (
        <div className="atum-settings-item">
          <NoticeBand role="alert" tone="failure">
            {conversation.error}
          </NoticeBand>
        </div>
      )}
    </SettingsSection>
  )
}
