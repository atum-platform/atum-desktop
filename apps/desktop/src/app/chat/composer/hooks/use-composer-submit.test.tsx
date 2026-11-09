import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $composerDraft, type ComposerAttachment } from '@/store/composer'
import { $queueRecovery } from '@/store/composer-queue'

import { QueueRecoveryPanel } from '../queue-recovery-panel'

import { useComposerSubmit } from './use-composer-submit'

interface SubmitHarnessOptions {
  attachments?: ComposerAttachment[]
  busy?: boolean
  compacting?: boolean
  text?: string
}

function renderSubmitHook({
  attachments = [],
  busy = false,
  compacting = false,
  text = ''
}: SubmitHarnessOptions = {}) {
  const draftRef = { current: text }
  const editor = document.createElement('div')
  editor.dataset.slot = 'composer-rich-input'
  editor.textContent = text
  const editorRef = { current: editor }
  const onCancel = vi.fn()
  const onSteer = vi.fn(async () => true)
  const onSubmit = vi.fn(async () => true)
  const queueCurrentDraft = vi.fn(() => true)
  const loadIntoComposer = vi.fn()
  const stashAt = vi.fn()
  const activeQueueSessionKeyRef = { current: 'stored-session' }

  const clearDraft = vi.fn(() => {
    draftRef.current = ''
    editorRef.current!.textContent = ''
  })

  const hook = renderHook(() =>
    useComposerSubmit({
      activeQueueSessionKey: 'stored-session',
      activeQueueSessionKeyRef,
      attachments,
      busy,
      compacting,
      clearDraft,
      disabled: false,
      draftRef,
      drainNextQueued: vi.fn(async () => false),
      editorRef,
      exitQueuedEdit: vi.fn(() => false),
      focusInput: vi.fn(),
      inputDisabled: false,
      loadIntoComposer,
      onCancel,
      onSteer,
      onSubmit,
      queueCurrentDraft,
      queueEdit: null,
      queuedPrompts: [],
      sessionId: 'runtime-session',
      setComposerText: vi.fn(),
      stashAt
    })
  )

  return { clearDraft, draftRef, hook, onCancel, onSteer, onSubmit, queueCurrentDraft, loadIntoComposer, stashAt, activeQueueSessionKeyRef }
}

