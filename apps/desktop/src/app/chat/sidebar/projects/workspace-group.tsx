import type * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { setWorkspaceNodeOpen } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { newSessionInProfile } from '@/store/profile'
import { switchBranchInRepo } from '@/store/projects'

import { countLabel, SidebarRowStack } from '../chrome'
import { SidebarLoadMoreRow } from '../load-more-row'

import { SIDEBAR_GROUP_PAGE, useWorkspaceNodeOpen } from './model'
import type { SidebarSessionGroup } from './workspace-groups'
import { WorkspaceAddButton, WorkspaceHeader, WorkspaceMenu, WorkspaceShowMoreButton } from './workspace-header'

interface SidebarWorkspaceGroupProps {
  group: SidebarSessionGroup
  renderRows: (sessions: SessionInfo[]) => React.ReactNode
  onNewSession?: (path: null | string) => void
  // When set (linked worktree rows), shows a remove affordance that runs a real
  // `git worktree remove`.
  onRemove?: () => void
}

export function SidebarWorkspaceGroup({ group, renderRows, onNewSession, onRemove }: SidebarWorkspaceGroupProps) {
  const { t } = useI18n()
  const s = t.sidebar
  const isProfileGroup = group.mode === 'profile'
  // Empty worktree/branch lanes start collapsed — they only show a "No sessions
  // yet" placeholder, so defaulting them open just adds noise. Profile lanes and
  // lanes that already hold sessions default open.
  const defaultOpen = isProfileGroup || group.sessions.length > 0
  const [open, toggleOpen] = useWorkspaceNodeOpen(group.id, defaultOpen)
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_GROUP_PAGE)

  const loadedCount = group.sessions.length
  // Profile groups know their on-disk total (children excluded); workspace
  // groups only ever page within what's already loaded.
  const totalCount = isProfileGroup ? Math.max(group.totalCount ?? loadedCount, loadedCount) : loadedCount
  const visibleSessions = group.sessions.slice(0, visibleCount)
  const hiddenCount = Math.max(0, totalCount - visibleSessions.length)
  const nextCount = Math.min(SIDEBAR_GROUP_PAGE, hiddenCount)

  // Leading glyph: profile color dot, a home mark for the repo's primary
  // checkout (labeled by its live branch), or a branch/kanban mark otherwise.
  const leadingIcon = group.color ? (
    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
  ) : (
    <Codicon
      className="shrink-0 text-(--ui-text-tertiary)"
      name={group.isKanban ? 'checklist' : group.isHome ? 'home' : 'git-branch'}
      size="0.75rem"
    />
  )

  // Reveal already-loaded rows first; only hit the backend when the next page
  // crosses what's been fetched for this profile.
  const handleProfileLoadMore = () => {
    const target = visibleCount + SIDEBAR_GROUP_PAGE

    setVisibleCount(target)

    if (target > loadedCount && loadedCount < totalCount) {
      group.onLoadMore?.()
    }
  }

  const handleNewSession = async () => {
    // Reveal the lane the new session targets — an empty worktree/branch lane
    // starts collapsed, so without this the session lands in a folder the user
    // can't see. Stable across the lane's default flipping open once populated.
    setWorkspaceNodeOpen(group.id, true)

    if (isProfileGroup) {
      newSessionInProfile(group.id)

      return
    }

    if (!onNewSession) {
      return
    }

    // Main-checkout lanes are branch-labeled views over the same repo root path.
    // Clicking "+" on `main` should open on `main`, not whatever branch the root
    // currently sits on (`test0`, etc.), so explicitly switch first.
    if (group.isMain && group.path && group.label) {
      try {
        await switchBranchInRepo(group.path, group.label)
      } catch (err) {
        notifyError(err, t.statusStack.coding.switchFailed(group.label))

        return
      }
    }

    onNewSession(group.path)
  }

  const agentHeader = (
    <WorkspaceHeader
      action={
        (onNewSession || isProfileGroup || onRemove) && (
          <div className="flex items-center">
            {(onNewSession || isProfileGroup) && (
              <WorkspaceAddButton
                label={s.newSessionIn(group.label)}
                // Profile groups start a fresh session in that profile but keep
                // the all-profiles browse view; workspace groups seed the new
                // session's cwd. Main checkout lanes are branch-targeted.
                onClick={() => void handleNewSession()}
              />
            )}
            {isProfileGroup && <AgentProfileMenu group={group} />}
            {onRemove && <WorkspaceMenu onRemove={onRemove} path={group.path} />}
          </div>
        )
      }
      count={isProfileGroup ? countLabel(visibleSessions.length, totalCount) : group.sessions.length}
      icon={leadingIcon}
      label={group.label}
      onToggle={toggleOpen}
      open={open}
      title={group.profileName && group.profileName !== group.label ? group.profileName : (group.path ?? undefined)}
    />
  )

  return (
    <SidebarRowStack>
      {isProfileGroup ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>{agentHeader}</div>
          </ContextMenuTrigger>
          <ContextMenuContent aria-label={`Actions for ${group.label}`} className="w-44">
            <AgentProfileContextItems group={group} />
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        agentHeader
      )}
      {open && (
        <>
          {visibleSessions.length === 0 ? (
            <div className="min-h-7 pl-2 text-[0.75rem] leading-7 text-(--ui-text-quaternary)">{s.noSessions}</div>
          ) : (
            renderRows(visibleSessions)
          )}
          {hiddenCount > 0 &&
            (isProfileGroup ? (
              <SidebarLoadMoreRow
                loading={Boolean(group.loadingMore)}
                onClick={handleProfileLoadMore}
                step={nextCount}
              />
            ) : (
              <WorkspaceShowMoreButton
                count={nextCount}
                label={group.label}
                onClick={() => setVisibleCount(count => count + SIDEBAR_GROUP_PAGE)}
              />
            ))}
        </>
      )}
    </SidebarRowStack>
  )
}

function AgentProfileMenu({ group }: { group: SidebarSessionGroup }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Actions for ${group.label}`}
          className="grid size-4 shrink-0 place-items-center rounded-sm bg-transparent text-(--ui-text-quaternary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover/workspace:opacity-100 data-[state=open]:opacity-100"
          onClick={event => event.stopPropagation()}
          type="button"
        >
          <Codicon name="kebab-vertical" size="0.75rem" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" sideOffset={4}>
        <DropdownMenuItem onSelect={group.onTogglePinned}>
          <Codicon name={group.pinned ? 'pinned-dirty' : 'pin'} size="0.875rem" />
          <span>{group.pinned ? 'Unpin agent' : 'Pin agent'}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={group.onEditDisplayName}>
          <Codicon name="tag" size="0.875rem" />
          <span>Edit display name</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={group.onRenameProfile}>
          <Codicon name="text-size" size="0.875rem" />
          <span>Rename profile…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AgentProfileContextItems({ group }: { group: SidebarSessionGroup }) {
  return (
    <>
      <ContextMenuItem onSelect={group.onTogglePinned}>
        <Codicon name={group.pinned ? 'pinned-dirty' : 'pin'} size="0.875rem" />
        <span>{group.pinned ? 'Unpin agent' : 'Pin agent'}</span>
      </ContextMenuItem>
      <ContextMenuItem onSelect={group.onEditDisplayName}>
        <Codicon name="tag" size="0.875rem" />
        <span>Edit display name</span>
      </ContextMenuItem>
      <ContextMenuItem onSelect={group.onRenameProfile}>
        <Codicon name="text-size" size="0.875rem" />
        <span>Rename profile…</span>
      </ContextMenuItem>
    </>
  )
}
