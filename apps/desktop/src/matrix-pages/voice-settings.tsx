import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, SettingsSection } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Mic, Spinner } from '@/lib/icons'

import type {
  MatrixVoiceSettingField,
  MatrixVoiceSettingKey,
  MatrixVoiceSettingsClient,
  MatrixVoiceSettingsSnapshot,
  MatrixVoiceSettingValue
} from '../../shared/matrix-voice-settings'
import { matrixVoiceFieldLabel, matrixVoiceSettingsCopy } from '../../shared/matrix-voice-settings-copy'

interface MatrixVoiceSettingsProps {
  client: MatrixVoiceSettingsClient
  agentName: string
}

function candidate(
  field: MatrixVoiceSettingField,
  draft: MatrixVoiceSettingValue | null
): MatrixVoiceSettingValue | null {
  if (field.type === 'number' && typeof draft === 'string')
    {return draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : null}

  return draft
}

function valid(
  field: MatrixVoiceSettingField,
  value: MatrixVoiceSettingValue | null
): value is MatrixVoiceSettingValue {
  if (field.type === 'boolean') {return typeof value === 'boolean'}

  if (field.options) {return field.options.some(option => value === option)}

  if (field.type === 'string') {return typeof value === 'string' && value.length <= 1024 && !/[\p{Cc}]/u.test(value)}

  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!field.integer || Number.isSafeInteger(value)) &&
    (field.min === undefined || value >= field.min) &&
    (field.max === undefined || value <= field.max)
  )
}

export function MatrixVoiceSettings({ client, agentName }: MatrixVoiceSettingsProps) {
  const { locale } = useI18n()
  const copy = matrixVoiceSettingsCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixVoiceSettingsSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<MatrixVoiceSettingKey, MatrixVoiceSettingValue>>>({})
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<'applied' | 'cancelled' | 'failed' | null>(null)
  const scope = useRef(0)
  const reads = useRef(0)
  const busy = useRef(false)

  const load = useCallback(
    async (scopeId: number) => {
      const read = ++reads.current
      setLoading(true)

      try {
        const next = await client.snapshot()

        if (scope.current !== scopeId || reads.current !== read) {return false}
        setSnapshot(next)

        return true
      } catch {
        if (scope.current === scopeId && reads.current === read) {
          setSnapshot(null)
          setOutcome('failed')
        }

        return false
      } finally {
        if (scope.current === scopeId && reads.current === read) {setLoading(false)}
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

  const submit = async (field: MatrixVoiceSettingKey, value: MatrixVoiceSettingValue) => {
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
        setOutcome('applied')
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

  const selected = (key: MatrixVoiceSettingKey) =>
    Object.hasOwn(drafts, key) ? drafts[key] : snapshot?.fields.find(field => field.key === key)?.value

  const disabled = pending || loading

  const fields =
    snapshot?.fields.filter(field => {
      const [section, provider] = field.key.split('.')

      return (
        field.key.split('.').length < 3 || provider === selected(section === 'stt' ? 'stt.provider' : 'tts.provider')
      )
    }) ?? []

  return (
    <SettingsSection icon={Mic} title={copy.title}>
      <div data-matrix-voice-settings>
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
          <div aria-label={copy.refresh} className="px-4 py-3" role="status">
            <Spinner className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {snapshot && !fields.length ? <p className="px-4 py-3 text-xs text-muted-foreground">{copy.empty}</p> : null}
        <div>
          {fields.map(field => {
            const label = matrixVoiceFieldLabel(locale, field.key)
            const draft = Object.hasOwn(drafts, field.key) ? drafts[field.key]! : field.value
            const value = candidate(field, draft)

            const setDraft = (value: MatrixVoiceSettingValue) =>
              setDrafts(previous => ({ ...previous, [field.key]: value }))

            const control =
              field.type === 'boolean' ? (
                <Switch
                  aria-label={label}
                  checked={draft === true}
                  disabled={disabled}
                  onCheckedChange={setDraft}
                  size="xs"
                />
              ) : field.options ? (
                <Select
                  disabled={disabled}
                  onValueChange={choice => {
                    const option = field.options!.find(option => JSON.stringify(option) === choice)

                    if (option !== undefined) {setDraft(option)}
                  }}
                  value={field.options.some(option => option === draft) ? JSON.stringify(draft) : undefined}
                >
                  <SelectTrigger aria-label={label} className="min-w-0 flex-1">
                    <SelectValue placeholder={copy.choose} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map(option => (
                      <SelectItem key={JSON.stringify(option)} value={JSON.stringify(option)}>
                        {String(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  aria-label={label}
                  className="min-w-0 flex-1"
                  disabled={disabled}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  onChange={event => setDraft(event.target.value)}
                  value={draft === null ? '' : String(draft)}
                />
              )

            return (
              <ListRow
                action={
                  <div className="flex w-full items-center gap-2 @2xl:w-80">
                    {control}
                    <Button
                      aria-label={`${copy.apply}: ${label}`}
                      disabled={disabled || !valid(field, value) || value === field.value}
                      onClick={() => {
                        if (valid(field, value)) {void submit(field.key, value)}
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {copy.apply}
                    </Button>
                  </div>
                }
                description={`${copy.saved}: ${field.value === null ? copy.unknown : String(field.value)}`}
                key={field.key}
                title={label}
              />
            )
          })}
        </div>
        <div className="px-4 py-3">
          <Button
            disabled={disabled}
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
