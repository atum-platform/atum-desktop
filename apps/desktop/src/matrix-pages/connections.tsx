import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, Pill, SettingsContent, SettingsSection, SettingsSkeleton } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronRight, Cloud, Cpu, KeyRound, Spinner, Wrench, X } from '@/lib/icons'

import { MATRIX_ATUM_PROVIDER, matrixConnectedModelLabel } from '../../shared/matrix-models'
import type {
  MatrixProviderRow,
  MatrixProviderSettingsClient,
  MatrixProviderSnapshot,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'
import { ModelPickerPopover, pickerRouteOf } from '../matrix/model-picker-popover'

import {
  CONNECTION_KEY_SERVICES,
  CONNECTION_LOCAL_APPS,
  type ConnectionKeyService,
  type ConnectionLocalApp,
  connectionsCopy
} from './connections-copy'

const CHATGPT = 'openai-codex'

/** Where each service hands out keys: fixed pages, opened through the pages bridge. */
const KEY_PAGES: Record<ConnectionKeyService, string> = {
  'openai-api': 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openrouter: 'https://openrouter.ai/keys',
  'opencode-go': 'https://opencode.ai/auth'
}

/** The apps' own local servers (their defaults); nothing leaves this Mac. */
const LOCAL_ADDRESS: Record<ConnectionLocalApp, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1'
}

type Notice = 'applied' | 'cancelled' | 'failed' | 'busy' | 'chatgptReady' | 'chatgptFailed'

/** A connection's name as the engine requires it (letters, numbers, spaces, ._()-). */
export function localConnectionName(app: string, model: string): string {
  return `${app} ${model.replace(/[^\p{L}\p{N} ._()-]+/gu, '-')}`.slice(0, 100).trim()
}

export interface MatrixConnectionsProps {
  client: MatrixProviderSettingsClient
  agentName: string
  onClose?: () => void
  onOpenAdvanced: () => void | Promise<void>
  onOpenExternal: (url: string) => void | Promise<void>
}

/**
 * Connections: the friendly way to bring an API key or local model,
 * over the same native adapter as the full provider page (pages-providers.ts), which owns
 * every confirmation, credential write and which sign-ins are allowed. The full page stays
 * one level deeper, behind a warning.
 */
