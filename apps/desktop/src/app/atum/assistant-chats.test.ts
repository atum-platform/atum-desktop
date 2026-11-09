import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { projectAssistantChats, resolveAssistantChatId } from './assistant-chats'

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'sess-1',
  ended_at: null,
  input_tokens: 0,
  is_active: false,
  last_active: 1_756_800_000,
  message_count: 2,
  model: null,
  output_tokens: 0,
  preview: 'Lập kế hoạch cho tuần tới',
  source: 'desktop',
  started_at: 1_756_799_000,
  title: 'Kế hoạch tuần',
  tool_call_count: 0,
  ...overrides
})

describe('projectAssistantChats', () => {
  it('projects one row per session, newest first, keyed by the durable lineage root', () => {
    const rows = projectAssistantChats(
      [
        session(),
        session({
          id: 'tip-2',
          _lineage_root_id: 'root-2',
          last_active: 1_756_900_000,
          title: null,
          preview: 'Viết email'
        })
      ],
      []
    )

    expect(rows.map(row => row.id)).toEqual(['root-2', 'sess-1'])
    expect(rows[0]).toEqual({
      id: 'root-2',
      agentId: 'default',
      sessionIds: ['tip-2', 'root-2'],
      title: '',
      preview: 'Viết email',
      activityAt: '2025-09-03T11:46:40.000Z',
      unread: false,
      route: '/root-2'
    })
    expect(rows[1]!.sessionIds).toEqual(['sess-1'])
  })

  it('marks unread by either the live id or the lineage root and drops archived rows', () => {
    const rows = projectAssistantChats(
      [session({ id: 'tip-2', _lineage_root_id: 'root-2' }), session({ id: 'gone', archived: true })],
      ['tip-2']
    )

    expect(rows.map(row => [row.id, row.unread])).toEqual([['root-2', true]])
  })

  it('keeps private advisory session transcripts out of ordinary assistant chat history', () => {
    const rows = projectAssistantChats([session(), session({ id: 'meeting', source: 'atum-private-advisory' })], [])
    expect(rows.map(row => row.id)).toEqual(['sess-1'])
  })

  it('falls back to started_at, then the epoch, when a row has no last activity', () => {
    const rows = projectAssistantChats(
      [session({ last_active: 0, started_at: 1_000 }), session({ id: 'x', last_active: 0, started_at: 0 })],
      []
    )

    expect(rows.map(row => row.activityAt)).toEqual(['1970-01-01T00:16:40.000Z', '1970-01-01T00:00:00.000Z'])
  })
})

describe('resolveAssistantChatId', () => {
  const chats = [
    { id: 'root-1', sessionIds: ['tip-9', 'root-1'] },
    { id: 'sess-2', sessionIds: ['sess-2'] }
  ]

  it('resolves a live tip or a root to the durable root, and passes an unknown id through', () => {
    expect(resolveAssistantChatId('tip-9', chats)).toBe('root-1')
    expect(resolveAssistantChatId('root-1', chats)).toBe('root-1')
    expect(resolveAssistantChatId('sess-2', chats)).toBe('sess-2')
    expect(resolveAssistantChatId('brand-new', chats)).toBe('brand-new')
    expect(resolveAssistantChatId(null, chats)).toBeNull()
  })
})

describe('organisation containment', () => {
  // Chats are product; the Hermes organisation around them is not. This module
  // may read the session store and nothing else that would put profiles,
  // projects, worktrees, pins, or cron back in front of the user.
  const source = readFileSync(resolve(__dirname, 'assistant-chats.ts'), 'utf8')

  it.each(['store/profile', 'store/projects', 'store/cron', 'store/layout', 'sidebar'])(
    'does not import %s',
    module => {
      expect(source).not.toContain(module)
    }
  )

  it.each([
    '$profiles',
    '$projects',
    '$cronSessions',
    '$messagingSessions',
    'worktree',
    'pinned',
    'git_branch',
    'git_repo_root'
  ])('never reaches for the Hermes noun %s', noun => {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')

    expect(code).not.toContain(noun)
  })
})
