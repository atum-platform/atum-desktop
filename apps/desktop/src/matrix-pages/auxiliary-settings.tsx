import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, SettingsSection } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { Cpu } from '@/lib/icons'

import { matrixAuxiliaryCopy } from '../../shared/matrix-auxiliary-copy'
import type {
  MatrixAuxiliaryClient,
  MatrixAuxiliarySnapshot,
  MatrixAuxiliaryTask
} from '../../shared/matrix-auxiliary-settings'

const choice = (provider: string, model: string) => JSON.stringify([provider, model])

interface MatrixAuxiliarySettingsProps {
  client: MatrixAuxiliaryClient
  agentName: string
}

export function MatrixAuxiliarySettings({ client, agentName }: MatrixAuxiliarySettingsProps) {
  const { locale } = useI18n()
  const copy = matrixAuxiliaryCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixAuxiliarySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<'applied' | 'cancelled' | 'saveError' | 'loadError' | null>(null)
  const scope = useRef(0)
  const reads = useRef(0)
  const busy = useRef(false)

  const load = useCallback(
    async (scopeId: number): Promise<boolean> => {
      const readId = ++reads.current
      setLoading(true)

      try {
        const value = await client.snapshot()

        if (scope.current !== scopeId || reads.current !== readId) {
          return false
        }

        setSnapshot(value)

        return true
      } catch {
        if (scope.current === scopeId && reads.current === readId) {
          setSnapshot(null)
          setOutcome('loadError')
        }

        return false
      } finally {
        if (scope.current === scopeId && reads.current === readId) {
          setLoading(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    const id = ++scope.current
    busy.current = false
    setPending(false)
    setSnapshot(null)
    setOutcome(null)
    void load(id)

    return () => {
      scope.current += 1
      reads.current += 1
    }
  }, [agentName, load])

  const submit = async (task: MatrixAuxiliaryTask, provider: string, model: string) => {
    if (busy.current) {
      return
    }

    const id = scope.current
    busy.current = true
    setPending(true)
    setOutcome(null)

    try {
      const result = await client.set(task, provider, model)

      if (scope.current !== id) {
        return
      }

      if (result.status === 'cancelled') {
        setOutcome('cancelled')

        return
      }

      if (
        result.status !== 'applied' ||
        result.task !== task ||
        result.provider !== provider ||
        result.model !== model
      ) {
        setSnapshot(null)
        setOutcome('saveError')

        return
      }

      if (await load(id)) {
        if (scope.current === id) {setOutcome('applied')}
      } else if (scope.current === id) {
        setOutcome('saveError')
      }
    } catch {
      if (scope.current === id) {
        setSnapshot(null)
        setOutcome('saveError')
      }
    } finally {
      if (scope.current === id) {
        busy.current = false
        setPending(false)
      }
    }
  }

  const options = [
    { provider: 'auto', model: '', label: copy.automatic },
    ...(snapshot?.providers.flatMap(provider =>
      provider.models.map(model => ({ provider: provider.id, model, label: `${provider.id} / ${model}` }))
    ) ?? [])
  ]

  return (
    <SettingsSection icon={Cpu} title={copy.title}>
      <div data-matrix-auxiliary-settings>
        <p className="px-4 py-3 text-xs text-muted-foreground">{copy.help}</p>
        {loading && !snapshot ? (
          <p className="px-4 py-3 text-xs text-muted-foreground" role="status">
            {copy.refresh}…
          </p>
        ) : null}
        {outcome ? (
          <NoticeBand role={outcome.endsWith('Error') ? 'alert' : 'status'}>{copy[outcome]}</NoticeBand>
        ) : null}
        <div className="divide-y divide-border/70">
          {snapshot?.tasks.map(row => (
            <ListRow
              action={
                <Select
                  disabled={pending || loading}
                  onValueChange={value => {
                    const option = options.find(option => choice(option.provider, option.model) === value)

                    if (!option || (row.provider === option.provider && row.model === option.model)) {
                      return
                    }

                    void submit(row.task, option.provider, option.model)
                  }}
                  value={
                    options.some(option => option.provider === row.provider && option.model === row.model)
                      ? choice(row.provider, row.model)
                      : undefined
                  }
                >
                  <SelectTrigger aria-label={`${copy.tasks[row.task]}: ${copy.choose}`} className="w-full @2xl:w-72">
                    <SelectValue placeholder={copy.choose} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map(option => (
                      <SelectItem
                        key={choice(option.provider, option.model)}
                        value={choice(option.provider, option.model)}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
              description={row.provider === 'auto' && !row.model ? copy.automatic : `${row.provider} / ${row.model}`}
              key={row.task}
              title={copy.tasks[row.task]}
            />
          ))}
        </div>
        <div className="px-4 py-3">
          <Button
            disabled={pending || loading}
            onClick={() => {
              setOutcome(null)
              void load(scope.current)
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.refresh}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}
