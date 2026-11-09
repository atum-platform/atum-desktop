import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ListRow, Pill, SettingsContent, SettingsSection, SettingsSkeleton } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { Brain, Cpu, X } from '@/lib/icons'

import type { MatrixAuxiliaryClient } from '../../shared/matrix-auxiliary-settings'
import type { MatrixComputerUseClient } from '../../shared/matrix-computer-use'
import type { MatrixComputerUseGrantClient } from '../../shared/matrix-computer-use-grant'
import { matrixConnectedServiceName } from '../../shared/matrix-models'
import type {
  MatrixRuntimeSettingsClient,
  MatrixRuntimeSnapshot,
  MatrixRuntimeWriteResult
} from '../../shared/matrix-runtime-settings'
import type { MatrixToolSettingsClient } from '../../shared/matrix-tool-settings'
import type { MatrixVoiceSettingsClient } from '../../shared/matrix-voice-settings'
import { ModelPickerPopover, pickerRouteOf } from '../matrix/model-picker-popover'

import { MatrixAuxiliarySettings } from './auxiliary-settings'
import { MatrixComputerUseGrant } from './computer-use-grant'
import { MatrixComputerUseStatus } from './computer-use-status'
import { runtimeSettingsCopy } from './runtime-settings-copy'
import { MatrixToolSettings } from './tool-settings'
import { MatrixVoiceSettings } from './voice-settings'

const BUILTIN_MEMORY_VALUE = '__atum_builtin_memory__'

type RequestKind = 'memory' | 'model'
type Outcome = 'applied' | 'cancelled' | 'error' | 'pending' | null

function knownContext(value: MatrixRuntimeSnapshot['main']): number | null {
  return typeof value?.contextLength === 'number' && Number.isFinite(value.contextLength) ? value.contextLength : null
}

interface MatrixRuntimeSettingsProps {
  client: MatrixRuntimeSettingsClient
  agentName: string
  auxiliaryClient?: MatrixAuxiliaryClient
  computerUseClient?: MatrixComputerUseClient
  computerUseGrantClient?: MatrixComputerUseGrantClient
  voiceSettingsClient?: MatrixVoiceSettingsClient
  toolSettingsClient?: MatrixToolSettingsClient
  onClose?: () => void
}

/**
 * Presentation for exactly one native-selected local agent. It has no profile,
 * credential, provider-setup, or global configuration authority: the injected
 * client owns the scoped native operation and confirmation.
 */
