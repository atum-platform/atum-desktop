import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type { MatrixChatGptTrainingStatus } from '../../shared/matrix-subscriptions'

import { useChatGptTrainingCopy } from './chatgpt-training-copy'
import { SettingsRow } from './settings-row'

type Read = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; value: MatrixChatGptTrainingStatus }
type Revoke = 'idle' | 'revoking' | 'pending' | 'failed'

/** How many times one Revoke press waits on a live call still finishing before saying so. */
const REVOKE_ROUNDS = 8

/**
 * Settings › Connections, under the ChatGPT row: the one-time confirmation's date and its Revoke.
 * Shown only for an account whose assistants touch Google, or one confirmed already. Revoking
 * keeps saying "Revoking…" while live calls drain (main retries with the same key), then the row
 * reads not confirmed. Errors are one calm line with Try again; nothing else on the page changes.
 */
export function ChatGptTrainingSettings({
  bridge,
  scopeKey
}: {
  bridge?: Pick<MatrixSubscriptionsBridge, 'chatGptTraining' | 'revokeChatGptTraining'>
  scopeKey?: string
}) {
  const words = useChatGptTrainingCopy()
  const { locale } = useI18n()
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [revoke, setRevoke] = useState<Revoke>('idle')
  const live = useRef(true)
  const resumed = useRef(false)

  const reload = useCallback(async () => {
    if (!bridge?.chatGptTraining) {
      return
    }

    try {
      const value = await bridge.chatGptTraining()

      if (live.current) {
        setRead({ kind: 'ready', value })
      }

      return value
    } catch {
      if (live.current) {
        setRead({ kind: 'failed' })
      }

      return undefined
    }
  }, [bridge])

  const start = useCallback(async () => {
    if (!bridge?.revokeChatGptTraining) {
      return
    }

    setRevoke('revoking')

    try {
      for (let round = 0; round < REVOKE_ROUNDS; round += 1) {
        const result = await bridge.revokeChatGptTraining()

        if (!live.current) {
          return
        }

        if (result.status === 'revoked') {
          setRead({ kind: 'ready', value: result.training })
          setRevoke('idle')

          return
        }

        if (result.status !== 'pending') {
          setRevoke('failed')

          return
        }
      }

      setRevoke('pending')
    } catch {
      if (live.current) {
        setRevoke('failed')
      }
    }
  }, [bridge])

  useEffect(() => {
    live.current = true
    resumed.current = false
    setRead({ kind: 'loading' })
    setRevoke('idle')
    void reload().then(value => {
      // A revocation still pending from before (another window, or before a restart): it reads
      // "Revoking…" and finishes with the same key main kept for it.
      if (value?.revoking && live.current && !resumed.current) {
        resumed.current = true
        void start()
      }
    })

    return () => {
      live.current = false
    }
  }, [reload, scopeKey, start])

  if (!bridge?.chatGptTraining) {
    return null
  }

  if (read.kind === 'loading') {
    return null
  }

  if (read.kind === 'failed') {
    return (
      <SettingsRow
        control={
          <Button onClick={() => void reload()} size="sm" variant="ghost">
            {words.tryAgain}
          </Button>
        }
        data-matrix-chatgpt-training-settings="failed"
        help={words.readFailed}
        title={words.rowTitle}
      />
    )
  }

  const { value } = read

  // Nothing to confirm and nothing confirmed: the row would only be noise.
  if (!value.required && !value.current && revoke === 'idle') {
    return null
  }

  const date =
    value.current && value.confirmedAt !== null
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value.confirmedAt)
      : undefined

  const help =
    revoke === 'revoking'
      ? words.revoking
      : revoke === 'pending'
        ? words.revokePending
        : revoke === 'failed'
          ? words.revokeFailed
          : date
            ? words.confirmedOn(date)
            : words.notConfirmed

  const canRevoke = value.current || revoke === 'pending' || revoke === 'failed'

  return (
    <SettingsRow
      aria-live="polite"
      control={
        canRevoke || revoke === 'revoking' ? (
          <Button
            data-matrix-chatgpt-training-revoke
            disabled={revoke === 'revoking'}
            onClick={() => revoke !== 'revoking' && void start()}
            size="sm"
            variant="secondary"
          >
            {revoke === 'revoking' ? words.revoking : revoke === 'idle' ? words.revoke : words.tryAgain}
          </Button>
        ) : undefined
      }
      data-matrix-chatgpt-training-settings={revoke !== 'idle' ? revoke : value.current ? 'confirmed' : 'not_confirmed'}
      help={help}
      title={words.rowTitle}
    />
  )
}
