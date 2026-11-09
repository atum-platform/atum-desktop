import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { openReviewFor, resetAgentEditReviews } from '@/store/agent-edits'
import { setSessions } from '@/store/session'
import { $activeWorkbenchTabId, $workbenchScope, assistantChatWorkbenchScopeKey } from '@/store/workbench-tabs'
import type { RpcEvent, SessionInfo } from '@/types/hermes'

import { useMessageStream } from './index'

let handleEvent: ((event: RpcEvent) => void) | null = null

function Harness() {
  const activeSessionIdRef = useRef<string | null>('runtime-a')
  const states = useRef(new Map<string, ClientSessionState>())
  const queryClient = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClient.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef: states,
    updateSessionState: (sessionId, updater) => {
      const next = updater(states.current.get(sessionId) ?? createClientSessionState())
      states.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

describe('agent edit gateway events', () => {
  beforeEach(async () => {
    handleEvent = null
    resetAgentEditReviews()
    $workbenchScope.set(assistantChatWorkbenchScopeKey('chat-a'))
    $activeWorkbenchTabId.set('tab-a')
    setSessions([{ id: 'runtime-b', _lineage_root_id: 'chat-b' } as SessionInfo])
    render(<Harness />)
    await waitFor(() => expect(handleEvent).not.toBeNull())
  })

  afterEach(() => {
    cleanup()
    setSessions([])
    vi.restoreAllMocks()
  })

  it('records and settles a background chat review without changing foreground navigation', () => {
    act(() =>
      handleEvent!({
        type: 'tool.complete',
        session_id: 'runtime-b',
        payload: {
          name: 'patch',
          edit: {
            session_id: 'runtime-b',
            turn_id: 'turn-b',
            tool_call_id: 'tool-b',
            tool: 'patch',
            working_dir: '/workspace',
            files: [{ path: '/workspace/docs/note.md', restore_path: 'docs/note.md', kind: 'modified' }],
            checkpoint: { hash: 'checkpoint-b', working_dir: '/workspace' },
            diff: 'agent diff',
            diff_truncated: false,
            restore_available: true
          }
        }
      })
    )

    expect(openReviewFor(assistantChatWorkbenchScopeKey('chat-b'), 'docs/note.md')?.diff).toBe('agent diff')
    expect($workbenchScope.get()).toBe(assistantChatWorkbenchScopeKey('chat-a'))
    expect($activeWorkbenchTabId.get()).toBe('tab-a')

    act(() =>
      handleEvent!({
        type: 'message.complete',
        session_id: 'runtime-b',
        payload: { text: 'done', turn_id: 'turn-b' }
      })
    )

    expect(openReviewFor(assistantChatWorkbenchScopeKey('chat-b'), 'docs/note.md')?.settled).toBe(true)
    expect($workbenchScope.get()).toBe(assistantChatWorkbenchScopeKey('chat-a'))
    expect($activeWorkbenchTabId.get()).toBe('tab-a')
  })
})
