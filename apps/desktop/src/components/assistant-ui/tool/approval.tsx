'use client'

import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useI18n } from '@/i18n'
import { respondToApprovalRequest } from '@/lib/approval-response'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle } from '@/lib/icons'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import {
  type ApprovalRequest,
  clearApprovalRequest,
  registerApprovalInlineAnchor,
  sessionApprovalInlineVisible,
  sessionApprovalRequest
} from '@/store/prompts'

import { ApprovalControls } from './approval-controls'
import type { ToolPart } from './fallback-model'

// Inline approval control. Rendered as a compact button strip
// under the pending tool row that raised the approval (the row already shows
// the command, so the strip deliberately doesn't repeat it) instead of as a
// modal overlay.
//
// Binding is POSITIONAL, not command-matched: the desktop `tool.start` payload
// carries no structured args (only tool_id/name/context — see
// tui_gateway/server.py::_on_tool_start), so we cannot join the approval to the
// row by command string. But `approval.request` only ever fires from the
// `terminal` / `execute_code` guards and the agent thread blocks on exactly one
// approval at a time, so the single pending row of those tools IS the row that
// raised it. The command/description text comes from `$approvalRequest` (the
// event payload), which is the only place that data reliably exists.
//
// Plugin-escalated approvals (Atum's browser, computer, and workspace-write
// consents) also arrive as `approval.request`, but their tool rows are not in
// this set, so they render through `PendingApprovalFallback` below.
export const APPROVAL_TOOLS = new Set(['terminal', 'execute_code'])

export const PendingToolApproval: FC<{ part: ToolPart }> = ({ part }) => {
  // The tool row lives in whichever session's transcript rendered it — read
  // THAT session's approval (works for the primary and every tile).
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionApprovalRequest(sessionId), [sessionId])
  const request = useStore($request)

  if (!request || !APPROVAL_TOOLS.has(part.toolName)) {
    return null
  }

  return <InlineApprovalBar request={request} />
}

const InlineApprovalBar: FC<{ request: ApprovalRequest }> = ({ request }) => {
  useEffect(() => registerApprovalInlineAnchor(request.sessionId), [request.sessionId])

  return <ApprovalBar request={request} surface="inline" />
}

export const PendingApprovalFallback: FC = () => {
  const { t } = useI18n()
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionApprovalRequest(sessionId), [sessionId])
  const $inlineVisible = useMemo(() => sessionApprovalInlineVisible(sessionId), [sessionId])
  const request = useStore($request)
  const inlineVisible = useStore($inlineVisible)

  if (!request || inlineVisible) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
      data-slot="tool-approval-fallback"
      style={{ bottom: 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.875rem)' }}
    >
      <div className="pointer-events-auto rounded-xl border border-primary/30 bg-(--ui-chat-surface-background) px-3 py-2 shadow-lg backdrop-blur-xl [-webkit-backdrop-filter:blur(1rem)]">
        <div className="flex min-w-0 items-center gap-2 text-sm text-primary">
          <AlertCircle className="size-4 shrink-0" />
          <span className="shrink-0 font-medium">{t.assistant.approval.jumpToApproval}</span>
          {request.description && (
            <span className="min-w-0 truncate text-(--ui-text-tertiary)">{request.description}</span>
          )}
        </div>
        <ApprovalBar request={request} surface="floating" />
      </div>
    </div>
  )
}

const ApprovalBar: FC<{ request: ApprovalRequest; surface: 'floating' | 'inline' }> = ({ request, surface }) => {
  const { t } = useI18n()
  const gateway = useStore($gateway)

  return (
    <ApprovalControls
      onError={error => notifyError(error, t.assistant.approval.sendFailed)}
      onRespond={async choice => {
        if (!sessionApprovalRequest(request.sessionId).get()) {
          return
        }

        if (!gateway) {
          throw new Error(t.assistant.approval.gatewayDisconnected)
        }

        await respondToApprovalRequest(gateway, request, choice)
        triggerHaptic(choice === 'deny' ? 'cancel' : 'submit')
        clearApprovalRequest(request.sessionId)
      }}
      request={request}
      surface={surface}
    />
  )
}
