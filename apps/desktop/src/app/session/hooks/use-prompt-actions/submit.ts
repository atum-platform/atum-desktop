import { type MutableRefObject, useCallback } from 'react'

import { captureAtumAssistantDirectoryScope, isAtumAssistantDirectoryScopeCurrent } from '@/app/atum/assistant-directory'
import { bindAtumHiredTask } from '@/app/atum/hired-task'
import { $workspaceProtected } from '@/app/atum/utilities/store'
import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import { translateNow, type Translations } from '@/i18n'
import { managedModelAccessAliasForSelection } from '@/lib/atum-managed-model-access'
import { type ManagedModelFailure, managedModelFailureCopy } from '@/lib/atum-managed-model-failure'
import { type ChatMessage, textPart } from '@/lib/chat-messages'
import { optimisticAttachmentRef } from '@/lib/chat-runtime'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { setMutableRef } from '@/lib/mutable-ref'
import { surfaceReceiptText } from '@/lib/surface-receipt'
import {
  isVoicePlaybackActive,
  markVoicePlaybackInterrupted,
  stopVoicePlayback,
  takeVoicePlaybackInterrupted
} from '@/lib/voice-playback'
import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey, validPanelCapabilities } from '@/store/action-panel-owner'
import { bindAtumTraining, completeAtumTrainingSubmit, trainingIntentForSubmit } from '@/store/atum-training'
import {
  $composerAttachments,
  $composerDraft,
  clearComposerAttachments,
  type ComposerAttachment,
  setComposerDraft,
  terminalContextBlocksFromDraft
} from '@/store/composer'
import { markQueuedSubmissionUncertain } from '@/store/composer-queue'
import { clearNotifications, notify, notifyError } from '@/store/notifications'
import { requestDesktopOnboarding } from '@/store/onboarding'
import { $freshSessionRequest } from '@/store/profile'
import {
  $currentModel,
  $currentProvider,
  setAwaitingResponse,
  setBusy,
  setMessages
} from '@/store/session'
import { captureIntentForScope, freezeSurfaceCapture, type SurfacePayload } from '@/store/surface-capture'
import { discardPendingWordTurn, recordPendingWordTurn } from '@/store/word-turn-ledger'
import { $workbenchScope, assistantChatWorkbenchScopeKey, resolveCaptureScope } from '@/store/workbench-tabs'

import type { ClientSessionState } from '../../../types'
import { sessionContextDrift } from '../session-context-drift'
import { resolveSessionProfile } from '../use-session-actions/utils'

import {
  _submitInFlight,
  type GatewayRequest,
  inlineErrorMessage,
  isGatewayTimeoutError,
  isProviderSetupError,
  isSessionBusyError,
  isSessionNotFoundError,
  type SubmitTextOptions,
  withSessionBusyRetry
} from './utils'

interface SubmitPromptDeps {
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  copy: Translations['desktop']
  createBackendSessionForSend: (preview?: string | null) => Promise<string | null>
  getRoutedStoredSessionId: () => null | string
  getRuntimeIdForStoredSession: (storedSessionId: string) => null | string
  getRouteToken: () => string
  requestGateway: GatewayRequest
  resumeStoredSession: (storedSessionId: string) => Promise<void> | void
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  syncAttachmentsForSubmit: (
    sessionId: string,
    attachments: ComposerAttachment[],
    options?: { updateComposerAttachments?: boolean }
  ) => Promise<ComposerAttachment[]>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
  /** Composer-scope seams: the main chat runs on the module-level globals
   *  (defaults); a session tile injects its own so a tile submit never writes
   *  the primary view's $busy/$messages or clears the main attachment chips. */
  scope?: {
    clearAttachments: () => void
    readAttachments: () => ComposerAttachment[]
    setAwaitingResponse: (awaiting: boolean) => void
    setBusy: (busy: boolean) => void
    setMessages: (updater: (current: ChatMessage[]) => ChatMessage[]) => void
  }
}

// Stable identity — a fresh default object per render would churn the
// useCallback below on every render.
const MAIN_SUBMIT_SCOPE: NonNullable<SubmitPromptDeps['scope']> = {
  clearAttachments: clearComposerAttachments,
  readAttachments: () => $composerAttachments.get(),
  setAwaitingResponse,
  setBusy,
  setMessages
}

