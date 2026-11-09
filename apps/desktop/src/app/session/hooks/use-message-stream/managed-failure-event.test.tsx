import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $composerDraft, setComposerDraft } from '@/store/composer'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const onboarding = vi.fn()
vi.mock('@/store/onboarding', () => ({
  requestDesktopOnboarding: (...args: unknown[]) => onboarding(...args),
  requestDesktopOnboardingForCredentialWarning: vi.fn()
}))

const SID = 'managed-session'

const envelope = {
  version: 1,
  code: 'authentication_expired',
  access_alias: 'binh-minh',
  phase: 'pre_dispatch',
  recovery: 'reauthenticate',
  transient: true,
  preserve_draft: true
}

let handleEvent: ((event: RpcEvent) => void) | null = null
let state: ClientSessionState

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  if (!sessionStateByRuntimeIdRef.current.has(SID)) {
    sessionStateByRuntimeIdRef.current.set(SID, state)
  }

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      state = updater(sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState())
      sessionStateByRuntimeIdRef.current.set(sessionId, state)

      return state
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

describe('managed failure events', () => {
  beforeEach(async () => {
    handleEvent = null
    onboarding.mockReset()
    setComposerDraft('')
    state = {
      ...createClientSessionState(),
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'What should I do?' }] }]
    }
    render(<Harness />)
    await waitFor(() => expect(handleEvent).not.toBeNull())
  })

  afterEach(() => {
    cleanup()
    setComposerDraft('')
  })

  it('settles one typed assistant outcome, restores the draft, and suppresses legacy onboarding', () => {
    act(() =>
      handleEvent!({
        type: 'error',
        session_id: SID,
        payload: { message: 'provider setup failed token=secret', managed_failure: envelope }
      })
    )
    const assistants = state.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.managedFailure?.code).toBe('authentication_expired')
    expect(assistants[0]?.error).not.toContain('secret')
    expect($composerDraft.get()).toBe('What should I do?')
    expect(state.messages.some(message => message.id === 'user-1')).toBe(false)
    expect(onboarding).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer draft', () => {
    setComposerDraft('new thought')
    act(() =>
      handleEvent!({
        type: 'message.complete',
        session_id: SID,
        payload: { text: 'Error', status: 'error', managed_failure: envelope }
      })
    )
    expect($composerDraft.get()).toBe('new thought')
    expect(state.messages.some(message => message.id === 'user-1')).toBe(true)
    expect(state.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  })

  it('does not restore a post-dispatch failure', () => {
    act(() =>
      handleEvent!({
        type: 'message.complete',
        session_id: SID,
        payload: {
          text: 'Error',
          status: 'error',
          managed_failure: {
            ...envelope,
            code: 'provider_rate_limited',
            phase: 'post_dispatch',
            preserve_draft: false
          }
        }
      })
    )

    expect($composerDraft.get()).toBe('')
    expect(state.messages.at(-1)?.managedFailure?.phase).toBe('post_dispatch')
  })
})
