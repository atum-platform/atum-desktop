import { useMemo } from 'react'

import { appCatalogNames, type AppDescriptor } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { MatrixAddFriend } from './add-friend'
import { NewAssistantDialog } from './agent-roster'
import { resolveProjectedConversation } from './conversation-marker'
import { MatrixNewGroup } from './new-group'
import { projectMatrixRoster } from './roster-model'
import { matrixRoomHasUnread } from './roster-preview'
import { MatrixStartChat } from './start-chat'

/** Which of the roster's creation dialogs is open. One at a time: each hands over to the next. */
export type MatrixRosterCreation =
  | { kind: 'start' }
  | { kind: 'friend'; query?: string }
  | { kind: 'group' }
  | { kind: 'assistant' }

export interface MatrixRosterCreateProps {
  creating: MatrixRosterCreation | null
  onCreatingChange(next: MatrixRosterCreation | null): void
  snapshot: MatrixSnapshot
  /** The roster's own paths, so a pick here behaves exactly like a click in the list. */
  openAssistant(): void
  openAgentChat(agent: MatrixAgentView): void
  selectRoom(roomId: string): void
  /** An app opens the way its roster row opens it: an official bot's chat, else the app's page. */
  openApp(app: AppDescriptor): void
  /** A conversation was just made (a new assistant's included); Matrix selected it. */
  onConversationCreated(): void
}

/**
 * The roster's creation flows, composed in one place: the start menu behind the "+", and
 * the friend, group and assistant dialogs it (or the button under the assistants) opens.
 * Matrix stays the authority: every path is an existing command or bridge call.
 */
export function MatrixRosterCreate({
  creating,
  onConversationCreated,
  onCreatingChange,
  openAgentChat,
  openAssistant,
  openApp,
  selectRoom,
  snapshot
}: MatrixRosterCreateProps) {
  const ready = snapshot.state === 'ready'
  const canFindPeople = Boolean(snapshot.domainEnabled && window.atumMatrix?.aliases)
  const canCreateAssistant = Boolean(snapshot.assistant && snapshot.agentCreation)
  const closeWith = (open: boolean) => !open && onCreatingChange(null)
  // The names the catalog's apps go by: not an assistant's to take.
  const appNames = useMemo(() => appCatalogNames(snapshot.apps?.apps), [snapshot.apps?.apps])

  /**
   * An assistant opens the way its roster row does (`roster-conversations.tsx`): the default
   * one through its own path; another its one conversation once marked (Plan 7), never a
   * newer Earlier or stray room; before that, a chat with unread messages, else its newest;
   * a first chat only when it has none.
   */
  const pickAssistant = (agent: MatrixAgentView) => {
    if (agent.isDefault) {
      openAssistant()

      return
    }

    const rooms =
      projectMatrixRoster(snapshot).groups.find(each => each.agent.principal === agent.principal)?.rooms ?? []

    const roomId =
      resolveProjectedConversation(rooms, snapshot.identity?.userId, agent.userId).main ??
      (rooms.find(matrixRoomHasUnread) ?? rooms[0])?.id

    if (roomId) {
      selectRoom(roomId)
    } else {
      openAgentChat(agent)
    }
  }

  return (
    <>
      <MatrixStartChat
        canCreateAssistant={canCreateAssistant}
        canFindPeople={canFindPeople}
        onFindPerson={query => onCreatingChange({ kind: 'friend', query })}
        onNewAssistant={() => onCreatingChange({ kind: 'assistant' })}
        onNewGroup={() => onCreatingChange({ kind: 'group' })}
        onOpenChange={closeWith}
        onPickApp={appId => {
          const app = snapshot.apps?.apps.find(value => value.app_id === appId)

          if (app) {
            openApp(app)
          }
        }}
        onPickAssistant={pickAssistant}
        onPickRoom={selectRoom}
        open={creating?.kind === 'start'}
        snapshot={snapshot}
      />
      <MatrixAddFriend
        initialQuery={creating?.kind === 'friend' ? creating.query : undefined}
        onCreated={onConversationCreated}
        onOpenAssistant={agent => {
          // The roster's own projection says which agent is the default.
          const group = projectMatrixRoster(snapshot).groups.find(each => each.agent.principal === agent.principal)
          pickAssistant(group?.agent ?? agent)
        }}
        onOpenChange={closeWith}
        onOpenRoom={selectRoom}
        open={creating?.kind === 'friend'}
        snapshot={snapshot}
      />
      <MatrixNewGroup
        onCreated={onConversationCreated}
        onOpenChange={closeWith}
        open={creating?.kind === 'group'}
        snapshot={snapshot}
      />
      {canCreateAssistant && (
        <NewAssistantDialog
          agents={snapshot.agents}
          apps={appNames}
          onCreated={onConversationCreated}
          onOpenChange={closeWith}
          open={creating?.kind === 'assistant'}
          ready={ready}
        />
      )}
    </>
  )
}
