import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { ReportingStatus } from '../../../shared/atum-observability'

import { ListRow } from './primitives'

export function ReportingSettings() {
  const { t } = useI18n()
  const copy = t.settings.reporting
  const [status, setStatus] = useState<ReportingStatus | null>(null)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [preferenceFailed, setPreferenceFailed] = useState(false)
  const [result, setResult] = useState<'sending' | 'sent' | 'failed' | null>(null)
  useEffect(() => {
    let active = true
    const bridge = window.hermesDesktop?.reporting
    void bridge?.status().then(status => {if (active) {setStatus(status)}}).catch(() => undefined)
    const off = bridge?.onChanged(status => {if (active) {setStatus(status)}})

    return () => { active = false; off?.() }
  }, [])

  if (!status) {return null}

  const toggle = async (enabled: boolean) => {
    setSaving(true)
    setPreferenceFailed(false)

    try {
      const next = await window.hermesDesktop?.reporting?.setEnabled(enabled)

      if (next) {setStatus(next)}
    } catch {
      setPreferenceFailed(true)
      const current = await window.hermesDesktop?.reporting?.status().catch(() => null)

      if (current) {setStatus(current)}
    } finally {setSaving(false)}
  }

  const send = async () => {
    setResult('sending')

    try {
      const response = await window.hermesDesktop?.reporting?.feedback(message)
      setResult(response?.sent ? 'sent' : 'failed')

      if (response?.sent) {setMessage('')}
    } catch {setResult('failed')}
  }

  return <div className="mt-6">
    <ListRow action={<Switch aria-label={copy.title} checked={status.enabled} disabled={saving} onCheckedChange={enabled => void toggle(enabled)} />} description={copy.notice}
      hint={status.configured ? `${copy.diagnosticId}: ${status.diagnosticId}` : copy.unavailable}
      title={copy.title} />
    {preferenceFailed && <p className="text-xs text-destructive" role="status">{copy.preferenceFailed}</p>}
    <form className="mt-4 space-y-2" onSubmit={event => { event.preventDefault(); void send() }}>
      <label className="text-sm font-medium" htmlFor="atum-feedback">{copy.feedback}</label>
      <p className="text-xs text-muted-foreground" id="atum-feedback-hint">{copy.feedbackHint}</p>
      <textarea aria-describedby="atum-feedback-hint" className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm" disabled={result === 'sending'}
        id="atum-feedback" maxLength={4000} onChange={event => setMessage(event.target.value)} value={message} />
      <Button disabled={!status.configured || !message.trim() || result === 'sending'} size="sm" type="submit">{result === 'sending' ? copy.sending : copy.send}</Button>
      {result && result !== 'sending' && <p className="text-xs text-muted-foreground" role="status">{copy[result]}</p>}
    </form>
  </div>
}
