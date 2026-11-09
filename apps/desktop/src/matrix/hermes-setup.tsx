import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { ArrowBackUp } from '@/lib/icons'

import type { MatrixHermesSetupResult, MatrixSnapshot } from '../../shared/matrix'

import { hermesSetupCopy } from './hermes-setup-copy'
import { SettingsLinkRow, SettingsRow, SettingsStatus } from './settings-row'

/**
 * Settings › Advanced › the model: which one the assistant answers with (Atum's AI or the
 * person's own), a way back to Atum's AI, and the form for a model of their own (saved and
 * checked with Hermes's own resolver before it is called ready).
 */
export function HermesSetup({
  atumModel = false,
  ownModel = false,
  paidItems = false,
  showCurrentMode = true,
  status,
  visible = true
}: {
  /** It answers with Atum's AI (snapshot.atumModel). */
  atumModel?: boolean
  /** It answers with a model the person connected (snapshot.ownModel). */
  ownModel?: boolean
  /** It holds paid Store items, which work only with Atum's AI: switching away warns. */
  paidItems?: boolean
  /** The assistant card already owns the current model label. */
  showCurrentMode?: boolean
  status: MatrixSnapshot['hermes']
  visible?: boolean
}) {
  const { locale } = useI18n()
  const copy = hermesSetupCopy[locale]
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<MatrixHermesSetupResult['state'] | 'failed' | null>(null)
  const [switching, setSwitching] = useState(false)
  const [switched, setSwitched] = useState<'done' | 'failed' | null>(null)
  const live = useRef(true)

  useEffect(() => {
    if (!visible) {
      setApiKey('')
    }
  }, [visible])

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const save = async () => {
    setPending(true)
    setResult(null)

    try {
      const value = await window.atumMatrix.configureHermes({ baseUrl, model, apiKey })

      if (live.current) {
        setResult(value.state)
      }
    } catch {
      if (live.current) {
        setResult('failed')
      }
    } finally {
      if (live.current) {
        setPending(false)
        setApiKey('')
      }
    }
  }

  const switchBack = async () => {
    const bridge = window.atumMatrix.useAtumModel

    if (!bridge || switching) {
      return
    }

    setSwitching(true)
    setSwitched(null)

    try {
      const value = await bridge()

      if (live.current) {
        setSwitched(value.state === 'ready' ? 'done' : 'failed')
      }
    } catch {
      if (live.current) {
        setSwitched('failed')
      }
    } finally {
      if (live.current) {
        setSwitching(false)
      }
    }
  }

  const using = ownModel ? copy.usingOwn : atumModel ? copy.usingAtum : null

  const switchStatus = switching
    ? copy.switching
    : switched === 'done'
      ? copy.switchedBack
      : switched === 'failed'
        ? copy.switchFailed
        : null

  return (
    <>
      {showCurrentMode && using && (
        <SettingsRow
          control={
            <SettingsStatus done role="status">
              {using}
            </SettingsStatus>
          }
          data-matrix-model-mode={ownModel ? 'own' : 'atum'}
          title={copy.modelLabel}
        />
      )}
      {ownModel && window.atumMatrix.useAtumModel && (
        // Going back is one act, so the row is the action; how it went shows under it.
        <div className="atum-settings-item">
          <SettingsLinkRow
            aria-busy={switching || undefined}
            disabled={switching || pending || status !== 'ready'}
            onClick={() => void switchBack()}
            trailing={<ArrowBackUp aria-hidden className="atum-settings-chevron" />}
          >
            {copy.switchBack}
          </SettingsLinkRow>
          {switchStatus && (
            <p className="atum-settings-item-note" role="status">
              {switchStatus}
            </p>
          )}
        </div>
      )}
      <details
        onToggle={event => {
          if (!event.currentTarget.open) {
            setApiKey('')
          }
        }}
      >
        <summary>{ownModel ? copy.change : copy.title}</summary>
        <form
          className="atum-settings-form"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <p className="atum-settings-form-help">{copy.help}</p>
          {paidItems && !ownModel && (
            <p className="atum-settings-form-help" data-matrix-paid-items role="note">
              {copy.paidItems}
            </p>
          )}
          <fieldset className="flex min-w-0 flex-col gap-3" disabled={pending || status !== 'ready'}>
            <label>
              {copy.endpoint}
              <Input
                autoComplete="off"
                className="atum-input atum-settings-field"
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://…/v1"
                required
                type="url"
                value={baseUrl}
              />
            </label>
            <label>
              {copy.model}
              <Input
                autoComplete="off"
                className="atum-input atum-settings-field"
                onChange={e => setModel(e.target.value)}
                required
                value={model}
              />
            </label>
            <label>
              {copy.key}
              <Input
                autoComplete="off"
                className="atum-input atum-settings-field"
                onChange={e => setApiKey(e.target.value)}
                type="password"
                value={apiKey}
              />
            </label>
            <p className="atum-settings-form-help">{copy.retention}</p>
            <div className="flex items-center gap-3">
              <Button size="sm" type="submit">
                {copy.save}
              </Button>
              {pending && (
                <span
                  className="flex min-w-0 items-center gap-2 text-(length:--atum-t-caption) text-(--atum-ink-muted)"
                  role="status"
                >
                  <Loader aria-hidden="true" className="size-4 shrink-0" role="presentation" size="sm" />
                  <span className="min-w-0">{copy.working}</span>
                </span>
              )}
            </div>
          </fieldset>
          {pending && (
            // Outside the fieldset, so stopping stays possible while the form is locked.
            <Button
              className="self-start"
              onClick={() =>
                void window.atumMatrix.cancelHermes().catch(() => {
                  if (live.current) {
                    setResult('failed')
                  }
                })
              }
              size="sm"
              type="button"
              variant="text"
            >
              {copy.cancel}
            </Button>
          )}
          {result && (
            <NoticeBand role="status" tone={result === 'ready' || result === 'cancelled' ? 'notice' : 'failure'}>
              {copy[result]}
            </NoticeBand>
          )}
        </form>
      </details>
    </>
  )
}
