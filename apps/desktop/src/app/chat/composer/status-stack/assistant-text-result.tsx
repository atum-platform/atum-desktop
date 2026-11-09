import { useEffect, useRef, useState } from 'react'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import {
  type AssistantTextFailureCode,
  type AssistantTextResultEvent,
  parseAssistantTextResultEvent
} from '@/lib/assistant-workspace-text-result'
import { registerWorkspaceTextFileTarget, workspaceTextFileTarget } from '@/store/workspace-text-files'

interface AssistantTextResultSectionProps {
  busy: boolean
  event: AssistantTextResultEvent
  onDismiss: (expected: AssistantTextResultIdentity, releaseSuccess?: boolean) => boolean
  onRetry: () => Promise<void>
}

type AssistantTextResultIdentity = Pick<AssistantTextResultEvent, 'sessionId' | 'toolCallId'>

function releaseSuccessLease(event: AssistantTextResultEvent | undefined): void {
  if (event?.result.outcome !== 'success') {
    return
  }

  void window.hermesDesktop?.filesystemCapability
    ?.releaseTextFile(event.result.descriptor.fileRef)
    .catch(() => undefined)
}

export function useAssistantTextResult(sessionId: string | null) {
  const queueRef = useRef<AssistantTextResultEvent[]>([])
  const [queue, setQueue] = useState<AssistantTextResultEvent[]>([])

  useEffect(() => {
    queueRef.current.forEach(releaseSuccessLease)
    queueRef.current = []
    setQueue([])

    if (!sessionId) {
      return
    }

    const unsubscribe = window.hermesDesktop?.filesystemCapability?.onAssistantTextResult(value => {
      const parsed = parseAssistantTextResultEvent(value)

      if (parsed?.sessionId === sessionId) {
        const next = [...queueRef.current, parsed]

        queueRef.current = next
        setQueue(next)
      }
    })

    return () => {
      unsubscribe?.()
      queueRef.current.forEach(releaseSuccessLease)
      queueRef.current = []
    }
  }, [sessionId])

  const dismiss = (expected: AssistantTextResultIdentity, releaseSuccess = true): boolean => {
    const [current, ...remaining] = queueRef.current

    if (!current || current.sessionId !== expected.sessionId || current.toolCallId !== expected.toolCallId) {
      return false
    }

    queueRef.current = remaining
    setQueue(remaining)

    if (releaseSuccess) {
      releaseSuccessLease(current)
    }

    return true
  }

  return {
    dismiss,
    event: queue[0]?.sessionId === sessionId ? queue[0] : null
  }
}

export function AssistantTextResultSection({ busy, event, onDismiss, onRetry }: AssistantTextResultSectionProps) {
  const { t } = useI18n()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const { result } = event
  const identity = { sessionId: event.sessionId, toolCallId: event.toolCallId }

  const dismissAndFocus = () => {
    onDismiss(identity)
    requestComposerFocus('active')
  }

  if (result.outcome === 'success') {
    const open = () => {
      registerWorkspaceTextFileTarget(workspaceTextFileTarget(result.descriptor))
      // S4 owns the lease after registration; removing it from this queue must
      // not release the descriptor that the canonical pane just adopted.
      onDismiss(identity, false)
    }

    return (
      <StatusSection
        accessory={
          <>
            <Button onClick={open} size="micro" type="button" variant="text">
              {t.statusStack.assistantText.open}
            </Button>
            <Button onClick={dismissAndFocus} size="micro" type="button" variant="text">
              {t.statusStack.assistantText.continue}
            </Button>
          </>
        }
        defaultCollapsed={false}
        icon={<Codicon name="file-text" size="0.8rem" />}
        label={t.statusStack.assistantText.saved(result.descriptor.displayName)}
      >
        <p className="px-2 py-1 text-xs text-muted-foreground">{t.statusStack.assistantText.savedDetail}</p>
      </StatusSection>
    )
  }

  const retry = async () => {
    if (busy || retrying || !result.retryable) {
      return
    }

    setRetrying(true)
    const retryIdentity = identity

    try {
      await onRetry()
      onDismiss(retryIdentity)
    } catch {
      return
    } finally {
      setRetrying(false)
      requestComposerFocus('active')
    }
  }

  const failureMessage = t.statusStack.assistantText.failures[result.code as AssistantTextFailureCode]

  return (
    <StatusSection
      accessory={
        <>
          {result.retryable && (
            <Button disabled={busy || retrying} onClick={() => void retry()} size="micro" type="button" variant="text">
              {t.statusStack.assistantText.retry}
            </Button>
          )}
          <Button onClick={() => setDetailsOpen(open => !open)} size="micro" type="button" variant="text">
            {t.statusStack.assistantText.details}
          </Button>
          <Button onClick={dismissAndFocus} size="micro" type="button" variant="text">
            {t.statusStack.dismiss}
          </Button>
        </>
      }
      defaultCollapsed={false}
      icon={<Codicon name="warning" size="0.8rem" />}
      label={failureMessage}
    >
      {detailsOpen && (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          <div>{t.statusStack.assistantText.failureCode(result.code)}</div>
          {result.incidentRef && <div>{t.statusStack.assistantText.incident(result.incidentRef)}</div>}
        </div>
      )}
    </StatusSection>
  )
}
