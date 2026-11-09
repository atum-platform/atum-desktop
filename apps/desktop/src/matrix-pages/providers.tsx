import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, Pill, SettingsContent, SettingsSection, SettingsSkeleton } from '@/app/settings/primitives'
import { ProviderGroupLabel, ProviderLocalEndpointRow } from '@/app/settings/providers-presentation'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Cpu, KeyRound, Spinner, X } from '@/lib/icons'

import type {
  MatrixProviderEndpointInput,
  MatrixProviderOAuthSession,
  MatrixProviderSettingsClient,
  MatrixProviderSnapshot,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'
import { MATRIX_PLAN_SIGN_IN_TERMS } from '../../shared/matrix-provider-terms'
import { ModelPickerPopover, pickerRouteOf } from '../matrix/model-picker-popover'

import { providersCopy } from './providers-copy'

export interface MatrixProvidersSettingsProps {
  client: MatrixProviderSettingsClient
  agentName: string
  onClose?: () => void
}

const emptyEndpoint = (): MatrixProviderEndpointInput => ({ name: '', baseUrl: '', model: '', apiKey: '' })

/** Ephemeral presentation only. Native owns selected home, confirmation,
 * OAuth continuation and credential persistence; no legacy auth/store mounts. */
export function MatrixProvidersSettings({ client, agentName, onClose }: MatrixProvidersSettingsProps) {
  const { locale } = useI18n()
  const copy = providersCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixProviderSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<'applied' | 'cancelled' | 'failed' | 'busy' | 'oauthFailed' | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [staleAux, setStaleAux] = useState(false)
  const [keyProvider, setKeyProvider] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [endpoint, setEndpoint] = useState(emptyEndpoint)
  const [oauth, setOAuth] = useState<MatrixProviderOAuthSession | null>(null)
  const [code, setCode] = useState('')
  const generation = useRef(0)
  const readGeneration = useRef(0)
  const operation = useRef(false)
  const oauthRef = useRef<MatrixProviderOAuthSession | null>(null)

  const retire = useCallback(() => {
    generation.current++
    readGeneration.current++
  }, [])

  const reload = useCallback(async () => {
    const scope = generation.current
    const read = ++readGeneration.current
    setLoading(true)
    setLoadFailed(false)

    try {
      const next = await client.snapshot()

      if (scope !== generation.current || read !== readGeneration.current) {
        return false
      }

      setSnapshot(next)
      setUncertain(false)

      return true
    } catch {
      if (scope === generation.current && read === readGeneration.current) {
        setLoadFailed(true)
      }

      return false
    } finally {
      if (scope === generation.current && read === readGeneration.current) {
        setLoading(false)
      }
    }
  }, [client])

  useEffect(() => {
    generation.current++
    operation.current = false
    setSnapshot(null)
    setPending(false)
    setUncertain(false)
    setNotice(null)
    setKeyProvider(null)
    setKeyValue('')
    setEndpoint(emptyEndpoint())
    setAdding(false)
    setOAuth(null)
    setCode('')
    oauthRef.current = null
    void reload()

    return () => {
      retire()
      const session = oauthRef.current
      oauthRef.current = null

      if (session) {
        void client.cancelOAuth(session.session).catch(() => undefined)
      }
    }
  }, [client, reload, retire])

  const endOAuth = useCallback(
    async (status: string, scope: number) => {
      if (scope !== generation.current || status === 'pending') {
        return
      }

      oauthRef.current = null
      setOAuth(null)
      setCode('')
      setNotice(status === 'approved' ? 'applied' : status === 'cancelled' ? 'cancelled' : 'oauthFailed')

      if (status === 'approved' && !(await reload()) && scope === generation.current) {
        setUncertain(true)
      }
    },
    [reload]
  )

  useEffect(() => {
    if (!oauth || oauth.flow !== 'device_code') {
      return
    }

    const scope = generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let misses = 0
    const deadline = Date.now() + oauth.expiresIn * 1000

    const poll = async () => {
      if (disposed || oauthRef.current?.session !== oauth.session || operation.current) {
        if (!disposed) {
          timer = setTimeout(() => void poll(), oauth.pollInterval * 1000)
        }

        return
      }

      if (Date.now() >= deadline) {
        // Only this page's own sign-in ends here: a replaced client or agent retired it already.
        if (scope === generation.current) {
          oauthRef.current = null
          setOAuth(null)
          setNotice('oauthFailed')
          void client.cancelOAuth(oauth.session).catch(() => undefined)
        }

        return
      }

      try {
        const result = await client.pollOAuth(oauth.session)

        if (disposed || scope !== generation.current || oauthRef.current?.session !== oauth.session) {
          return
        }

        await endOAuth(result.status, scope)

        if (result.status !== 'pending') {
          return
        }

        misses = 0
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        misses += 1

        // The backend holding this sign-in is gone (it was replaced, or the sign-in was dropped):
        // waiting out the 15 minutes would look like nothing happening. Say it did not work.
        if (code === 'matrix_pages_agent_unavailable' || code === 'matrix_pages_request_forbidden' || misses >= 3) {
          if (!disposed && scope === generation.current && oauthRef.current?.session === oauth.session) {
            oauthRef.current = null
            setOAuth(null)
            setNotice('oauthFailed')
            void client.cancelOAuth(oauth.session).catch(() => undefined)
          }

          return
        }

        // A poll that fails after the person cancelled (or another sign-in began) says nothing:
        // "Cancelled" stays, never replaced by "failed".
        if (!disposed && scope === generation.current && oauthRef.current?.session === oauth.session) {
          setNotice('failed')
        }
      }

      if (!disposed) {
        timer = setTimeout(() => void poll(), oauth.pollInterval * 1000)
      }
    }

    timer = setTimeout(() => void poll(), oauth.pollInterval * 1000)

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [oauth, client, endOAuth])

  const submit = async (
    action: () => Promise<MatrixProviderWriteResult | MatrixProviderOAuthSession>,
    after?: () => void
  ) => {
    if (operation.current || uncertain) {
      return
    }

    operation.current = true
    const scope = generation.current
    setPending(true)
    setNotice(null)
    setStaleAux(false)

    try {
      const result = await action()

      if (scope !== generation.current) {
        return
      }

      if (result.status === 'pending') {
        oauthRef.current = result
        setOAuth(result)
      } else {
        setNotice(result.status)

        if (result.status === 'applied') {
          setStaleAux(Boolean(result.staleAux))
          after?.()

          if (!(await reload()) && scope === generation.current) {
            setUncertain(true)
          }
        }
      }
    } catch (error) {
      if (scope !== generation.current) {
        return
      }

      const busy = error instanceof Error && error.message === 'pages_agent_busy'
      setNotice(busy ? 'busy' : 'failed')

      if (!busy) {
        setUncertain(true)
      }
    } finally {
      if (scope === generation.current) {
        operation.current = false
        setPending(false)
      }
    }
  }

  const cancelOAuth = () => {
    const session = oauthRef.current

    if (!session) {
      return
    }

    // Cancellation clears the interaction synchronously; native cleanup remains
    // bound to the original backend even if this page immediately closes.
    oauthRef.current = null
    setOAuth(null)
    setCode('')
    const scope = generation.current
    operation.current = true
    setPending(true)
    void client
      .cancelOAuth(session.session)
      .then(() => {
        if (scope === generation.current) {
          setNotice('cancelled')
        }
      })
      .catch(() => {
        if (scope === generation.current) {
          setUncertain(true)
          setNotice('failed')
        }
      })
      .finally(() => {
        if (scope === generation.current) {
          operation.current = false
          setPending(false)
        }
      })
  }

  const disabled = pending || uncertain || loading || Boolean(oauth)

  return (
    <SettingsContent>
      <div
        className="contents"
        onKeyDown={event => {
          if (event.key !== 'Escape' || pending) {
            return
          }

          if (oauth) {
            cancelOAuth()
          } else if (keyProvider) {
            setKeyProvider(null)
            setKeyValue('')
          } else if (adding) {
            setAdding(false)
            setEndpoint(emptyEndpoint())
          } else {
            return
          }

          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div className="flex items-center justify-between gap-3 py-5">
          <div>
            <h1 className="text-xl font-semibold">{copy.title}</h1>
            <p className="text-xs text-(--ui-text-tertiary)">{copy.scope(agentName)}</p>
          </div>
          {onClose && (
            <Tip label={copy.close}>
              <Button aria-label={copy.close} onClick={onClose} size="icon-sm" variant="ghost">
                <X />
              </Button>
            </Tip>
          )}
        </div>
        <p className="mb-3 text-sm text-(--ui-text-secondary)">{copy.description}</p>
        <NoticeBand tone="notice">{copy.termsNote}</NoticeBand>
        {pending && (
          <NoticeBand role="status" tone="notice">
            <Spinner className="size-4 animate-spin" />
            {copy.pending}
          </NoticeBand>
        )}
        {notice && (
          <NoticeBand role="status" tone={['failed', 'oauthFailed'].includes(notice) ? 'failure' : 'notice'}>
            {copy[notice]}
          </NoticeBand>
        )}
        {uncertain && (
          <NoticeBand role="status" tone="notice">
            {copy.uncertain}
          </NoticeBand>
        )}
        {staleAux && <NoticeBand tone="notice">{copy.staleAux}</NoticeBand>}
        {loadFailed && (
          <NoticeBand role="alert" tone="failure">
            {copy.loadFailed}
          </NoticeBand>
        )}
        <Button disabled={pending || Boolean(oauth)} onClick={() => void reload()} size="sm" variant="text">
          {copy.reload}
        </Button>
        {loading && !snapshot ? (
          <SettingsSkeleton sections={[{ rows: 4 }]} />
        ) : (
          snapshot && (
            <>
              <SettingsSection icon={Cpu} title={copy.current}>
                <ListRow description={snapshot.current?.model} title={snapshot.current?.provider ?? copy.notReady} />
              </SettingsSection>
              {oauth && (
                <SettingsSection
                  icon={KeyRound}
                  title={snapshot.providers.find(row => row.id === oauth.provider)?.name ?? oauth.provider}
                >
                  <NoticeBand role="status" tone="notice">
                    {copy.oauthPending}
                  </NoticeBand>
                  {oauth.userCode && (
                    <ListRow
                      description={<span className="font-mono select-text">{oauth.userCode}</span>}
                      title={copy.userCode}
                    />
                  )}
                  {oauth.flow === 'pkce' && (
                    <form
                      className="grid gap-3"
                      onSubmit={event => {
                        event.preventDefault()

                        if (!code.trim() || operation.current) {
                          return
                        }

                        const value = code
                        setCode('')
                        const scope = generation.current
                        operation.current = true
                        setPending(true)
                        void client
                          .submitOAuth(oauth.session, value)
                          .then(result => endOAuth(result.status, scope))
                          .catch(() => {
                            if (scope === generation.current) {
                              setNotice('failed')
                              setUncertain(true)
                            }
                          })
                          .finally(() => {
                            if (scope === generation.current) {
                              operation.current = false
                              setPending(false)
                            }
                          })
                      }}
                    >
                      <label>
                        {copy.authCode}
                        <Input
                          disabled={pending || uncertain}
                          onChange={event => setCode(event.target.value)}
                          type="password"
                          value={code}
                        />
                      </label>
                      <Button disabled={pending || uncertain || !code.trim()} size="sm" type="submit">
                        {copy.submitCode}
                      </Button>
                    </form>
                  )}
                  <Button disabled={pending} onClick={cancelOAuth} size="sm" variant="text">
                    {copy.cancel}
                  </Button>
                </SettingsSection>
              )}
              <SettingsSection icon={KeyRound} title={copy.providers}>
                {!snapshot.providers.length && <EmptyState title={copy.empty} />}
                {snapshot.providers.map(row => (
                  <div key={row.id}>
                    <ProviderGroupLabel>
                      {row.name} <Pill>{row.ready ? copy.ready : copy.notReady}</Pill>
                    </ProviderGroupLabel>
                    {row.oauth?.acknowledgment && (
                      <p className="text-xs text-(--ui-text-secondary)">
                        {copy.planAcknowledged(row.oauth.acknowledgment.acknowledgedAt)}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 py-2">
                      {row.oauth?.supported && (
                        <Button
                          disabled={disabled}
                          onClick={() => void submit(() => client.startOAuth(row.id))}
                          size="sm"
                          variant="secondary"
                        >
                          {copy.signIn}
                        </Button>
                      )}
                      {row.oauth?.connected && row.oauth.disconnectable && (
                        <Button
                          disabled={disabled}
                          onClick={() => void submit(() => client.disconnectOAuth(row.id))}
                          size="sm"
                          variant="text"
                        >
                          {copy.disconnect}
                        </Button>
                      )}
                      {row.keyAvailable && (
                        <Button
                          disabled={disabled}
                          onClick={() => {
                            setKeyProvider(row.id)
                            setKeyValue('')
                          }}
                          size="sm"
                          variant="text"
                        >
                          {row.keySet ? copy.replaceKey : copy.key}
                        </Button>
                      )}
                    </div>
                    {row.oauth && !row.oauth.supported && (
                      <p className="text-xs text-(--ui-text-tertiary)">
                        {Object.hasOwn(MATRIX_PLAN_SIGN_IN_TERMS, row.id) ? copy.planNotOffered : copy.deferred}
                      </p>
                    )}
                    {keyProvider === row.id && (
                      <form
                        className="grid gap-2 py-2"
                        onSubmit={event => {
                          event.preventDefault()

                          if (!keyValue.trim()) {
                            return
                          }

                          const value = keyValue
                          setKeyValue('')
                          void submit(
                            () => client.saveKey(row.id, value),
                            () => setKeyProvider(null)
                          )
                        }}
                      >
                        <label>
                          {copy.key}
                          <Input
                            disabled={disabled}
                            onChange={event => setKeyValue(event.target.value)}
                            type="password"
                            value={keyValue}
                          />
                        </label>
                        <div className="flex gap-2">
                          <Button disabled={disabled || !keyValue.trim()} size="sm" type="submit">
                            {copy.saveKey}
                          </Button>
                          <Button
                            disabled={pending}
                            onClick={() => {
                              setKeyProvider(null)
                              setKeyValue('')
                            }}
                            size="sm"
                            type="button"
                            variant="text"
                          >
                            {copy.cancel}
                          </Button>
                        </div>
                      </form>
                    )}
                    {row.ready && row.models.length > 0 && (
                      <ListRow
                        action={
                          <ModelPickerPopover
                            busy={disabled}
                            currentId={
                              snapshot.current?.provider === row.id && row.models.includes(snapshot.current.model)
                                ? `${row.id}:${snapshot.current.model}`
                                : undefined
                            }
                            disabled={disabled}
                            label={`${copy.model} · ${row.name}`}
                            onChoose={route => void submit(() => client.selectModel(row.id, route.model))}
                            placeholder={copy.chooseModel}
                            routes={row.models.map(model =>
                              pickerRouteOf({ provider: row.id, providerLabel: row.name, model })
                            )}
                            scope={`providers:${agentName}`}
                          />
                        }
                        title={copy.model}
                      />
                    )}
                  </div>
                ))}
              </SettingsSection>
              <ProviderLocalEndpointRow
                disabled={disabled}
                onOpen={() => {
                  setAdding(true)
                  setEndpoint(emptyEndpoint())
                }}
              />
              {adding && (
                <form
                  className="grid gap-3 py-4"
                  onSubmit={event => {
                    event.preventDefault()
                    const input = endpoint
                    setEndpoint(previous => ({ ...previous, apiKey: '' }))
                    void submit(
                      () => client.addEndpoint(input),
                      () => {
                        setAdding(false)
                        setEndpoint(emptyEndpoint())
                      }
                    )
                  }}
                >
                  <label>
                    {copy.endpointName}
                    <Input
                      disabled={disabled}
                      maxLength={100}
                      onChange={event => setEndpoint(previous => ({ ...previous, name: event.target.value }))}
                      required
                      value={endpoint.name}
                    />
                  </label>
                  <label>
                    {copy.endpointUrl}
                    <Input
                      disabled={disabled}
                      maxLength={2048}
                      onChange={event => setEndpoint(previous => ({ ...previous, baseUrl: event.target.value }))}
                      required
                      type="url"
                      value={endpoint.baseUrl}
                    />
                  </label>
                  <label>
                    {copy.endpointModel}
                    <Input
                      disabled={disabled}
                      maxLength={1024}
                      onChange={event => setEndpoint(previous => ({ ...previous, model: event.target.value }))}
                      required
                      value={endpoint.model}
                    />
                  </label>
                  <label>
                    {copy.optionalKey}
                    <Input
                      disabled={disabled}
                      onChange={event => setEndpoint(previous => ({ ...previous, apiKey: event.target.value }))}
                      type="password"
                      value={endpoint.apiKey}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      disabled={disabled || !endpoint.name.trim() || !endpoint.baseUrl.trim() || !endpoint.model.trim()}
                      size="sm"
                      type="submit"
                    >
                      {copy.add}
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => {
                        setAdding(false)
                        setEndpoint(emptyEndpoint())
                      }}
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {copy.cancel}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )
        )}
      </div>
    </SettingsContent>
  )
}
