import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react'

import { ClarifyPrompt } from '@/components/assistant-ui/clarify-presentation'
import { ApprovalControls } from '@/components/assistant-ui/tool/approval-controls'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import { MATRIX_PROMPT_MAX, type MatrixHermesPrompt, type MatrixSnapshot } from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'

import { runMatrixCommand } from './text-document-actions'

/**
 * The raw part of a prompt (the command to run, the name a key is saved under): one click away,
 * closed until it is asked for and not drawn at all while closed.
 */
function PromptDetails({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div className="grid gap-1" data-matrix-prompt-details>
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <DisclosureCaret open={open} />
        {label}
      </button>
      {open && (
        <div className="grid gap-1" id={id}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * The old app's masked prompts (prompt-overlays.tsx): the Mac's password, or a key a skill
 * saves. A plain title and one line say what is asked; the name the key is saved under waits in
 * Details. The value goes to this Mac's Hermes only; Cancel sends an empty answer, which Hermes
 * treats as a refusal.
 */
function MaskedPrompt({
  prompt,
  onSend
}: {
  prompt: Extract<MatrixHermesPrompt, { kind: 'sudo' | 'secret' }>
  onSend: (value: string) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const words = matrixActionCopy[locale]
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const sudo = prompt.kind === 'sudo'
  const title = sudo ? t.prompts.sudoTitle : words.secretTitle
  const ask = sudo ? words.sudoAsk : prompt.prompt || words.secretAsk

  const send = (answer: string) => {
    setSending(true)
    void onSend(answer).finally(() => {
      setSending(false)
      setValue('')
    })
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        send(value)
      }}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{ask}</p>
      {!sudo && prompt.envVar && (
        <PromptDetails label={words.promptDetails}>
          <p className="text-xs text-muted-foreground">
            {words.secretSavedAs} <code className="font-mono">{prompt.envVar}</code>
          </p>
        </PromptDetails>
      )}
      <Input
        aria-label={title}
        autoComplete="off"
        disabled={sending}
        onChange={event => setValue(event.target.value)}
        placeholder={sudo ? words.sudoPlaceholder : words.secretPlaceholder}
        type="password"
        value={value}
      />
      <div className="flex gap-2">
        <Button disabled={sending} size="sm" type="submit">
          {t.common.send}
        </Button>
        <Button disabled={sending} onClick={() => send('')} size="sm" type="button" variant="text">
          {t.common.cancel}
        </Button>
      </div>
    </form>
  )
}

/** How long before its deadline a prompt starts saying that time is short. */
const LAST_MINUTE_S = 60

function Prompt({ prompt }: { prompt: MatrixHermesPrompt }) {
  const { t, locale } = useI18n()
  const copy = matrixActionCopy[locale]
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(Date.now)
  const remaining = Math.max(0, Math.ceil((prompt.deadlineAt - now) / 1000))
  const fail = () => setFailed(true)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)

    return () => clearInterval(timer)
  }, [])

  const checkDeadline = () => {
    if (Date.now() >= prompt.deadlineAt) {
      setNow(Date.now())
      throw new Error('matrix_hermes_prompt_expired')
    }

    setFailed(false)
  }

  return (
    <div className="min-w-0">
      {/* No stopwatch: a count of seconds pressures people. The last minute says it is short,
          and the end says it ended; before that the card says nothing about time. */}
      {remaining <= LAST_MINUTE_S && (
        <p aria-live="off" className="text-sm text-muted-foreground" role="timer">
          {remaining ? copy.promptDeadlineSoon : copy.promptDeadlineEnded}
        </p>
      )}
      <fieldset className="min-w-0 disabled:opacity-60" disabled={!remaining}>
        {prompt.kind === 'sudo' || prompt.kind === 'secret' ? (
          <MaskedPrompt
            onSend={async value => {
              try {
                checkDeadline()
                await window.atumMatrix.respondHermes(
                  prompt.kind === 'sudo'
                    ? { id: prompt.id, kind: 'sudo', password: value }
                    : { id: prompt.id, kind: 'secret', value }
                )
              } catch {
                fail()
              }
            }}
            prompt={prompt}
          />
        ) : prompt.kind === 'approval' ? (
          <div className="grid gap-1.5" data-matrix-approval>
            <p className="text-sm font-medium">{copy.approvalTitle}</p>
            <p className="text-sm text-muted-foreground">{copy.approvalAsk}</p>
            <ApprovalControls
              autoFocus={false}
              labels={{ allow: copy.approvalAllow, deny: copy.approvalDecline }}
              onError={fail}
              onRespond={async choice => {
                if (choice !== 'once' && choice !== 'deny') {
                  throw new Error('invalid response')
                }

                checkDeadline()
                await window.atumMatrix.respondHermes({ id: prompt.id, kind: 'approval', choice })
              }}
              request={{ command: '', choices: prompt.allowOnce ? ['once', 'deny'] : ['deny'], allowPermanent: false }}
              shortcuts={false}
              surface="floating"
            />
            {/* The reason Hermes gave and the exact command are one click away, for whoever reads
                them; the card asks in words anyone can answer (owner, 2026-10-25). */}
            {(prompt.command || prompt.description) && (
              <PromptDetails label={copy.promptDetails}>
                {prompt.description && (
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{prompt.description}</p>
                )}
                {prompt.command && (
                  <pre
                    className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 text-xs"
                    data-matrix-approval-command
                  >
                    {prompt.command}
                  </pre>
                )}
              </PromptDetails>
            )}
          </div>
        ) : (
          <ClarifyPrompt
            choices={prompt.choices}
            maxLength={MATRIX_PROMPT_MAX}
            onError={fail}
            onRespond={answer => {
              checkDeadline()

              return window.atumMatrix.respondHermes({ id: prompt.id, kind: 'clarify', answer })
            }}
            question={prompt.question}
            ready
            shortcuts={false}
          />
        )}
      </fieldset>
      {failed && remaining > 0 && (
        <NoticeBand role="status" tone="failure">
          {prompt.kind === 'approval'
            ? t.assistant.approval.sendFailed
            : prompt.kind === 'sudo'
              ? t.prompts.sudoSendFailed
              : prompt.kind === 'secret'
                ? t.prompts.secretSendFailed
                : t.assistant.clarify.sendFailed}
        </NoticeBand>
      )}
    </div>
  )
}

