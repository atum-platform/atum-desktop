import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import type { Locale } from '@/i18n'

import type { MatrixAgentServiceStatus, MatrixMessage } from '../../shared/matrix'

export const MATRIX_NO_REPLY_MS = 3 * 60_000
export const MATRIX_SERVICE_STATUS_REFRESH_MS = 30_000

interface NoReplyCopy {
  generic(name: string): string
  sendAgain: string
  serverDown(name: string, since: string): string
}

const COPY: Record<Locale, NoReplyCopy> = {
  en: {
    generic: name => `${name} hasn't been able to answer yet. Atum will answer as soon as it can.`,
    sendAgain: 'Send again',
    serverDown: (name, since) =>
      `Atum's server has had a problem since ${since}. ${name} will answer when the server is back.`
  },
  vi: {
    generic: name => `${name} chưa trả lời được. Atum sẽ trả lời ngay khi có thể.`,
    sendAgain: 'Gửi lại',
    serverDown: (name, since) =>
      `Máy chủ của Atum đang gặp sự cố từ ${since}. ${name} sẽ trả lời khi máy chủ hoạt động lại.`
  },
  ja: {
    generic: name => `${name}はまだ返答できていません。Atumは可能になり次第返答します。`,
    sendAgain: 'もう一度送信',
    serverDown: (name, since) =>
      `Atumのサーバーで${since}から問題が発生しています。${name}はサーバーが復旧すると返答します。`
  },
  zh: {
    generic: name => `${name}暂时还无法回复。Atum会在可以回复时尽快答复。`,
    sendAgain: '重新发送',
    serverDown: (name, since) => `Atum的服务器自${since}起出现故障。服务器恢复后，${name}会回复。`
  },
  'zh-hant': {
    generic: name => `${name}暫時還無法回覆。Atum會在可以回覆時儘快答覆。`,
    sendAgain: '重新傳送',
    serverDown: (name, since) => `Atum的伺服器自${since}起發生故障。伺服器恢復後，${name}會回覆。`
  }
}

/** The oldest owner message after the latest real agent answer. A notice answers only the exact
 * owner event/turn it names; unrelated status notices answer nothing. */
export function matrixUnansweredOwnerMessage(
  messages: readonly MatrixMessage[],
  agentUserIds: ReadonlySet<string>
): MatrixMessage | null {
  let unanswered: MatrixMessage[] = []

  for (const message of messages) {
    if (message.own) {
      if (!message.pending && !message.failed && !message.redacted && !message.notice) {
        unanswered.push(message)
      }
    } else if (
      agentUserIds.has(message.sender) &&
      !message.pending &&
      !message.failed &&
      !message.redacted &&
      !message.decryptionFailed &&
      !message.notice &&
      // An interim remark (agent-turns/1.4) is the agent talking mid-turn, never the answer.
      !message.interim
    ) {
      unanswered = []
    } else if (
      agentUserIds.has(message.sender) &&
      message.notice &&
      // The progress line (agent-turns/1.3) is never an answer: it must not stop the banner.
      !message.progress &&
      !message.pending &&
      !message.failed &&
      !message.redacted &&
      !message.decryptionFailed &&
      (message.replyTo || message.turn)
    ) {
      unanswered = unanswered.filter(
        owner => !(message.replyTo && owner.id === message.replyTo) && !(message.turn && owner.turn === message.turn)
      )
    }
  }

  return unanswered[0] ?? null
}

function displayTime(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(locale === 'zh-hant' ? 'zh-Hant' : locale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(value)
}

export interface MatrixNoReplyBannerProps {
  agentPrincipal: string
  assistantName: string
  locale: Locale
  message: MatrixMessage | null
  /** Ask again with the unanswered message's words, through the composer's send path. */
  onResend?: (body: string) => void
  readStatus?: () => Promise<MatrixAgentServiceStatus>
  typing: boolean
}

/**
 * The timer is intentionally independent of the service-status read: after three minutes the
 * generic banner appears even when the Shell, DA or the read itself is unavailable. Status only
 * chooses better words, and is refreshed while the unanswered message remains visible.
 */
export function MatrixNoReplyBanner({
  agentPrincipal,
  assistantName,
  locale,
  message,
  onResend,
  readStatus,
  typing
}: MatrixNoReplyBannerProps) {
  const deadline = message ? message.timestamp + MATRIX_NO_REPLY_MS : null
  const scope = message ? `${agentPrincipal}:${message.id}:${message.timestamp}` : ''
  const [clock, setClock] = useState(() => Date.now())
  // One press answers this exact message: the button stays disabled until a reply clears the
  // banner or a newer unanswered message takes its place (its id differs).
  const [resentId, setResentId] = useState<string | null>(null)
  const resent = message !== null && resentId === message.id

  const [reading, setReading] = useState<{
    scope: string
    status: MatrixAgentServiceStatus | null
  } | null>(null)

  useEffect(() => {
    setClock(Date.now())

    if (deadline === null) {
      return
    }

    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, deadline - Date.now()))

    return () => window.clearTimeout(timer)
  }, [deadline, scope])

  const due = deadline !== null && clock >= deadline && !typing

  useEffect(() => {
    if (!due || !readStatus) {
      return
    }

    let live = true
    let running = false

    const refresh = async () => {
      if (running) {
        return
      }

      running = true

      try {
        const status = await readStatus()

        if (live && status.agentPrincipal === agentPrincipal) {
          setReading({ scope, status })
        }
      } catch {
        if (live) {
          setReading({ scope, status: null })
        }
      } finally {
        running = false
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), MATRIX_SERVICE_STATUS_REFRESH_MS)

    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [agentPrincipal, due, readStatus, scope])

  const text = useMemo(() => {
    const status = reading?.scope === scope ? reading.status : null

    return status?.state === 'server_down'
      ? COPY[locale].serverDown(assistantName, displayTime(locale, status.serverDownSince))
      : COPY[locale].generic(assistantName)
  }, [assistantName, locale, reading, scope])

  if (!due) {
    return null
  }

  const resend = () => {
    if (!message || !onResend || resent) {
      return
    }

    setResentId(message.id)
    onResend(message.body)
  }

  return (
    <NoticeBand data-matrix-no-reply tone="notice">
      {text}
      {message && onResend && message.body.trim() !== '' && (
        <Button
          className="ms-2"
          data-matrix-no-reply-resend
          disabled={resent}
          onClick={resend}
          size="sm"
          type="button"
          variant="text"
        >
          {COPY[locale].sendAgain}
        </Button>
      )}
    </NoticeBand>
  )
}