export function MatrixConnections({
  client,
  agentName,
  onClose,
  onOpenAdvanced,
  onOpenExternal
}: MatrixConnectionsProps) {
  const { locale } = useI18n()
  const copy = connectionsCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixProviderSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [keyFor, setKeyFor] = useState<ConnectionKeyService | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [localApp, setLocalApp] = useState<ConnectionLocalApp>('ollama')
  const [localModel, setLocalModel] = useState('')
  const live = useRef(true)

  const reload = useCallback(async (): Promise<MatrixProviderSnapshot | null> => {
    setLoading(true)
    setLoadFailed(false)

    try {
      const next = await client.snapshot()

      if (live.current) {
        setSnapshot(next)
      }

      return next
    } catch {
      if (live.current) {
        setLoadFailed(true)
      }

      return null
    } finally {
      if (live.current) {
        setLoading(false)
      }
    }
  }, [client])

  useEffect(() => {
    live.current = true
    void reload()

    return () => {
      live.current = false
    }
  }, [client, reload])

  /** One write at a time; the adapter refuses overlaps anyway. */
  const run = async <T extends MatrixProviderWriteResult>(action: () => Promise<T>): Promise<T | null> => {
    if (pending) {
      return null
    }

    setPending(true)
    setNotice(null)

    try {
      return await action()
    } catch (error) {
      if (live.current) {
        setNotice(error instanceof Error && error.message === 'pages_agent_busy' ? 'busy' : 'failed')
      }

      return null
    } finally {
      if (live.current) {
        setPending(false)
      }
    }
  }

  const select = async (provider: string, model: string, success: Notice = 'applied') => {
    const result = await run(() => client.selectModel(provider, model))

    if (result && live.current) {
      setNotice(result.status === 'applied' ? success : 'cancelled')
      await reload()
    }
  }

  const rowOf = (id: string): MatrixProviderRow | undefined => snapshot?.providers.find(row => row.id === id)

  const saveKey = async (service: ConnectionKeyService) => {
    const value = keyValue
    const result = await run(() => client.saveKey(service, value))

    if (result && live.current) {
      setKeyValue('')
      setNotice(result.status === 'applied' ? 'applied' : 'cancelled')

      if (result.status === 'applied') {
        setKeyFor(null)
        await reload()
      }
    }
  }

  const connectLocal = async () => {
    const model = localModel.trim()
    const name = localConnectionName(copy.localApps[localApp], model)

    if (!model || pending) {
      return
    }

    const named = (next: MatrixProviderSnapshot | null) =>
      next?.providers.find(row => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())

    // The same app and model connected before: use it again rather than add a second.
    let row = named(snapshot)

    if (!row) {
      const result = await run(() => client.addEndpoint({ name, baseUrl: LOCAL_ADDRESS[localApp], model, apiKey: '' }))

      if (!result || !live.current) {
        return
      }

      if (result.status !== 'applied') {
        setNotice('cancelled')

        return
      }

      row = named(await reload())
    }

    if (row && live.current) {
      setLocalModel('')
      await select(row.id, model)
    }
  }

  const current = snapshot?.current
  const onAtum = !current || current.provider === MATRIX_ATUM_PROVIDER
  const atum = rowOf(MATRIX_ATUM_PROVIDER)
  const chatgpt = rowOf(CHATGPT)
  // The assistant answers with ChatGPT and is signed out of it: say so, and go straight to the
  // place the sign-in lives (the full provider page).
  const signInAgain = current?.provider === CHATGPT && Boolean(chatgpt) && !chatgpt?.oauth?.connected
  const busy = pending

  const noticeText: Record<Notice, string> = {
    applied: copy.applied,
    cancelled: copy.cancelled,
    failed: copy.failed,
    busy: copy.busy,
    chatgptReady: copy.chatgptReady,
    chatgptFailed: copy.chatgptFailed
  }

  return (
    <SettingsContent>
      <div className="mx-auto max-w-2xl" data-matrix-connections>
        <div className="flex items-start justify-between gap-3 py-5">
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
        <p className="mb-5 text-sm text-(--ui-text-secondary)">{copy.intro}</p>
        {pending && (
          <NoticeBand role="status" tone="notice">
            <Spinner className="size-4 animate-spin" />
            {copy.working}
          </NoticeBand>
        )}
        {notice && !pending && (
          <NoticeBand role="status" tone={notice === 'failed' || notice === 'chatgptFailed' ? 'failure' : 'notice'}>
            {noticeText[notice]}
          </NoticeBand>
        )}
        {loadFailed && (
          <NoticeBand role="alert" tone="failure">
            {copy.loadFailed}{' '}
            <Button onClick={() => void reload()} size="sm" variant="text">
              {copy.retry}
            </Button>
          </NoticeBand>
        )}
        {loading && !snapshot ? (
          <SettingsSkeleton sections={[{ rows: 3 }, { rows: 4 }]} />
        ) : (
          snapshot && (
            <>
              <div className="mb-6 rounded-lg border border-border px-4">
                <ListRow
                  action={
                    !onAtum && atum?.ready && atum.models[0] ? (
                      <Button
                        disabled={busy}
                        onClick={() => void select(MATRIX_ATUM_PROVIDER, atum.models[0]!)}
                        size="sm"
                        variant="secondary"
                      >
                        {copy.backToAtum}
                      </Button>
                    ) : undefined
                  }
                  title={
                    <span className="flex items-center gap-2" data-matrix-connections-current>
                      <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                      {onAtum || !current ? copy.usingAtum : copy.usingConnection(matrixConnectedModelLabel(current))}
                    </span>
                  }
                />
              </div>

              {/* Says why only: the ChatGPT card right below carries the one sign-in button. */}
              {signInAgain && (
                <NoticeBand role="status" tone="notice">
                  <span className="min-w-0 flex-1" data-matrix-connections-sign-in-again>
                    {copy.chatgptSignInAgain}
                  </span>
                </NoticeBand>
              )}

              {chatgpt && (
                <SettingsSection
                  aside={chatgpt.oauth?.connected ? <Pill tone="primary">{copy.chatgptConnected}</Pill> : undefined}
                  icon={Cloud}
                  title={copy.chatgptTitle}
                >
                  <div className="rounded-lg border border-border p-4" data-matrix-connections-chatgpt>
                    <p className="text-sm text-(--ui-text-secondary)">{copy.chatgptHelp}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {/* Signed out: the sign-in itself stays on the full provider page
                          (connection-catalog.ts lets it start only there), so this goes there. */}
                      {!chatgpt.oauth?.connected && (
                        <Button
                          data-matrix-connections-chatgpt-sign-in
                          disabled={busy}
                          onClick={() => void onOpenAdvanced()}
                          size="sm"
                        >
                          {copy.chatgptSignIn}
                        </Button>
                      )}
                      {chatgpt.oauth?.connected && current?.provider !== CHATGPT && chatgpt.models[0] && (
                        <Button
                          disabled={busy}
                          onClick={() => void select(CHATGPT, chatgpt.models[0]!, 'chatgptReady')}
                          size="sm"
                        >
                          {copy.useChatgpt}
                        </Button>
                      )}
                      {chatgpt.oauth?.connected && current?.provider === CHATGPT && <Pill>{copy.inUse}</Pill>}
                      {chatgpt.oauth?.connected && chatgpt.oauth.disconnectable && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(() => client.disconnectOAuth(CHATGPT)).then(result => {
                              if (result && live.current) {
                                setNotice(result.status === 'applied' ? 'applied' : 'cancelled')
                                void reload()
                              }
                            })
                          }
                          size="sm"
                          variant="text"
                        >
                          {copy.disconnect}
                        </Button>
                      )}
                    </div>
                    <p className="mt-3 text-xs text-(--ui-text-tertiary)" data-matrix-connections-chatgpt-note>
                      {copy.chatgptNote}
                    </p>
                  </div>
                </SettingsSection>
              )}

              <SettingsSection icon={KeyRound} title={copy.keysTitle}>
                <p className="mb-2 text-sm text-(--ui-text-secondary)">{copy.keysHelp}</p>
                {CONNECTION_KEY_SERVICES.map(service => {
                  const row = rowOf(service)

                  if (!row?.keyAvailable) {
                    return null
                  }

                  const name = copy.keyNames[service]
                  const inUse = current?.provider === service

                  return (
                    <ListRow
                      action={
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {inUse && <Pill>{copy.inUse}</Pill>}
                          <Button
                            disabled={busy}
                            onClick={() => {
                              setKeyFor(keyFor === service ? null : service)
                              setKeyValue('')
                            }}
                            size="sm"
                            variant="text"
                          >
                            {row.keySet ? copy.replaceKey : copy.addKey}
                          </Button>
                        </div>
                      }
                      below={
                        <>
                          {keyFor === service && (
                            <form
                              className="mt-3 grid gap-2"
                              onSubmit={event => {
                                event.preventDefault()
                                void saveKey(service)
                              }}
                            >
                              <Input
                                aria-label={copy.keyLabel(name)}
                                autoComplete="off"
                                autoFocus
                                onChange={event => setKeyValue(event.target.value)}
                                type="password"
                                value={keyValue}
                              />
                              <div className="flex flex-wrap gap-2">
                                <Button disabled={busy || !keyValue.trim()} size="sm" type="submit">
                                  {copy.saveKey}
                                </Button>
                                <Button
                                  onClick={() => void onOpenExternal(KEY_PAGES[service])}
                                  size="sm"
                                  type="button"
                                  variant="text"
                                >
                                  {copy.whereKey}
                                </Button>
                              </div>
                            </form>
                          )}
                          {row.ready && row.models.length > 0 && !inUse && (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <ModelPickerPopover
                                busy={busy}
                                disabled={busy}
                                label={`${copy.chooseModel} · ${name}`}
                                onChoose={route => void select(service, route.model)}
                                placeholder={copy.chooseModel}
                                routes={row.models
                                  .slice(0, 200)
                                  .map(each => pickerRouteOf({ provider: service, providerLabel: name, model: each }))}
                                scope={`connections:${agentName}`}
                              />
                            </div>
                          )}
                        </>
                      }
                      description={row.keySet ? copy.keySaved : copy.keyMissing}
                      key={service}
                      title={name}
                    />
                  )
                })}
              </SettingsSection>

              <SettingsSection icon={Cpu} title={copy.localTitle}>
                <p className="mb-3 text-sm text-(--ui-text-secondary)">{copy.localHelp}</p>
                <form
                  className="grid gap-3"
                  data-matrix-connections-local
                  onSubmit={event => {
                    event.preventDefault()
                    void connectLocal()
                  }}
                >
                  <SegmentedControl
                    onChange={setLocalApp}
                    options={CONNECTION_LOCAL_APPS.map(id => ({ id, label: copy.localApps[id] }))}
                    value={localApp}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={copy.localModel}
                      className="w-64 max-w-full"
                      onChange={event => setLocalModel(event.target.value)}
                      placeholder={copy.localModelExample}
                      value={localModel}
                    />
                    <Button disabled={busy || !localModel.trim()} size="sm" type="submit" variant="secondary">
                      {copy.connectLocal}
                    </Button>
                  </div>
                </form>
              </SettingsSection>

              <SettingsSection icon={Wrench} title={copy.advancedTitle}>
                <button
                  className="flex w-full items-center gap-3 rounded-md py-2 text-start text-sm text-(--ui-text-secondary) transition-colors hover:text-foreground"
                  data-matrix-connections-open-advanced
                  disabled={busy}
                  onClick={() => void onOpenAdvanced()}
                  type="button"
                >
                  <span className="min-w-0 flex-1">{copy.advancedHelp}</span>
                  <ChevronRight aria-hidden className="size-3.5 shrink-0" />
                </button>
              </SettingsSection>
            </>
          )
        )}
      </div>
    </SettingsContent>
  )
}
