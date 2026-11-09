import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import {
  type AppSurfaceResult,
  type AtumAppSurfaceClient,
  atumAppSurfaceClient,
  type IntakeFieldSpec,
  type IntakeStatus,
  isAppSurfaceFailure
} from '@/lib/atum-app-surfaces'

import { appOnboardingCopy } from '../../../shared/matrix-app-onboarding-copy'

import { intakeFieldLabel, type IntakeValues, missingIntakeValues, normalizeIntakeValues } from './dm-app-gate'

type Phase = 'error' | 'form' | 'loading'

interface DmIntakeDialogProps {
  appId: string
  appName: string
  /** Alternate native authority for the same intake contract (for example the Matrix window). */
  client?: Pick<AtumAppSurfaceClient, 'intakeStatus' | 'submitIntake'>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired once the app reports it has everything it needs. */
  onComplete: () => void
}

/**
 * The app-declared intake form, as a modal over the conversation it gates.
 *
 * THE FORM IS THE DECLARATION. Every control here comes from what the server
 * said is missing — this file contains no field name, no field order, and no
 * app name. An app that declares nothing produces an empty field list and this
 * dialog is never mounted (see `mayShowIntake` in `dm-app-gate.ts`); an app
 * that adds a sixth field gets a sixth control with no client release.
 *
 * Chrome is the shared `Dialog`, which `styles.css` already re-materials for
 * the Atum shell — a hand-rolled plate here would be a second, drifting glass
 * surface, and the design contract counts those.
 */
export function DmIntakeDialog({ appId, appName, client, open, onOpenChange, onComplete }: DmIntakeDialogProps) {
  const { locale, t } = useI18n()
  const onboarding = appOnboardingCopy(locale)
  const defaultClient = useMemo(() => atumAppSurfaceClient(), [])
  const intakeClient = client ?? defaultClient
  const [phase, setPhase] = useState<Phase>('loading')
  const [fields, setFields] = useState<IntakeFieldSpec[]>([])
  const [values, setValues] = useState<IntakeValues>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    setPhase('loading')
    setFormError('')

    let result: AppSurfaceResult<IntakeStatus>

    try {
      result = await intakeClient.intakeStatus(appId)
    } catch {
      setPhase('error')

      return
    }

    if (isAppSurfaceFailure(result)) {
      setPhase('error')

      return
    }

    if (result.complete) {
      onComplete()
      onOpenChange(false)

      return
    }

    setFields(result.fields)
    setValues(current => {
      const next: IntakeValues = {}

      for (const field of result.fields) {
        next[field.name] = current[field.name] ?? ''
      }

      return next
    })
    setPhase('form')
  }, [appId, intakeClient, onComplete, onOpenChange])

  useEffect(() => {
    if (open) {
      void load()
    }
  }, [load, open])

  const updateField = (name: string, value: string) => {
    setValues(current => ({ ...current, [name]: value }))
    setFieldErrors(current => {
      if (!current[name]) {
        return current
      }

      const next = { ...current }
      delete next[name]

      return next
    })
    setFormError('')
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const blank = missingIntakeValues(fields, values)

    if (blank.length > 0) {
      setFieldErrors(Object.fromEntries(blank.map(name => [name, t.dm.intake.required])))

      return
    }

    setPending(true)
    setFieldErrors({})
    setFormError('')

    let result: AppSurfaceResult<IntakeStatus>

    try {
      result = await intakeClient.submitIntake(appId, normalizeIntakeValues(fields, values))
    } catch {
      setPending(false)
      setFormError(t.dm.intake.submitFailed)

      return
    }

    setPending(false)

    if (isAppSurfaceFailure(result)) {
      // The app can point at one field; anything else is a form-level failure.
      // The upstream message itself is never shown — main dropped it, and this
      // copy is ours.
      if (result.field && fields.some(field => field.name === result.field)) {
        const errors = onboarding.intake.invalid
        const message = Object.hasOwn(errors, result.field)
          ? errors[result.field as keyof Omit<typeof errors, 'generic'>]
          : errors.generic

        setFieldErrors({ [result.field]: message })
      } else {
        setFormError(t.dm.intake.submitFailed)
      }

      return
    }

    if (result.complete) {
      onComplete()
      onOpenChange(false)

      return
    }

    // Accepted, but the app still wants more. Re-render from its new answer
    // rather than assuming the form we just submitted was the whole story.
    setFields(result.fields)
    setFormError(t.dm.intake.submitFailed)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent aria-busy={phase === 'loading' || pending} className="max-w-lg">
        <DialogHeader>
          <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-semibold uppercase tracking-[0.08em] text-(--atum-ink-faint)">
            {t.dm.intake.eyebrow}
          </p>
          <DialogTitle>{t.dm.intake.title(appName)}</DialogTitle>
          <DialogDescription>{t.dm.intake.description}</DialogDescription>
        </DialogHeader>

        {phase === 'loading' && (
          <p className="py-8 text-center text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink-muted)" role="status">
            {t.dm.intake.loading}
          </p>
        )}

        {phase === 'error' && (
          <div className="py-8 text-center">
            <p className="text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink-muted)" role="alert">
              {t.dm.intake.loadFailed}
            </p>
            <Button className="mt-4" onClick={() => void load()} size="sm" variant="outline">
              {t.dm.intake.retry}
            </Button>
          </div>
        )}

        {phase === 'form' && (
          <form className="grid gap-4 py-1" id="atum-app-intake-form" noValidate onSubmit={event => void submit(event)}>
            {fields.map(field => {
              const error = fieldErrors[field.name]
              const errorId = `atum-intake-${field.name}-error`
              const help = field.name === 'birth_time' ? onboarding.intake.birthTimeHelp : ''
              const helpId = `atum-intake-${field.name}-help`
              const describedBy = [help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
              const label = intakeFieldLabel(field)

              return (
                <div className="grid gap-1.5" key={field.name}>
                  <label className="text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium text-(--atum-ink)" htmlFor={`atum-intake-${field.name}`}>
                    {label}
                  </label>
                  {field.type === 'select' ? (
                    <Select onValueChange={value => updateField(field.name, value)} value={values[field.name] ?? ''}>
                      <SelectTrigger
                        aria-describedby={describedBy}
                        aria-invalid={Boolean(error)}
                        aria-label={label}
                        id={`atum-intake-${field.name}`}
                      >
                        <SelectValue placeholder={field.placeholder ?? t.dm.intake.choose} />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label ?? option.value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-describedby={describedBy}
                      aria-invalid={Boolean(error)}
                      autoComplete="off"
                      id={`atum-intake-${field.name}`}
                      onChange={event => updateField(field.name, event.target.value)}
                      placeholder={field.placeholder ?? undefined}
                      type={field.type}
                      value={values[field.name] ?? ''}
                    />
                  )}
                  {help && (
                    <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)" id={helpId}>
                      {help}
                    </span>
                  )}
                  {error && (
                    <span className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-danger)" id={errorId}>
                      {error}
                    </span>
                  )}
                </div>
              )
            })}
            {formError && (
              <NoticeBand role="alert">{formError}</NoticeBand>
            )}
          </form>
        )}

        {phase === 'form' && (
          <DialogFooter>
            <Button disabled={pending} form="atum-app-intake-form" type="submit">
              {pending ? t.dm.intake.submitting : t.dm.intake.submit}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
