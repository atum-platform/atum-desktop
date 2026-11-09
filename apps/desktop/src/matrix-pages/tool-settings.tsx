import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, SettingsSection } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { Spinner, Terminal } from '@/lib/icons'

import { MATRIX_CAPTURE_MODES } from '../../shared/matrix-tool-settings'
import type {
  MatrixToolSetting,
  MatrixToolSettingsClient,
  MatrixToolSettingsSnapshot,
  MatrixToolSettingValue
} from '../../shared/matrix-tool-settings'
import {
  matrixTerminalBackendLabel,
  matrixToolSettingLabel,
  matrixToolSettingsCopy
} from '../../shared/matrix-tool-settings-copy'

interface MatrixToolSettingsProps {
  client: MatrixToolSettingsClient
  agentName: string
}

export function MatrixToolSettings({ client, agentName }: MatrixToolSettingsProps) {
  const { locale } = useI18n()
  const copy = (matrixToolSettingsCopy[locale] ?? matrixToolSettingsCopy.en)
  const [snapshot, setSnapshot] = useState<MatrixToolSettingsSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<MatrixToolSetting, MatrixToolSettingValue>>>({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<'updated' | 'cancelled' | 'failed' | null>(null)

  const scope = useRef(0),
    reads = useRef(0),
    busy = useRef(false)

  const load = useCallback(
    async (id: number) => {
      const read = ++reads.current
      setLoading(true)

      try {
        const value = await client.snapshot()

        if (scope.current !== id || reads.current !== read) {return false}
        setSnapshot(value)

        return true
      } catch {
        if (scope.current === id && reads.current === read) {
          setSnapshot(null)
          setOutcome('failed')
        }

        return false
      } finally {
        if (scope.current === id && reads.current === read) {setLoading(false)}
      }
    },
    [client]
  )

  useEffect(() => {
    const id = ++scope.current
    busy.current = false
    setPending(false)
    setSnapshot(null)
    setDrafts({})
    setOutcome(null)
    void load(id)

    return () => {
      scope.current += 1
      reads.current += 1
    }
  }, [agentName, load])

  const submit = async (field: MatrixToolSetting, value: MatrixToolSettingValue) => {
    if (busy.current) {return}
    const id = scope.current
    busy.current = true
    setPending(true)
    setOutcome(null)

    try {
      const result = await client.set(field, value)

      if (scope.current !== id) {return}

      if (result.status === 'cancelled') {
        setOutcome('cancelled')

        return
      }

      if (result.status !== 'applied' || result.field !== field || result.value !== value) {
        setSnapshot(null)
        setOutcome('failed')

        return
      }

      if (await load(id)) {
        if (scope.current !== id) {return}
        setDrafts(previous => {
          const next = { ...previous }
          delete next[field]

          return next
        })
        setOutcome('updated')
      } else if (scope.current === id) {setOutcome('failed')}
    } catch {
      if (scope.current === id) {
        setSnapshot(null)
        setOutcome('failed')
      }
    } finally {
      if (scope.current === id) {
        busy.current = false
        setPending(false)
      }
    }
  }

  const fields: {
    key: MatrixToolSetting
    value: MatrixToolSettingValue | null
    effect: string
    options?: { value: string; label: string }[]
  }[] = snapshot
    ? [
        {
          key: 'terminal.backend',
          value: snapshot.configuredBackend,
          effect: copy.backendEffect,
          options: snapshot.backends.map(row => ({
            value: row.id,
            label:
              matrixTerminalBackendLabel(locale, row.id) +
              ' · ' +
              (row.status === 'ready' ? copy.ready : row.status === 'needs_setup' ? copy.needsSetup : copy.unavailable)
          }))
        },
        ...(snapshot.capture.dimensionEditable
          ? [
              {
                key: 'computer_use.max_image_dimension' as const,
                value: snapshot.capture.maxImageDimension,
                effect: copy.dimensionEffect
              }
            ]
          : []),
        ...(snapshot.capture.modeEditable
          ? [
              {
                key: 'computer_use.capture_after_mode' as const,
                value: snapshot.capture.mode,
                effect: copy.modeEffect,
                options: MATRIX_CAPTURE_MODES.map(value => ({ value, label: copy.modes[value] }))
              }
            ]
          : [])
      ]
    : []

  const disabled = pending || loading

  return (
    <SettingsSection icon={Terminal} title={copy.title}>
      <div data-matrix-tool-settings>
        <p className="py-3 text-xs text-muted-foreground">{copy.help}</p>
        {outcome ? (
          <NoticeBand
            role={outcome === 'failed' ? 'alert' : 'status'}
            tone={outcome === 'failed' ? 'failure' : 'notice'}
          >
            {copy[outcome]}
          </NoticeBand>
        ) : null}
        {loading && !snapshot ? (
          <div aria-label={copy.refresh} role="status">
            <Spinner className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {fields.map(field => {
          const label = matrixToolSettingLabel(locale, field.key)
          const draft = Object.hasOwn(drafts, field.key) ? drafts[field.key]! : field.value

          const value = field.options
            ? draft
            : typeof draft === 'string'
              ? draft.trim() && Number.isFinite(Number(draft))
                ? Number(draft)
                : null
              : draft

          const valid = field.options
            ? field.options.some(option => option.value === value)
            : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4096

          const configured =
            field.value === null
              ? copy.unknown
              : field.key === 'terminal.backend'
                ? matrixTerminalBackendLabel(
                    locale,
                    field.value as NonNullable<MatrixToolSettingsSnapshot['configuredBackend']>
                  )
                : field.key === 'computer_use.capture_after_mode'
                  ? copy.modes[field.value as keyof typeof copy.modes]
                  : String(field.value)

          return (
            <ListRow
              action={
                <div className="flex w-full items-center gap-2 @2xl:w-80">
                  {field.options ? (
                    <Select
                      disabled={disabled}
                      onValueChange={value => setDrafts(previous => ({ ...previous, [field.key]: value }))}
                      value={field.options.some(option => option.value === draft) ? String(draft) : undefined}
                    >
                      <SelectTrigger aria-label={label} className="min-w-0 flex-1">
                        <SelectValue placeholder={copy.unknown} />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={label}
                      className="min-w-0 flex-1"
                      disabled={disabled}
                      inputMode="numeric"
                      onChange={event => {
                        const value = event.target.value
                        setDrafts(previous => ({ ...previous, [field.key]: value }))
                      }}
                      value={draft === null ? '' : String(draft)}
                    />
                  )}
                  <Button
                    aria-label={copy.apply + ': ' + label}
                    disabled={disabled || !valid || value === field.value}
                    onClick={() => {
                      if (valid && value !== null) {void submit(field.key, value)}
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {copy.apply}
                  </Button>
                </div>
              }
              description={copy.configured + ': ' + configured + ' · ' + field.effect}
              key={field.key}
              title={label}
            />
          )
        })}
        <div className="py-3">
          <Button
            disabled={disabled}
            onClick={() => {
              setOutcome(null)
              void load(scope.current)
            }}
            size="sm"
            variant="outline"
          >
            {copy.refresh}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}