/** The prompt submit pipeline, extracted from usePromptActions. */
export function useSubmitPrompt(deps: SubmitPromptDeps) {
  const {
    activeSessionIdRef,
    busyRef,
    copy,
    createBackendSessionForSend,
    getRoutedStoredSessionId,
    getRuntimeIdForStoredSession,
    getRouteToken,
    requestGateway,
    resumeStoredSession,
    selectedStoredSessionIdRef,
    syncAttachmentsForSubmit,
    updateSessionState,
    scope = MAIN_SUBMIT_SCOPE
  } = deps

  return useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = sanitizeComposerInput(rawText).trim()
      const usingComposerAttachments = !options?.attachments
      // Pin the selection with the submit, just like the session routing below.
      // A model-menu change while the async create/resume path runs must not
      // reclassify an external-provider failure as a managed one (or vice versa).
      const managedAlias = managedModelAccessAliasForSelection($currentProvider.get(), $currentModel.get(), $workspaceProtected.get())

      const sourceScopeKey = options?.storedSessionId
        ? assistantChatWorkbenchScopeKey(options.storedSessionId)
        : $workbenchScope.get()

      const pinnedCaptureIntent = options?.explicitNoContext
        ? { mode: 'removed' as const, revision: 'explicit-no-context' }
        : options?.fromQueue && !options.captureIntent
        ? { mode: 'removed' as const, revision: 'legacy-queue-no-authority' }
        : options?.captureIntent ?? captureIntentForScope(sourceScopeKey)

      const accountScope = captureAtumAssistantDirectoryScope()
      const freshSessionRequest = $freshSessionRequest.get()
      const pinnedEpoch = $actionPanelEpoch.get()
      let hasSurfaceCapture = Boolean(options?.frozenContext)
      const pinnedOwnerKey = panelOwnerKey()

      if (options?.contextUnavailable) {return false}

      // Start capture immediately, but pin all routing synchronously below
      // before awaiting native file IO or session creation.
      const capturePromise = (options?.explicitNoContext
        ? Promise.resolve(null)
        : options && 'frozenContext' in options
        ? Promise.resolve(options.frozenContext ?? null)
        : freezeSurfaceCapture(sourceScopeKey)).then(value => {
        hasSurfaceCapture = Boolean(value)

        return { value, error: undefined }
      }, error => ({ value: null, error }))

      const submissionId = options?.submissionId ?? crypto.randomUUID()
      let documentBlocks: string[] = []

      // Drop undefined/null holes a session switch or draft restore can leave in
      // the attachments array (same bug class as AttachmentList #49624). Without
      // this, the sibling iterations below (a.kind / a.label / a.refText, and the
      // sync step) throw "Cannot read properties of undefined (reading 'refText')"
      // and break the chat surface.
      const manualAttachments = (options?.attachments ?? scope.readAttachments()).filter((a): a is ComposerAttachment =>
        Boolean(a)
      )

      const attachments = manualAttachments

      const terminalContextBlocks = terminalContextBlocksFromDraft(rawText).join('\n\n')
      const hasImage = attachments.some(a => a.kind === 'image')

      // Refs are recomputed after sync (file.attach rewrites @file: refs to
      // workspace-relative paths the remote gateway can resolve). Seed the
      // optimistic message with the pre-sync refs, then rewrite once synced.
      // Images use their base64 preview so the thumbnail renders inline without
      // a (remote-mode 403-prone) /api/media fetch — see optimisticAttachmentRef.
      let attachmentRefs = [...new Set(attachments.map(optimisticAttachmentRef).filter((r): r is string => Boolean(r)))]

      const buildContextText = (atts: ComposerAttachment[]): string => {
        // atts may be the post-sync array, which can reintroduce holes; filter
        // before touching a.refText / a.kind.
        const present = atts.filter((a): a is ComposerAttachment => Boolean(a))

        const contextRefs = [...new Set(present.map(a => a.refText).filter((ref): ref is string => Boolean(ref)))].join(
          '\n'
        )

        return (
          [contextRefs, terminalContextBlocks, visibleText].filter(Boolean).join('\n\n') ||
          (present.some(a => a.kind === 'image') ? 'What do you see in this image?' : '')
        )
      }

      // Queue drains fire on the busy→false settle edge, where busyRef (synced
      // from $busy by a separate effect) may still read true — honoring it would
      // bounce the drained send. The drain lock serializes them; the user path
      // keeps the guard so a stray Enter mid-turn can't double-submit.
      const hasSendable = Boolean(
        visibleText || terminalContextBlocks || attachments.length || hasImage
      )

      if (!hasSendable || (!options?.fromQueue && busyRef.current)) {
        return false
      }

      // Typing barge-in: a new send silences any in-flight spoken reply.
      if (isVoicePlaybackActive()) {
        markVoicePlaybackInterrupted()
        stopVoicePlayback()
      }

      // Barged mid-speech (here or via the voice loop's VAD)? Flag the submit
      // so the backend notes the interruption to the model.
      const interrupted = takeVoicePlaybackInterrupted()

      // Queue drains carry their source session explicitly. A background drain
      // must never inherit the currently selected session after the user moves
      // to another chat.
      const targetStoredSessionId = options?.storedSessionId ?? selectedStoredSessionIdRef.current
      const trainingIntent = trainingIntentForSubmit(targetStoredSessionId)

      const targetStartedInCurrentView =
        !targetStoredSessionId || targetStoredSessionId === selectedStoredSessionIdRef.current

      let sessionId: null | string = options?.sessionId ?? activeSessionIdRef.current
      const startedWithoutSession = !sessionId

      // Pin the foreground session context for the whole async submit pipeline.
      // Without this, a fast session switch during session.resume / file.attach
      // can redirect the user's text into a different chat (#54527). Mutable —
      // not const — because a new-chat submit legitimately re-homes to the
      // session it creates (see the re-pin after createBackendSessionForSend).
      const startingActiveSessionId = activeSessionIdRef.current
      const selectedStoredSessionId = selectedStoredSessionIdRef.current
      const routedStoredSessionId = getRoutedStoredSessionId()

      const routedRuntimeId = routedStoredSessionId ? getRuntimeIdForStoredSession(routedStoredSessionId) : null

      const routedSessionNeedsResume = Boolean(
        routedStoredSessionId &&
        (selectedStoredSessionId !== routedStoredSessionId ||
          !startingActiveSessionId ||
          startingActiveSessionId !== routedRuntimeId)
      )

      let startingStoredSessionId = routedSessionNeedsResume
        ? routedStoredSessionId
        : (selectedStoredSessionId ?? routedStoredSessionId)

      let startingRouteToken = getRouteToken()

      // Reason string (or null) for why the session context genuinely drifted
      // under this in-flight submit. sessionContextDrift ignores the churn a
      // busy gateway produces (selection null-resets on a gateway/profile
      // switch, search/hash-only route changes, background active-ref
      // retargets) so a second-session send doesn't silently abort — it fires
      // only on a real move to a DIFFERENT chat. Reads the live refs/route each
      // call and measures against the (mutable) baseline, which is re-pinned to
      // the created chat after createBackendSessionForSend. submitTargetStoredId
      // is the stored session this submit targets, so a move ONTO it (the
      // pipeline's own re-home) is never counted as drift.
      const sessionDriftReason = (): string | null =>
        !isAtumAssistantDirectoryScopeCurrent(accountScope) ? 'account changed'
          : startedWithoutSession && targetStartedInCurrentView && freshSessionRequest !== $freshSessionRequest.get() ? 'new employee task requested'
          // An empty workspace carries no captured authority. Its capabilities
          // may settle while the intended employee wakes for this first send.
          // Real captures still require their original owner and epoch.
          : hasSurfaceCapture && (pinnedEpoch !== $actionPanelEpoch.get() || pinnedOwnerKey !== panelOwnerKey())
            ? 'action-panel owner changed' : targetStartedInCurrentView
          ? sessionContextDrift({
              startRouteToken: startingRouteToken,
              nowRouteToken: getRouteToken(),
              startSelectedStoredId: startingStoredSessionId,
              nowSelectedStoredId: selectedStoredSessionIdRef.current,
              submitTargetStoredId: startingStoredSessionId
            })
          : null

      const targetIsCurrentView = (): boolean => targetStartedInCurrentView && !sessionDriftReason()

      // One submit in flight per session — drop any concurrent re-fire so a
      // stalled turn can't stack the same prompt into multiple real turns. The
      // foreground ChatBar and background drainers can briefly overlap during a
      // session switch; this per-session lock makes that safe.
      const submitLockKey = targetStoredSessionId || sessionId || startingActiveSessionId || '__pending_new__'

      if (_submitInFlight.has(submitLockKey)) {
        return false
      }

      _submitInFlight.add(submitLockKey)
      let submitLockReleased = false

      const releaseSubmitLock = () => {
        if (!submitLockReleased) {
          submitLockReleased = true
          _submitInFlight.delete(submitLockKey)
        }
      }

      const optimisticId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const buildUserMessage = (): ChatMessage => ({
        id: optimisticId,
        role: 'user',
        parts: [textPart(visibleText || (attachmentRefs.length ? '' : attachments.map(a => a.label).join(', ')))],
        attachmentRefs,
        documentContextBlocks: documentBlocks
      })

      const releaseBusy = () => {
        releaseSubmitLock()

        if (targetIsCurrentView()) {
          setMutableRef(busyRef, false)
          scope.setBusy(false)
          scope.setAwaitingResponse(false)
        }
      }

      // Idempotent optimistic insert — re-running with the resolved sessionId
      // after createBackendSessionForSend just overwrites with the same id.
      const seedOptimistic = (sid: string) =>
        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.some(m => m.id === optimisticId)
              ? state.messages
              : [...state.messages, buildUserMessage()],
            busy: true,
            awaitingResponse: true,
            pendingBranchGroup: null,
            sawAssistantPayload: false,
            // Fresh submit = new turn — clear any leftover interrupt flag, else
            // mutateStream/completeAssistantMessage drop every delta of this turn
            // (what made drained-after-interrupt sends go silent).
            interrupted: false
          }),
          targetStoredSessionId
        )

      // After sync rewrites refs, refresh the optimistic message in place so the
      // transcript shows the resolved @file: ref rather than the local path.
      const rewriteOptimistic = (sid: string) =>
        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.map(message => (message.id === optimisticId ? buildUserMessage() : message))
          }),
          targetStoredSessionId
        )

      const dropOptimistic = (sid: null | string) => {
        if (!sid) {
          if (targetIsCurrentView()) {
            scope.setMessages(current => current.filter(m => m.id !== optimisticId))
          }

          return
        }

        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.filter(m => m.id !== optimisticId),
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null
          }),
          targetStoredSessionId
        )
      }

      const abortForSessionSwitch = (optimisticSessionId: null | string): false => {
        dropOptimistic(optimisticSessionId)
        releaseBusy()

        return false
      }

      // Foreground-only state: a background queue drain must never write the
      // selected view's busy/awaiting flags or clear its notifications.
      if (targetIsCurrentView()) {
        setMutableRef(busyRef, true)
        scope.setBusy(true)
        scope.setAwaitingResponse(true)
        clearNotifications()
      }

      // A route whose selected/runtime binding is incomplete or cross-wired
      // outranks a stale render-time runtime id (often from the previous
      // profile): force the full routed resume path below. An explicit queued
      // runtime id (background drain) is authoritative and is left untouched.
      if (!options?.sessionId && routedSessionNeedsResume) {
        sessionId = null
      }

      if (sessionId) {
        seedOptimistic(sessionId)
      } else if (targetIsCurrentView()) {
        scope.setMessages(current => [...current, buildUserMessage()])
      }

      if (!sessionId && routedStoredSessionId && routedSessionNeedsResume) {
        // The URL still names a durable conversation, but a profile
        // swap/reconnect left its volatile session binding incomplete or
        // cross-wired. Run the full profile-aware resume path. Creating here
        // would fork a contextless chat against whichever profile is active.
        try {
          await resumeStoredSession(routedStoredSessionId)
        } catch {
          return abortForSessionSwitch(null)
        }

        const routedResumeDrift = sessionDriftReason()

        if (routedResumeDrift) {
          console.warn('[submit-drift-abort]', routedResumeDrift, { phase: 'post-routed-resume' })

          return abortForSessionSwitch(null)
        }

        const recoveredRuntimeId = activeSessionIdRef.current
        const validatedRuntimeId = getRuntimeIdForStoredSession(routedStoredSessionId)

        // Recovery only succeeded when both sides of the cache agree that the
        // live runtime belongs to the durable routed session. A failed profile
        // swap may leave the previous profile's runtime active, while a recycled
        // runtime id may leave a cross-wired stored-session mapping.
        if (
          !recoveredRuntimeId ||
          recoveredRuntimeId !== validatedRuntimeId ||
          selectedStoredSessionIdRef.current !== routedStoredSessionId
        ) {
          return abortForSessionSwitch(null)
        }

        sessionId = recoveredRuntimeId
        seedOptimistic(sessionId)
      }

      if (!sessionId && targetStoredSessionId) {
        // A target stored session exists but its runtime binding is gone (the
        // live session was orphan-reaped, a timeout/reconnect cleared it, or a
        // background queue drain only has the durable id). Continue that target
        // conversation; only a genuine new-chat draft may create a new session.
        try {
          // Re-register on the session's OWNING profile — resuming on whichever
          // profile is live would fork the conversation into the wrong DB (#67603).
          const resumeProfile = await resolveSessionProfile(targetStoredSessionId)

          const resumed = await requestGateway<{ session_id: string }>('session.resume', {
            session_id: targetStoredSessionId,
            source: 'desktop',
            ...(resumeProfile ? { profile: resumeProfile } : {})
          })

          const resumeDrift = sessionDriftReason()

          if (resumeDrift) {
            console.warn('[submit-drift-abort]', resumeDrift, { phase: 'post-resume' })

            return abortForSessionSwitch(sessionId)
          }

          if (resumed?.session_id) {
            sessionId = resumed.session_id

            if (targetIsCurrentView()) {
              activeSessionIdRef.current = sessionId
            }
          }
        } catch {
          // A target stored conversation is not a new-chat draft. If its
          // runtime cannot be rebound, stop here rather than silently replacing
          // it with a contextless session (#55578). For a background/queued
          // drain this abort is a no-op on foreground state (both helpers are
          // targetIsCurrentView-guarded) and simply drops the queued send.
          return abortForSessionSwitch(null)
        }

        const resumeSettleDrift = sessionDriftReason()

        if (resumeSettleDrift) {
          console.warn('[submit-drift-abort]', resumeSettleDrift, { phase: 'post-resume-settle' })

          return abortForSessionSwitch(sessionId)
        }

        if (!sessionId) {
          return abortForSessionSwitch(null)
        }

        seedOptimistic(sessionId)
      }

      if (!sessionId) {
        try {
          sessionId = await createBackendSessionForSend(visibleText)
        } catch (err) {
          dropOptimistic(null)
          releaseBusy()

          if (targetIsCurrentView()) {
            notifyError(err, copy.sessionUnavailable)
          }

          return false
        }

        if (!sessionId) {
          // createBackendSessionForSend returns null when the user switched
          // sessions mid-create (it closes the orphaned session itself) —
          // abort silently. Anything else is a real failure worth a toast.
          const createNullDrift = sessionDriftReason()

          if (createNullDrift) {
            console.warn('[submit-drift-abort]', createNullDrift, { phase: 'post-create-null' })

            return abortForSessionSwitch(null)
          }

          dropOptimistic(null)
          releaseBusy()

          if (targetIsCurrentView()) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })
          }

          return false
        }

        // A successful create re-homes selection + route to the chat it just
        // minted, so the pre-create baseline can't tell our own re-home from
        // a user switch (judging it drift aborted EVERY first send of a new
        // chat: no prompt.submit, no DB row, a stranded route that 404s
        // "Session not found"). The drift signal for this window is the
        // active ref instead: every switch path re-nulls or retargets it
        // synchronously, so it only still equals the id create returned when
        // nobody re-homed since.
        if (activeSessionIdRef.current !== sessionId) {
          return abortForSessionSwitch(sessionId)
        }

        // Re-pin the baseline to the created chat for the rest of the
        // pipeline; the closures (seedOptimistic et al) see the new value.
        startingStoredSessionId = selectedStoredSessionIdRef.current
        startingRouteToken = getRouteToken()

        seedOptimistic(sessionId)
      }

      try {
        const captured = await capturePromise

        if (captured.error) {throw captured.error}
        const frozenContext = captured.value

        if (sessionDriftReason() || (frozenContext && frozenContext.ownerKey !== pinnedOwnerKey)) {return abortForSessionSwitch(sessionId)}

        if (frozenContext && options?.fromQueue && resolveCaptureScope(frozenContext.scopeKey) !== sourceScopeKey) {
          throw new Error(translateNow('composer.contextOwnerChanged'))
        }

        documentBlocks = frozenContext ? [surfaceReceiptText(frozenContext.payload)] : []

        const syncedAttachments = await syncAttachmentsForSubmit(sessionId, attachments, {
          updateComposerAttachments: usingComposerAttachments
        })

        const attachmentsDrift = sessionDriftReason()

        if (attachmentsDrift) {
          console.warn('[submit-drift-abort]', attachmentsDrift, { phase: 'post-attachments' })

          return abortForSessionSwitch(sessionId)
        }

        // Rewrite the optimistic message + prompt text with the synced refs so
        // the gateway receives @file: paths that resolve in its workspace.
        // (Images keep their inline base64 preview — see optimisticAttachmentRef.)
        attachmentRefs = [
          ...new Set(syncedAttachments.map(optimisticAttachmentRef).filter((r): r is string => Boolean(r)))
        ]
        rewriteOptimistic(sessionId)
        const text = buildContextText(syncedAttachments)

        let payload: SurfacePayload | undefined
        let supportsReceipts = false

        try {
          const capabilities = frozenContext || $actionPanelOwner.get()?.submission_dedup ? await requestGateway<unknown>('context.capabilities', { session_id: sessionId }) : null

          if (validPanelCapabilities(capabilities)) {
            supportsReceipts = true
            const conversationId = (capabilities as { conversation_id?: string }).conversation_id

            if (frozenContext) {
              if (capabilities.agent_id !== frozenContext.payload.agent_id || capabilities.backend_id !== frozenContext.payload.backend_id || !conversationId) {
                throw new Error(translateNow('composer.contextOwnerChanged'))
              }

              payload = { ...frozenContext.payload, conversation_id: conversationId }
            }
          }
        } catch (error) {if (frozenContext) {throw error}}

        if (frozenContext && !payload) {throw new Error(translateNow('composer.contextUnavailable'))}

        if (sessionDriftReason()) {return abortForSessionSwitch(sessionId)}

        if (trainingIntent) {
          await bindAtumTraining(trainingIntent, sessionId, requestGateway)

          if (sessionDriftReason()) { return abortForSessionSwitch(sessionId) }
        } else {
          await bindAtumHiredTask(sessionId, requestGateway)

          if (sessionDriftReason()) { return abortForSessionSwitch(sessionId) }
        }

        const submitParams = (targetId: string) => ({
          session_id: targetId, text,
          ...(supportsReceipts ? { submission_id: submissionId, submission_attachments: attachments.map(item => item.id) } : {}),
          ...(payload ? { surface_context: payload } : {}),
          ...(interrupted && { interrupted })
        })

        const uncertainDelivery = () => {
          markQueuedSubmissionUncertain(submissionId)

          return new Error(translateNow('composer.contextUncertain'))
        }

        const deliver = async (targetId: string) => {
          // message.start supplies the opaque turn id later. Pin this submit's
          // capture intent now so a subsequent A→B link change cannot lend B
          // to A's already-dispatched request.
          const profile = $actionPanelOwner.get()?.profile
          const noDocument = Boolean(options?.explicitNoContext)

          if (profile) {recordPendingWordTurn(profile, targetId, submissionId, noDocument ? undefined : (frozenContext?.intent ?? pinnedCaptureIntent))}
          const result = await requestGateway<{ receipt?: { status: string } }>('prompt.submit', submitParams(targetId), PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)

          if (result?.receipt && !['accepted', 'complete'].includes(result.receipt.status)) {throw uncertainDelivery()}

          if (result?.receipt?.status === 'complete') {releaseBusy()}
        }

        // On sleep/wake the gateway's in-memory session may have been cleared
        // while the desktop app still holds the old session ID. Detect this,
        // resume the stored session to re-register it, and retry once.
        let submitErr: unknown = null

        try {
          await withSessionBusyRetry(() =>
            deliver(sessionId)
          )
        } catch (firstErr) {
          const recoverStoredSessionId = targetStoredSessionId ?? selectedStoredSessionIdRef.current

          if ((supportsReceipts || frozenContext) && (isGatewayTimeoutError(firstErr) || (firstErr as { code?: number })?.code === 5040)) {
            let status = 'unknown'

            if (supportsReceipts) {
              try {
                const receipt = await requestGateway<{ status: string }>('prompt.submission_status', { session_id: sessionId, submission_id: submissionId })
                status = receipt.status
              } catch { /* missing runtime after timeout is still ambiguous */ }
            }

            if (!['accepted', 'complete'].includes(status)) {throw uncertainDelivery()}

            if (status === 'complete') {
              releaseBusy()

              if (targetIsCurrentView() && targetStoredSessionId) {await resumeStoredSession(targetStoredSessionId)}
            }
          } else if ((isSessionNotFoundError(firstErr) || (!frozenContext && !supportsReceipts && isGatewayTimeoutError(firstErr))) && recoverStoredSessionId) {
            // Re-register the session in the gateway and get a fresh live ID.
            const resumeProfile = await resolveSessionProfile(recoverStoredSessionId)

            const resumed = await requestGateway<{ session_id: string }>('session.resume', {
              session_id: recoverStoredSessionId,
              source: 'desktop',
              ...(resumeProfile ? { profile: resumeProfile } : {})
            })

            const resumeRetryDrift = sessionDriftReason()

            if (resumeRetryDrift) {
              console.warn('[submit-drift-abort]', resumeRetryDrift, { phase: 'post-resume-retry' })

              return abortForSessionSwitch(sessionId)
            }

            const recoveredId = resumed?.session_id

            if (recoveredId) {
              if (targetIsCurrentView()) {
                activeSessionIdRef.current = recoveredId
              }

              await withSessionBusyRetry(() =>
                deliver(recoveredId)
              )
            } else {
              submitErr = firstErr
            }
          } else {
            submitErr = firstErr
          }
        }

        if (submitErr !== null) {
          throw submitErr
        }

        if (usingComposerAttachments) {
          scope.clearAttachments()
        }

        if (trainingIntent) { completeAtumTrainingSubmit(trainingIntent) }

        // Submit landed — the turn now runs (busy stays true), but the submit
        // window is closed, so release the lock for the next (sequential) send.
        releaseSubmitLock()

        return true
      } catch (err) {
        if (sessionId) {discardPendingWordTurn(sessionId, submissionId)}
        releaseBusy()

        // A queued drain that raced a not-yet-settled turn gets a transient
        // "session busy" (4009). Don't surface an error bubble/toast — the entry
        // stays queued and the composer's bounded auto-drain retries when idle.
        if (options?.fromQueue && isSessionBusyError(err)) {
          return false
        }

        const providerSetupFailed = isProviderSetupError(err)

        const managedFailure: ManagedModelFailure | undefined =
          managedAlias && providerSetupFailed
            ? {
                version: 1,
                code: 'managed_proxy_unavailable',
                access_alias: managedAlias,
                phase: 'pre_dispatch',
                recovery: 'repair',
                transient: false,
                preserve_draft: true
              }
            : undefined

        const message = managedFailure
          ? managedModelFailureCopy(managedFailure).message
          : inlineErrorMessage(err, copy.promptFailed)

        if (
          ((managedFailure?.phase === 'pre_dispatch' && managedFailure.preserve_draft) || trainingIntent) &&
          targetIsCurrentView() &&
          !$composerDraft.get().trim()
        ) {
          dropOptimistic(sessionId)
          setComposerDraft(visibleText)

          if (attachments.length) {
            notify({
              id: `managed-draft-attachments:${sessionId}`,
              kind: 'warning',
              title: 'Question restored',
              message: 'Add the attachments again before sending this question.'
            })
          }
        }

        updateSessionState(
          sessionId,
          state => ({
            ...state,
            messages: [
              ...state.messages,
              {
                id: `assistant-error-${Date.now()}`,
                role: 'assistant',
                parts: [],
                error: message || copy.promptFailed,
                managedFailure,
                branchGroupId: state.pendingBranchGroup ?? undefined
              }
            ],
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null,
            sawAssistantPayload: true
          }),
          targetStoredSessionId
        )

        if (targetIsCurrentView() && providerSetupFailed && !managedFailure) {
          requestDesktopOnboarding(copy.providerCredentialRequired)

          return false
        }

        if (targetIsCurrentView()) {
          notifyError(err, copy.promptFailed)
        }

        return false
      }
    },
    [
      activeSessionIdRef,
      busyRef,
      copy,
      createBackendSessionForSend,
      getRoutedStoredSessionId,
      getRuntimeIdForStoredSession,
      getRouteToken,
      requestGateway,
      resumeStoredSession,
      scope,
      selectedStoredSessionIdRef,
      syncAttachmentsForSubmit,
      updateSessionState
    ]
  )
}