describe('useComposerSubmit busy-turn routing', () => {
  afterEach(() => {
    cleanup()
    $actionPanelOwner.set(null)
    $queueRecovery.set([])
    vi.restoreAllMocks()
  })

  it.each(['rejected', 'throws'])('restores a %s correction when queue ownership is unavailable', async failure => {
    $actionPanelOwner.set(null)
    const { hook, onSteer, loadIntoComposer, stashAt } = renderSubmitHook({ busy: true, text: 'keep these words' })

    if (failure === 'throws') {onSteer.mockRejectedValueOnce(new Error('disconnected'))} else {onSteer.mockResolvedValueOnce(false)}
    act(() => hook.result.current.steerDraft())
    await waitFor(() => expect(loadIntoComposer).toHaveBeenCalledWith('keep these words', []))
    expect(stashAt).toHaveBeenCalledWith('stored-session', 'keep these words', [])
  })

  it('stashes a late rejected correction in its original chat without replacing the foreground draft', async () => {
    const { hook, onSteer, loadIntoComposer, stashAt, activeQueueSessionKeyRef } = renderSubmitHook({ busy: true, text: 'old chat correction' })
    let reject!: (accepted: boolean) => void
    onSteer.mockImplementationOnce(() => new Promise(resolve => {reject = resolve}))
    act(() => hook.result.current.steerDraft())
    await waitFor(() => expect(onSteer).toHaveBeenCalled())
    activeQueueSessionKeyRef.current = 'another-chat'
    await act(async () => reject(false))
    expect(loadIntoComposer).not.toHaveBeenCalled()
    expect(stashAt).toHaveBeenCalledWith('stored-session', 'old chat correction', [])
  })

  it('keeps a late correction under its original account when the owner changes', async () => {
    const owner = { accountId: 'first-account', connectionId: 'connection', backend_id: 'backend', agent_id: 'agent', profile: 'default', version: 1 as const, submission_dedup: true }
    $actionPanelOwner.set(owner)
    const { hook, onSteer, loadIntoComposer, stashAt } = renderSubmitHook({ busy: true, text: 'private correction' })
    let reject!: (accepted: boolean) => void
    onSteer.mockImplementationOnce(() => new Promise(resolve => {reject = resolve}))
    act(() => hook.result.current.steerDraft())
    await waitFor(() => expect(onSteer).toHaveBeenCalled())
    $actionPanelOwner.set({ ...owner, accountId: 'second-account' })
    await act(async () => reject(false))
    expect(loadIntoComposer).not.toHaveBeenCalled()
    expect(stashAt).not.toHaveBeenCalled()
    expect($queueRecovery.get()).toEqual([expect.objectContaining({ accountId: 'first-account', text: 'private correction' })])
  })

  it('shows and restores an ownerless late correction without replacing newer text or exposing unknown drafts', async () => {
    $actionPanelOwner.set(null)
    const { hook, onSteer, draftRef, loadIntoComposer, stashAt } = renderSubmitHook({ busy: true, text: 'recover these words' })
    let reject!: (accepted: boolean) => void
    onSteer.mockImplementationOnce(() => new Promise(resolve => {reject = resolve}))
    act(() => hook.result.current.steerDraft())
    await waitFor(() => expect(onSteer).toHaveBeenCalled())
    draftRef.current = 'newer draft'
    $composerDraft.set('newer draft')
    await act(async () => reject(false))
    expect(loadIntoComposer).not.toHaveBeenCalled()
    expect(stashAt).not.toHaveBeenCalled()
    $queueRecovery.set([...$queueRecovery.get(), { id: 'legacy', text: 'unknown legacy draft' }, { id: 'foreign', text: 'another owner draft', ownerKey: 'pending:someone-else' }])
    render(<I18nProvider configClient={null} initialLocale="en"><QueueRecoveryPanel /></I18nProvider>)
    expect(screen.getByText('recover these words')).toBeDefined()
    expect(screen.queryByText('unknown legacy draft')).toBeNull()
    expect(screen.queryByText('another owner draft')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore draft' }))
    expect($composerDraft.get()).toBe('newer draft\n\nrecover these words')
    expect(screen.queryByText('recover these words')).toBeNull()
  })

  it('steers a plain-text follow-up instead of queueing or stopping', async () => {
    const { hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({
      busy: true,
      text: 'change course'
    })

    act(() => {
      hook.result.current.submitDraft()
    })

    await waitFor(() => expect(onSteer).toHaveBeenCalledWith('change course'))
    expect(queueCurrentDraft).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('queues a plain-text follow-up while the active turn is compacting', () => {
    const { hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({
      busy: true,
      compacting: true,
      text: 'wait for the summary'
    })

    act(() => {
      hook.result.current.submitDraft()
    })

    expect(queueCurrentDraft).toHaveBeenCalledTimes(1)
    expect(onSteer).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('runs slash commands immediately while busy', async () => {
    const { clearDraft, hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({
      busy: true,
      text: '/compress preserve context'
    })

    act(() => {
      hook.result.current.submitDraft()
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('/compress preserve context'))
    expect(clearDraft).toHaveBeenCalledTimes(1)
    expect(onSteer).not.toHaveBeenCalled()
    expect(queueCurrentDraft).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('queues an attachment-bearing follow-up while busy', () => {
    const attachment: ComposerAttachment = { id: 'doc', kind: 'file', label: 'notes.txt' }

    const { hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({
      attachments: [attachment],
      busy: true,
      text: 'read this'
    })

    act(() => {
      hook.result.current.submitDraft()
    })

    expect(queueCurrentDraft).toHaveBeenCalledTimes(1)
    expect(onSteer).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('stops an active turn only with an empty composer', () => {
    const { hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({ busy: true })

    act(() => {
      hook.result.current.submitDraft()
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSteer).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(queueCurrentDraft).not.toHaveBeenCalled()
  })

  it('submits a normal turn while idle', async () => {
    const { hook, onCancel, onSteer, onSubmit, queueCurrentDraft } = renderSubmitHook({ text: 'ordinary question' })

    act(() => {
      hook.result.current.submitDraft()
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('ordinary question', { attachments: [] }))
    expect(onSteer).not.toHaveBeenCalled()
    expect(queueCurrentDraft).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
