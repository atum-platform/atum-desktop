import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'

import type { SidebarSessionGroup } from './projects'
import { SidebarSessionsSection } from './sessions-section'

vi.mock('./projects', () => ({
  EnteredProjectContent: () => null,
  ProjectOverviewRow: () => null,
  SidebarWorkspaceGroup: ({
    group,
    renderRows
  }: {
    group: SidebarSessionGroup
    renderRows: (sessions: SessionInfo[]) => React.ReactNode
  }) => (
    <div data-testid={`group-${group.id}`}>
      {group.label}
      {renderRows(group.sessions)}
    </div>
  )
}))

vi.mock('./session-row', () => ({
  SidebarSessionRow: ({ isPinned, session }: { isPinned: boolean; session: SessionInfo }) => (
    <div data-pinned={String(isPinned)} data-testid={`session-${session.id}`} />
  )
}))

vi.mock('./reorderable-list', () => ({
  ReorderableList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortableBindings: () => ({})
}))

function session(id: string): SessionInfo {
  return { id, last_active: 0, profile: 'atum-main', started_at: 0 } as SessionInfo
}

describe('SidebarSessionsSection grouped content', () => {
  it('renders pinned agent groups alongside individually pinned chats without pinning every child chat', () => {
    const group: SidebarSessionGroup = {
      id: 'atum-main',
      label: 'Atum Main',
      mode: 'profile',
      path: null,
      pinned: true,
      sessions: [session('agent-chat')]
    }

    render(
      <SidebarSessionsSection
        activeSessionId={null}
        emptyState={null}
        groups={[group]}
        label="Pinned"
        onArchiveSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onResumeSession={vi.fn()}
        onToggle={vi.fn()}
        onTogglePin={vi.fn()}
        open
        pinned
        sessions={[session('pinned-chat')]}
        workingSessionIdSet={new Set()}
      />
    )

    expect(screen.getByTestId('group-atum-main')).toBeTruthy()
    expect(screen.getByTestId('session-agent-chat').dataset.pinned).toBe('false')
    expect(screen.getByTestId('session-pinned-chat').dataset.pinned).toBe('true')
  })
})
