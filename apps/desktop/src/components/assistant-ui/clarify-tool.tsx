import { ConsentBoundary } from '@/components/ui/consent-boundary'
'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useCallback, useMemo } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { CircleLetterA, MessageQuestion } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { clearClarifyRequest, normalizeChoices, sessionClarifyRequest, warnDroppedChoices } from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'

import { ChoiceButton, ClarifyLine, ClarifyPrompt, ClarifyShell, letterFor } from './clarify-presentation'
import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

interface ClarifyArgs {
  question?: string
  choices?: string[] | null
}

interface ClarifyResult {
  question?: string
  answer?: string
  error?: string
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]

    if (typeof value === 'string') {
      return value
    }
  }
}

function readClarifyArgs(args: unknown): ClarifyArgs {
  const row = parseMaybeObject(args)
  const rawChoices = row.choices
  const choices = normalizeChoices(rawChoices)

  const question = stringField(row, 'question')

  if (rawChoices != null && choices.length === 0 && question) {
    warnDroppedChoices('tool_args', question, rawChoices)
  }

  return {
    question,
    choices: choices.length > 0 ? choices : null
  }
}

/** Parse clarify tool JSON (`question` + `user_response`). */
export function readClarifyResult(result: unknown): ClarifyResult {
  const row = parseMaybeObject(result)

  if (Object.keys(row).length === 0) {
    return typeof result === 'string' && result.trim() ? { answer: result.trim() } : {}
  }

  return {
    question: stringField(row, 'question'),
    answer: stringField(row, 'user_response', 'answer'),
    error: stringField(row, 'error')
  }
}

export const ClarifyTool = (props: ToolCallMessagePartProps) => {
  // Answered → settled Q&A (ToolFallback collapsed the answer away).
  if (props.result !== undefined) {
    return <ConsentBoundary><ClarifyToolSettled {...props} /></ConsentBoundary>
  }

  return <ConsentBoundary><ClarifyToolLive {...props} /></ConsentBoundary>
}

function ClarifyToolLive(props: ToolCallMessagePartProps) {
  const messageRunning = useAuiState(selectMessageRunning)

  // Stopped mid-prompt with no result — don't leave a dead interactive panel.
  if (!messageRunning) {
    return <ConsentBoundary><ToolFallback {...props} /></ConsentBoundary>
  }

  return <ConsentBoundary><ClarifyToolPending {...props} /></ConsentBoundary>
}

function ClarifyToolSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])
  const fromResult = useMemo(() => readClarifyResult(result), [result])

  const question = fromResult.question || fromArgs.question || ''
  const answer = fromResult.answer
  const error = fromResult.error
  const skipped = !error && answer !== undefined && !answer.trim()
  const answerText = error || (skipped ? copy.skipped : (answer ?? '').trim())
  const choices = fromArgs.choices ?? []

  // A skipped (timed-out) clarify keeps its choices on screen and actionable.
  // The blocking request is long gone — the tool already returned empty — so a
  // pick can't resolve it retroactively. Instead it drafts a quoted follow-up
  // into the composer (Enter sends; if the agent is mid-turn it queues like
  // any other prompt). Without this the card collapsed to just "Skipped" and
  // the options were unrecoverable.
  const followUp = useCallback(
    (choice: string) => {
      requestComposerInsert(copy.lateAnswer(question, choice), { mode: 'block' })
      requestComposerFocus()
      triggerHaptic('selection')
    },
    [copy, question]
  )

  return (
    <ConsentBoundary><ClarifyShell className="grid gap-1.5 px-2.5 py-2" data-clarify-settled="">
      {question ? (
        <ClarifyLine icon={MessageQuestion}>
          <span className="whitespace-pre-wrap font-medium leading-(--conversation-line-height)">{question}</span>
        </ClarifyLine>
      ) : null}
      {answerText ? (
        <ClarifyLine icon={CircleLetterA}>
          <p
            className={cn(
              'whitespace-pre-wrap leading-(--conversation-line-height)',
              error ? 'text-destructive' : 'text-(--ui-text-secondary)',
              skipped && 'italic text-(--ui-text-tertiary)'
            )}
            data-clarify-answer=""
          >
            {answerText}
          </p>
        </ClarifyLine>
      ) : null}
      {skipped && choices.length > 0 ? (
        <div className="grid gap-px" data-clarify-late-choices="" role="group">
          {choices.map((choice, index) => (
            <ChoiceButton
              char={letterFor(index)}
              choice={choice}
              key={`${index}-${choice}`}
              onClick={() => followUp(choice)}
              title={copy.lateAnswerTip}
            />
          ))}
          <p className="px-1.5 pt-0.5 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{copy.lateAnswerHint}</p>
        </div>
      ) : null}
    </ClarifyShell></ConsentBoundary>
  )
}

function ClarifyToolPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  // The tool row is in whichever session's transcript rendered it — read THAT
  // session's clarify (primary or tile), not the globally-active one.
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionClarifyRequest(sessionId), [sessionId])
  const request = useStore($request)
  const gateway = useStore($gateway)
  const fromArgs = useMemo(() => readClarifyArgs(args), [args])

  const matchingRequest = useMemo(() => {
    if (!request) {
      return null
    }

    if (fromArgs.question && request.question && fromArgs.question !== request.question) {
      return null
    }

    return request
  }, [fromArgs.question, request])

  const question = fromArgs.question || matchingRequest?.question || ''

  const choices = useMemo(
    () => fromArgs.choices ?? matchingRequest?.choices ?? [],
    [fromArgs.choices, matchingRequest?.choices]
  )

  return (
    <ConsentBoundary><ClarifyPrompt
      choices={choices}
      onError={error => notifyError(error, copy.sendFailed)}
      onRespond={async answer => {
        if (!matchingRequest) {
          throw new Error(copy.notReady)
        }

        if (!gateway) {
          throw new Error(copy.gatewayDisconnected)
        }

        await gateway.request('clarify.respond', { request_id: matchingRequest.requestId, answer })
        triggerHaptic('submit')
        clearClarifyRequest(matchingRequest.requestId, matchingRequest.sessionId)
      }}
      question={question}
      ready={Boolean(matchingRequest?.requestId)}
    /></ConsentBoundary>
  )
}