/** Input is local to the invocation, never a Matrix message or permission event.
 * Background input stays discoverable without navigating or stealing focus: every agent's
 * open prompts and notices show, each with its room (per-agent runtime plan §2.4).
 *
 * Launch night: the open chat's own questions and approvals sit `inline`, above its message
 * box in the transcript's column, where the person is looking; other chats' (`stack`, under
 * the header) are one line with the way there.
 */
export function HermesPrompts({
  conversationVisible = true,
  snapshot,
  fail,
  placement = 'stack'
}: {
  /** Under the header: whether the open chat's transcript (and its inline prompts) shows. */
  conversationVisible?: boolean
  snapshot: MatrixSnapshot
  fail: (cause?: unknown) => void
  placement?: 'inline' | 'stack'
}) {
  const { locale } = useI18n()
  const copy = matrixActionCopy[locale]
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

  if (!snapshot.identity) {
    return null
  }

  const open = (roomId: string) => roomId === snapshot.roomId
  // Inline: the open chat's own. Under the header: every other chat's, and the open chat's
  // too while something else (Workplace, Drive, an app) covers its transcript.
  const here = (roomId: string) => (placement === 'inline' ? open(roomId) : !open(roomId) || !conversationVisible)
  const full = (roomId: string) => placement === 'inline' || open(roomId)

  // Before several agents, main sends only the default agent's singular fields.
  const groups = (
    snapshot.agentTurns
      ? snapshot.agentTurns.flatMap(turn => (turn.prompts?.length ? [{ roomId: turn.roomId, prompts: turn.prompts }] : []))
      : snapshot.hermesPrompts?.prompts.length
        ? [snapshot.hermesPrompts]
        : []
  ).filter(pending => here(pending.roomId))

  const notices = (
    snapshot.agentTurns
      ? snapshot.agentTurns.flatMap(turn => (turn.notice ? [turn.notice] : []))
      : snapshot.hermesPromptNotice
        ? [snapshot.hermesPromptNotice]
        : []
  ).filter(notice => !dismissed.has(notice.id) && here(notice.roomId))

  if (!groups.length && !notices.length) {
    return null
  }

  const roomName = (roomId: string) =>
    snapshot.rooms.find(room => room.id === roomId)?.name || copy.listeningRoomFallback

  const content = (
    <>
      {notices.map(notice => (
        <NoticeBand className={placement === 'stack' ? 'mx-4 my-2 shrink-0' : 'shrink-0'} key={notice.id} role="status" tone="notice">
          <span className="flex flex-wrap items-center gap-x-2">
            <span>
              {open(notice.roomId) ? '' : `${roomName(notice.roomId)} · `}
              {notice.reason === 'clarification_expired' ? copy.clarificationExpired : copy.promptTurnExpired}
            </span>
            <Button
              onClick={() => setDismissed(previous => new Set(previous).add(notice.id))}
              size="sm"
              variant="text"
            >
              {copy.dismissPromptNotice}
            </Button>
          </span>
        </NoticeBand>
      ))}
      {groups.map(pending =>
        full(pending.roomId) ? (
          <section
            aria-label={copy.hermesNeedsInput}
            className={`atum-glass-card grid max-h-[45vh] shrink-0 gap-2 overflow-auto px-4 py-3 ${placement === 'stack' ? 'mx-4 my-2' : ''}`}
            data-matrix-prompts-inline
            key={pending.roomId}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium" role="status">
                {copy.hermesNeedsInput}
              </span>
              <Button
                onClick={() => void window.atumMatrix.cancelHermes(pending.roomId).catch(fail)}
                size="sm"
                variant="text"
              >
                {copy.cancelHermes}
              </Button>
            </div>
            {pending.prompts.map(prompt => (
              <Prompt key={prompt.id} prompt={prompt} />
            ))}
          </section>
        ) : (
          <section
            aria-label={copy.hermesNeedsInput}
            className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2"
            key={pending.roomId}
          >
            <span className="text-sm" role="status">
              {copy.hermesNeedsInput} · {roomName(pending.roomId)}
            </span>
            <Button
              onClick={() => void runMatrixCommand({ kind: 'select', roomId: pending.roomId }).catch(fail)}
              size="sm"
              variant="text"
            >
              {roomName(pending.roomId)}
            </Button>
            <Button
              onClick={() => void window.atumMatrix.cancelHermes(pending.roomId).catch(fail)}
              size="sm"
              variant="text"
            >
              {copy.cancelHermes}
            </Button>
          </section>
        )
      )}
    </>
  )

  return placement === 'inline' ? (
    <div
      className="mx-auto grid w-[min(var(--composer-width),calc(100%-2rem))] shrink-0 gap-2 pt-2"
      data-matrix-prompts
    >
      {content}
    </div>
  ) : (
    content
  )
}