export function MatrixRuntimeSettings({
  client,
  agentName,
  auxiliaryClient,
  computerUseClient,
  computerUseGrantClient,
  voiceSettingsClient,
  toolSettingsClient,
  onClose
}: MatrixRuntimeSettingsProps) {
  const { locale } = useI18n()
  const copy = runtimeSettingsCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixRuntimeSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState<RequestKind | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [staleAux, setStaleAux] = useState(false)
  const [grantEpoch, setGrantEpoch] = useState(0)
  const reconcilePermissions = useCallback(() => setGrantEpoch(value => value + 1), [])
  const mounted = useRef(false)
  const pendingRequest = useRef(false)
  const snapshotGeneration = useRef(0)

  const loadSnapshot = useCallback(async (): Promise<MatrixRuntimeSnapshot | null> => {
    const generation = ++snapshotGeneration.current

    if (mounted.current) {
      setLoading(true)
      setLoadFailed(false)
    }

    try {
      const next = await client.snapshot()

      if (!mounted.current || generation !== snapshotGeneration.current) {
        return null
      }

      setSnapshot(next)

      return next
    } catch {
      if (mounted.current && generation === snapshotGeneration.current) {
        setLoadFailed(true)
      }

      return null
    } finally {
      if (mounted.current && generation === snapshotGeneration.current) {
        setLoading(false)
      }
    }
  }, [client])

  useEffect(() => {
    mounted.current = true
    void loadSnapshot()

    return () => {
      mounted.current = false
      // Invalidate in-flight reads too, so a late initial read cannot replace
      // normalized truth obtained after a write.
      snapshotGeneration.current += 1
    }
  }, [loadSnapshot])

  const submit = useCallback(
    async (kind: RequestKind, perform: () => Promise<MatrixRuntimeWriteResult>) => {
      if (pendingRequest.current || !mounted.current) {
        return
      }

      pendingRequest.current = true
      setPending(kind)
      setOutcome('pending')
      setStaleAux(false)

      try {
        const result = await perform()

        if (!mounted.current) {
          return
        }

        if (result.status === 'cancelled') {
          setOutcome('cancelled')

          return
        }

        if (result.status !== 'applied' || result.kind !== kind) {
          setOutcome('error')

          return
        }

        setOutcome('applied')
        setStaleAux(result.kind === 'model' && result.staleAux)
        // A native ok:true only authorizes this read. The UI reports the
        // normalized current values rather than preserving an optimistic pick.
        const refreshed = await loadSnapshot()

        if (!refreshed && mounted.current) {
          setOutcome('error')
        }
      } catch {
        if (mounted.current) {
          // Never surface a native/upstream error because it can contain
          // endpoint or credential material.
          setOutcome('error')
        }
      } finally {
        pendingRequest.current = false

        if (mounted.current) {
          setPending(null)
        }
      }
    },
    [loadSnapshot]
  )

  const models = useMemo(() => [...new Set(snapshot?.models ?? [])], [snapshot?.models])
  const main = snapshot?.main ?? null
  const memory = snapshot?.memory
  const modelPickerAvailable = Boolean(main && snapshot?.modelEditable && models.length)
  const activeMemoryValue = memory?.active === '' ? BUILTIN_MEMORY_VALUE : memory?.active

  return (
    <div className="h-full min-h-0" data-matrix-runtime-settings>
      <SettingsContent>
        <header className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-foreground">{copy.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{copy.scope(agentName)}</p>
          </div>
          {onClose && (
            <Button aria-label={copy.close} onClick={onClose} size="icon-xs" type="button" variant="ghost">
              <X aria-hidden />
            </Button>
          )}
        </header>

        {loading && !snapshot ? (
          <SettingsSkeleton
            sections={[
              { heading: true, rows: 3 },
              { heading: true, rows: 2 }
            ]}
          />
        ) : null}

        {!loading && !snapshot && loadFailed ? (
          <NoticeBand role="alert">
            <span>{copy.requestError}</span>{' '}
            <Button onClick={() => void loadSnapshot()} size="inline" type="button" variant="textStrong">
              {copy.reload}
            </Button>
          </NoticeBand>
        ) : null}

        {snapshot && (
          <>
            <SettingsSection icon={Cpu} title={copy.current}>
              <div className="divide-y divide-border/70">
                <ListRow description={main?.provider || copy.unknown} title={copy.provider} />
                <ListRow
                  description={<span data-testid="runtime-current-model">{main?.model || copy.unknown}</span>}
                  title={copy.model}
                />
                <ListRow
                  description={knownContext(main) === null ? copy.unknown : copy.contextTokens(knownContext(main) ?? 0)}
                  title={copy.context}
                />
              </div>
            </SettingsSection>

            <SettingsSection icon={Cpu} title={copy.mainModel}>
              <div className="divide-y divide-border/70">
                <ListRow
                  action={
                    modelPickerAvailable && main ? (
                      <ModelPickerPopover
                        busy={Boolean(pending)}
                        currentId={models.includes(main.model) ? `${main.provider}:${main.model}` : undefined}
                        disabled={Boolean(pending)}
                        label={copy.mainModel}
                        onChoose={route => {
                          if (!models.includes(route.model) || route.model === main.model) {
                            return
                          }

                          void submit('model', () => client.setModel(main.provider, route.model))
                        }}
                        placeholder={copy.chooseModel}
                        routes={models.map(model =>
                          pickerRouteOf({
                            provider: main.provider,
                            providerLabel: matrixConnectedServiceName(main.provider),
                            model
                          })
                        )}
                        scope={`runtime-main-model:${agentName}`}
                        triggerClassName="w-full @2xl:w-72"
                      />
                    ) : undefined
                  }
                  description={
                    main && !snapshot.modelEditable
                      ? copy.modelReadOnly
                      : main && !models.length
                        ? copy.noModels
                        : undefined
                  }
                  title={copy.mainModel}
                />
                <p className="pb-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                  {copy.modelDescription}
                </p>
              </div>
            </SettingsSection>

            <SettingsSection icon={Brain} title={copy.memory}>
              <div className="divide-y divide-border/70">
                <ListRow
                  action={
                    memory ? (
                      <Select
                        disabled={Boolean(pending)}
                        onValueChange={value => {
                          const provider = value === BUILTIN_MEMORY_VALUE ? '' : value
                          const selected = memory.providers.find(candidate => candidate.name === provider)

                          if (provider === memory.active || (provider !== '' && selected?.status !== 'ready')) {
                            return
                          }

                          void submit('memory', () => client.setMemory(provider))
                        }}
                        value={activeMemoryValue}
                      >
                        <SelectTrigger aria-label={copy.activeMemory} className="w-full @2xl:w-72">
                          <SelectValue placeholder={copy.chooseMemory} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BUILTIN_MEMORY_VALUE}>{copy.builtInMemory}</SelectItem>
                          {memory.providers.map(provider => (
                            <SelectItem
                              disabled={provider.status !== 'ready'}
                              key={provider.name}
                              value={provider.name}
                            >
                              <span>{provider.name}</span>
                              <span className="ml-2 text-muted-foreground">
                                {provider.status === 'ready' ? copy.ready : copy.notReady}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : undefined
                  }
                  description={copy.memoryDescription}
                  title={copy.activeMemory}
                />
                {memory?.providers.map(provider => (
                  <ListRow
                    action={
                      <Pill tone={provider.status === 'ready' ? 'primary' : 'muted'}>
                        {provider.status === 'ready' ? copy.ready : copy.notReady}
                      </Pill>
                    }
                    description={provider.description}
                    key={provider.name}
                    title={provider.name}
                  />
                ))}
              </div>
            </SettingsSection>
          </>
        )}

        {auxiliaryClient && <MatrixAuxiliarySettings agentName={agentName} client={auxiliaryClient} />}
        {voiceSettingsClient && <MatrixVoiceSettings agentName={agentName} client={voiceSettingsClient} />}

        {computerUseClient && (
          <MatrixComputerUseStatus agentName={agentName} client={computerUseClient} key={grantEpoch} />
        )}
        {computerUseClient && computerUseGrantClient && (
          <MatrixComputerUseGrant grantClient={computerUseGrantClient} onTerminal={reconcilePermissions} />
        )}

        {toolSettingsClient && <MatrixToolSettings agentName={agentName} client={toolSettingsClient} />}

        {outcome && (
          <NoticeBand role={outcome === 'error' ? 'alert' : 'status'} tone={outcome === 'error' ? 'failure' : 'notice'}>
            {outcome === 'pending'
              ? copy.pending
              : outcome === 'cancelled'
                ? copy.cancelled
                : outcome === 'applied'
                  ? copy.applied
                  : loadFailed
                    ? copy.refreshError
                    : copy.requestError}
          </NoticeBand>
        )}
        {staleAux && (
          <NoticeBand role="status" tone="notice">
            {copy.staleAux}
          </NoticeBand>
        )}
      </SettingsContent>
    </div>
  )
}
