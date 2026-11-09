import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { ErrorBanner } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { $atumAccountScopeId, loadAtumMessages } from '@/store/atum-messaging'
import { ensureGatewayForProfile } from '@/store/gateway'

import type { GroupRoom } from '../../../shared/atum-group-conversations'
import { sessionRoute } from '../routes'

import { $groupOperations, loadGroupDetail, operateGroup, refreshGroupOperations } from './group-state'
import { $privateAdvisoryTasks } from './private-advisory-runner'

/** A visible meeting observes its durable round; the server owns scheduling. */
export function PrivateAdvisoryControls({ room }: { room: GroupRoom }) {
  const { t } = useI18n()
  const copy = t.dm.group.advisory
  const accountId = useStore($atumAccountScopeId)
  const tasks = useStore($privateAdvisoryTasks)
  const navigate = useNavigate()

  const task = Object.values(tasks).find(
    item =>
      item.accountId === accountId &&
      item.conversationId === room.conversationId &&
      ['starting', 'running', 'needs_input'].includes(item.state)
  )

  const operations = useStore($groupOperations)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const round = room.latestRound
  const scope = `${accountId}:${room.conversationId}:${round?.id}:${room.audienceRevision}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const operation = operations.find(row => row.operationId === operationId)
  const queued = operation && ['queued', 'sending', 'failed_retryable'].includes(operation.state)
  const operationFailed = operation && ['failed_terminal', 'conflicted'].includes(operation.state)

  useEffect(() => {
    setPending(false)
    setFailure(false)
    setOperationId(null)
  }, [accountId, room.conversationId, round?.id, room.audienceRevision])

  useEffect(() => {
    if (room.retiredAt) {
      return
    }

    // The first round may start before a roster event arrives. Poll the visible
    // room only; loadGroupDetail fences account and membership changes.
    let disposed = false

    const timer = setInterval(() => {
      void loadGroupDetail(room.conversationId).then(() => {
        // Round state and message content use separate renderer caches. The
        // main process may already hold a published reply without a roster
        // identity change; refresh the transcript through its existing fence.
        if (!disposed && accountId === $atumAccountScopeId.get()) {
          void loadAtumMessages(room.conversationId, { markRead: false })
        }
      })
      void refreshGroupOperations().catch(() => {})
    }, 4_000)

    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [accountId, room.conversationId, room.membershipEpoch, room.retiredAt])

  const act = async (action: 'stop_advisory' | 'continue_advisory') => {
    if (!round || !room.audienceRevision || pending || queued) {
      return
    }

    const expectedAccount = accountId
    const expectedScope = scope
    const stillCurrent = () => $atumAccountScopeId.get() === expectedAccount && scopeRef.current === expectedScope
    setPending(true)
    setFailure(false)
    const clientOperationId = crypto.randomUUID()
    setOperationId(clientOperationId)

    try {
      const result = await operateGroup({
        action,
        conversationId: room.conversationId,
        roundId: round.id,
        audienceRevision: room.audienceRevision,
        clientOperationId
      })

      if (!stillCurrent()) {
        return
      }

      if (action === 'stop_advisory' && result.state === 'sent') {
        await window.hermesDesktop?.advisoryRunner?.cancelConversation(room.conversationId).catch(() => {})
      }

      if (stillCurrent()) {
        setFailure(result.state === 'failed_terminal' || result.state === 'conflicted')
      }
    } catch {
      if (stillCurrent()) {
        setFailure(true)
      }
    } finally {
      if (stillCurrent()) {
        setPending(false)
      }
    }
  }

  const openActivity = async () => {
    if (!task?.profile || !task.durableSessionId) {
      return
    }

    const expectedAccount = accountId
    const expectedScope = scope

    try {
      await ensureGatewayForProfile(task.profile)

      if ($atumAccountScopeId.get() === expectedAccount && scopeRef.current === expectedScope) {
        navigate(sessionRoute(task.durableSessionId))
      }
    } catch {
      if ($atumAccountScopeId.get() === expectedAccount && scopeRef.current === expectedScope) {
        setFailure(true)
      }
    }
  }

  return (
    <section aria-label={copy.title} className="grid gap-2 text-xs text-(--atum-ink-muted)">
      <p>{copy.roundDisclosure}</p>
      {round && (
        <div className="flex items-center gap-2">
          <span role="status">{copy[round.status]}</span>
          {!room.retiredAt && (
            <Button
              disabled={pending || Boolean(queued)}
              onClick={() => void act(round.status === 'running' ? 'stop_advisory' : 'continue_advisory')}
              size="xs"
              variant="outline"
            >
              {round.status === 'running' ? copy.stop : copy.continue}
            </Button>
          )}
        </div>
      )}
      {queued && <p role="status">{t.dm.group.operationQueued}</p>}
      {task?.durableSessionId && task.profile && (
        <div className="flex items-center gap-2">
          {task.state === 'needs_input' && <span role="status">{copy.needsInput}</span>}
          <Button onClick={() => void openActivity()} size="xs" variant="outline">
            {copy.openActivity}
          </Button>
        </div>
      )}
      {(failure || operationFailed) && <ErrorBanner>{t.dm.group.operationFailed}</ErrorBanner>}
    </section>
  )
}
