import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { $atumAccountScopeId } from '@/store/atum-messaging'

import type { MatrixAwarenessView } from '../../../shared/matrix-awareness-controls'

import { AtumSettingsGroup, AtumSettingsRow } from './atum-consumer-settings'

type ReadState = 'loading' | 'ready' | 'failed'
type ChangeAction = 'include' | 'exclude' | 'forget'

/** Account-scoped presentation of owner choices. The companion remains authoritative.
 * Renders nothing until native confirms this account has an awareness controls room
 * (only an owner-reader enrollment creates one), so accounts without a companion never
 * see a loading row, an error, or choices that nothing would apply. */
export function AtumAwarenessSettings() {
  const { t } = useI18n()
  const accountScopeId = useStore($atumAccountScopeId)
  const bridge = window.atumMatrix?.awareness
  const generation = useRef(0)
  const [state, setState] = useState<ReadState>('loading')
  const [view, setView] = useState<MatrixAwarenessView | null>(null)
  const [viewScope, setViewScope] = useState<string | null>(null)
  const [changing, setChanging] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [pendingNotice, setPendingNotice] = useState(false)
  const [availableIn, setAvailableIn] = useState<{ scope: string | null } | null>(null)

  const read = useCallback(() => {
    if (!bridge) {
      return
    }

    const request = ++generation.current
    const scope = accountScopeId
    setState('loading')
    setView(null)
    setViewScope(null)
    setChanging(null)
    setConfirming(null)
    setPendingNotice(false)

    void bridge.read().then(
      next => {
        if (request === generation.current && scope === $atumAccountScopeId.get()) {
          if ('available' in next) {
            setAvailableIn(null)
            setState('ready')

            return
          }

          setAvailableIn({ scope })
          setView(next)
          setViewScope(scope)
          setState('ready')
        }
      },
      () => {
        if (request === generation.current && scope === $atumAccountScopeId.get()) {
          setView(null)
          setViewScope(null)
          setState('failed')
        }
      }
    )
  }, [accountScopeId, bridge])

  useEffect(() => {
    if (!bridge) {
      generation.current++
      setView(null)
      setViewScope(null)
      setChanging(null)
      setConfirming(null)
      setPendingNotice(false)

      return
    }

    read()
  }, [bridge, read])

  if (!bridge || !availableIn || availableIn.scope !== accountScopeId) {
    return null
  }

  const change = (roomId: string, action: ChangeAction) => {
    if (!view || viewScope !== accountScopeId || changing !== null) {
      return
    }

    const request = generation.current
    const scope = accountScopeId
    const identity = view.identity
    setChanging(roomId)
    setConfirming(null)
    setPendingNotice(false)

    void bridge.change(identity, roomId, action).then(
      next => {
        if (request === generation.current && scope === $atumAccountScopeId.get()) {
          setView(next)
          setPendingNotice(true)
          setChanging(null)
        }
      },
      () => {
        if (request === generation.current && scope === $atumAccountScopeId.get()) {
          setChanging(null)
          setState('failed')
        }
      }
    )
  }

  const copy = t.atum.awareness.settings
  const scopedView = viewScope === accountScopeId ? view : null

  return (
    <section aria-labelledby="atum-awareness-settings-heading" className="mt-8">
      <h3 className="text-(length:--atum-t-ui) font-medium text-(--atum-ink)" id="atum-awareness-settings-heading">{copy.title}</h3>
      <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.description}</p>
      <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.privacy}</p>
      <AtumSettingsGroup>
        {state === 'loading' ? (
          <AtumSettingsRow action={<span className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{t.common.loading}</span>} title={copy.loading} />
        ) : state === 'failed' ? (
          <AtumSettingsRow
            action={<Button onClick={read} size="sm" variant="outline">{t.common.retry}</Button>}
            description={<NoticeBand role="alert">{copy.failed}</NoticeBand>}
            title={copy.title}
          />
        ) : scopedView?.rooms.length === 0 ? (
          <AtumSettingsRow action={<span />} description={copy.emptyDescription} title={copy.empty} />
        ) : scopedView?.rooms.map(room => {
          const busy = changing === room.roomId
          const forgetting = confirming === room.roomId

          return (
            <AtumSettingsRow
              action={
                forgetting ? (
                  <div className="flex items-center gap-2">
                    <Button disabled={Boolean(changing)} onClick={() => change(room.roomId, 'forget')} size="sm" variant="destructive">{copy.confirmForget}</Button>
                    <Button disabled={Boolean(changing)} onClick={() => setConfirming(null)} size="sm" variant="outline">{t.common.cancel}</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button disabled={Boolean(changing)} onClick={() => change(room.roomId, room.included ? 'exclude' : 'include')} size="sm" variant="outline">
                      {busy ? t.common.saving : room.included ? copy.exclude : copy.include}
                    </Button>
                    <Button disabled={Boolean(changing)} onClick={() => setConfirming(room.roomId)} size="sm" variant="text">{copy.forget}</Button>
                  </div>
                )
              }
              description={room.forgotten ? copy.forgottenDescription : room.included ? copy.includedDescription : copy.excludedDescription}
              key={room.roomId}
              title={room.name}
            />
          )
        })}
      </AtumSettingsGroup>
      {pendingNotice && <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.pending}</p>}
    </section>
  )
}
