import { type FormEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { AtumAuthFailureKind } from '@/lib/atum-auth'
import { cn } from '@/lib/utils'

export type { AtumAuthFailureKind }

/** `sidebar` is the compact legacy treatment; `atum` is the full-window auth
 *  gate's roomier one. Appearance changes container/control sizing only — the
 *  validation, `aria-invalid` wiring, and messages are identical. */
export type AtumAccountFormAppearance = 'atum' | 'sidebar'

interface AtumAccountFormProps {
  appearance?: AtumAccountFormAppearance
  /** Focus the identifier field on mount (the auth gate's entry point). */
  autoFocus?: boolean
  copy: {
    identifier: string
    identifierHint: string
    identifierPlaceholder: string
    identifierRequired: string
    password: string
    passwordRequired: string
    signIn: string
    signingIn: string
  }
  failureKind: AtumAuthFailureKind
  pending: boolean
  onSubmit: (credentials: { identifier: string; password: string }) => Promise<boolean>
}

/** Ephemeral credential form: values never leave component state except for the one native IPC call. */
export function AtumAccountForm({
  appearance = 'sidebar',
  autoFocus = false,
  copy,
  failureKind,
  onSubmit,
  pending
}: AtumAccountFormProps) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ identifier?: string; password?: string }>({})
  const identifierRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const roomy = appearance === 'atum'

  // Visible labels keep empty password fields identifiable, even after typing.
  const fieldClass = roomy
    ? 'atum-input'
    : 'h-8 w-full rounded-md border border-(--ui-border) bg-(--ui-control-background) px-2 text-xs outline-none focus-visible:border-primary/60'

  const labelClass = cn(
    'block font-medium',
    roomy ? 'text-(length:--atum-t-body) text-(--atum-ink-muted)' : 'text-[0.6875rem] text-(--ui-text-secondary)'
  )

  const hintClass = roomy
    ? 'sr-only'
    : 'text-[0.6875rem] leading-4 text-(--ui-text-tertiary)'

  useEffect(() => {
    if (autoFocus) {
      identifierRef.current?.focus()
    }
  }, [autoFocus])

  useEffect(() => {
    if (failureKind === 'credentials') {
      setPassword('')
      identifierRef.current?.focus()
      identifierRef.current?.select()
    }
  }, [failureKind])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (pending) {
      return
    }

    const nextErrors = {
      ...(!identifier.trim() && { identifier: copy.identifierRequired }),
      ...(!password && { password: copy.passwordRequired })
    }

    setFieldErrors(nextErrors)

    if (nextErrors.identifier) {
      identifierRef.current?.focus()

      return
    }

    if (nextErrors.password) {
      passwordRef.current?.focus()

      return
    }

    if (await onSubmit({ identifier: identifier.trim(), password })) {
      setPassword('')
    }
  }

  return (
    <form aria-busy={pending} className={roomy ? 'space-y-2.5' : 'space-y-2'} onSubmit={event => void submit(event)}>
      <div className="space-y-1">
        <label className={labelClass} htmlFor="atum-identifier">
          {copy.identifier}
        </label>
        <p className={hintClass} id="atum-identifier-hint">
          {copy.identifierHint}
        </p>
        <input
          aria-describedby={`atum-identifier-hint${fieldErrors.identifier ? ' atum-identifier-error' : ''}`}
          aria-invalid={Boolean(fieldErrors.identifier)}
          autoCapitalize="none"
          autoComplete="username"
          className={fieldClass}
          disabled={pending}
          id="atum-identifier"
          name="identifier"
          onChange={event => {
            setIdentifier(event.target.value)

            if (fieldErrors.identifier) {
              setFieldErrors(previous => ({ ...previous, identifier: undefined }))
            }
          }}
          placeholder={copy.identifierPlaceholder}
          ref={identifierRef}
          spellCheck={false}
          type="text"
          value={identifier}
        />
        {fieldErrors.identifier && (
          <p className="text-(length:--atum-t-body) leading-4 text-(--atum-danger)" id="atum-identifier-error">
            {fieldErrors.identifier}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className={labelClass} htmlFor="atum-password">
          {copy.password}
        </label>
        <input
          aria-describedby={fieldErrors.password ? 'atum-password-error' : undefined}
          aria-invalid={Boolean(fieldErrors.password)}
          autoComplete="current-password"
          className={fieldClass}
          disabled={pending}
          id="atum-password"
          name="password"
          onChange={event => {
            setPassword(event.target.value)

            if (fieldErrors.password) {
              setFieldErrors(previous => ({ ...previous, password: undefined }))
            }
          }}
          placeholder={copy.password}
          ref={passwordRef}
          type="password"
          value={password}
        />
        {fieldErrors.password && (
          <p className="text-(length:--atum-t-body) leading-4 text-(--atum-danger)" id="atum-password-error">
            {fieldErrors.password}
          </p>
        )}
      </div>
      <Button
        className={roomy ? 'mt-1.5 h-11 w-full rounded-[var(--atum-r-input)] text-sm' : 'h-8 w-full text-xs'}
        disabled={pending}
        size={roomy ? 'default' : 'sm'}
        type="submit"
      >
        {pending ? copy.signingIn : copy.signIn}
      </Button>
    </form>
  )
}
