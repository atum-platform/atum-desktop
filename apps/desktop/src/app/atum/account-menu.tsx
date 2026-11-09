import { useStore } from '@nanostores/react'
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ATUM_AVATAR_ACCEPT,
  ATUM_AVATAR_CONTENT_TYPES,
  ATUM_AVATAR_MAX_BYTES,
  putAtumAvatarUpload
} from '@/lib/atum-avatar'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { UserCircle } from '@/lib/icons'
import { $atumAccountStatus, refreshAtumAccountStatus, signOutOfAtum } from '@/store/atum-messaging'

import { type HandleAvailabilityState, handleSaveFailure, useHandleAvailability } from './use-handle-availability'

/**
 * A consumer account surface, deliberately separate from Settings. Name and
 * username are editable through the hosted identity routes; the plane answers
 * each save with the whole identity, main adopts it, and the refreshed status
 * is what this dialog renders — no locally remembered "saved" value. Avatar and
 * photo updates keep their existing server-backed upload flow.
 */
export function AtumAccountDialog({
  children,
  triggerTip,
  open,
  onOpenChange
}: {
  children?: ReactNode
  triggerTip?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { locale, t } = useI18n()
  const account = useStore($atumAccountStatus)
  const identity = account.account
  const signedIn = account.state === 'signed_in' || account.state === 'refreshing'
  const [editing, setEditing] = useState<'name' | 'username' | null>(null)
  const [handle, setHandle] = useState('')
  const [handleFailure, setHandleFailure] = useState<HandleAvailabilityState | null>(null)
  const [claimed, setClaimed] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameState, setNameState] = useState<'idle' | 'saving' | 'failed'>('idle')
  const [saving, setSaving] = useState(false)

  const photoInputRef = useRef<HTMLInputElement>(null)

  const [photo, setPhoto] = useState<
    | { state: 'idle' }
    | { state: 'uploading'; progress: number }
    | { state: 'failed'; reason: 'too_large' | 'wrong_type' | 'failed' }
  >({ state: 'idle' })

  const availability = useHandleAvailability(handle, {
    currentHandle: identity?.handle ?? null,
    enabled: editing === 'username'
  })

  const handleState = handleFailure ?? availability.state
  useEffect(() => {
    if (!claimed) {
      return
    }

    const timer = window.setTimeout(() => setClaimed(null), 6_000)

    return () => window.clearTimeout(timer)
  }, [claimed])

  const saveHandle = async () => {
    if (availability.state !== 'available' || saving) {
      return
    }

    setSaving(true)
    setHandleFailure(null)

    try {
      const next = await atumMessagingClient().renameHandle(availability.value)
      await refreshAtumAccountStatus()
      setClaimed(next.handle ?? availability.value)
      setEditing(null)
    } catch (error) {
      setHandleFailure(handleSaveFailure(error))
    } finally {
      setSaving(false)
    }
  }

  const saveName = async () => {
    const value = name.trim()

    if (!value || value.length > 80 || saving) {
      return
    }

    setSaving(true)
    setNameState('saving')

    try {
      await atumMessagingClient().updateProfile({ displayName: value })
      await refreshAtumAccountStatus()
      setNameState('idle')
      setEditing(null)
    } catch {
      setNameState('failed')
    } finally {
      setSaving(false)
    }
  }

  // The photo path mirrors attachments: main reserves a server-chosen object
  // and hands back a short-lived signed URL, the renderer PUTs the bytes, and
  // completion is the only step that changes the profile. Type and size are
  // checked here first so a wrong file never costs a reservation.
  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (!ATUM_AVATAR_CONTENT_TYPES.includes(file.type as (typeof ATUM_AVATAR_CONTENT_TYPES)[number])) {
      setPhoto({ state: 'failed', reason: 'wrong_type' })

      return
    }

    if (file.size > ATUM_AVATAR_MAX_BYTES) {
      setPhoto({ state: 'failed', reason: 'too_large' })

      return
    }

    setPhoto({ state: 'uploading', progress: 0 })

    try {
      const client = atumMessagingClient()
      const reservation = await client.createAvatarUpload({ contentType: file.type })

      await putAtumAvatarUpload(file, reservation, progress => setPhoto({ state: 'uploading', progress }))

      await client.completeAvatarUpload(reservation.uploadId)
      await refreshAtumAccountStatus()
      setPhoto({ state: 'idle' })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setPhoto({
        state: 'failed',
        reason: code.includes('payload_too_large')
          ? 'too_large'
          : code.includes('upload_invalid')
            ? 'wrong_type'
            : 'failed'
      })
    }
  }

  const removePhoto = async () => {
    setPhoto({ state: 'uploading', progress: 0 })

    try {
      await atumMessagingClient().clearAvatar()
      await refreshAtumAccountStatus()
      setPhoto({ state: 'idle' })
    } catch {
      setPhoto({ state: 'failed', reason: 'failed' })
    }
  }

  const handleMessage =
    handleState === 'checking'
      ? t.atum.account.handleChecking
      : handleState === 'available'
        ? t.atum.account.handleAvailable
        : handleState === 'current'
          ? t.atum.account.handleCurrent
          : handleState === 'invalid'
            ? t.atum.account.handleInvalid
            : handleState === 'taken'
              ? t.atum.account.handleTaken
              : handleState === 'reserved'
                ? t.atum.account.handleReserved
                : handleState === 'cooldown'
                  ? t.atum.account.handleCooldown
                  : handleState === 'failed'
                    ? t.atum.account.handleFailed
                    : t.atum.account.handleHint

  // The plane's own answer to "when may I change this again". Absent means
  // unknown or allowed now; only a future date is worth a sentence.
  const nextChangeAt = identity?.nextHandleChangeAt ? Date.parse(identity.nextHandleChangeAt) : Number.NaN

  const nextChangeLabel =
    Number.isFinite(nextChangeAt) && nextChangeAt > Date.now()
      ? t.atum.account.handleNextChange(new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(nextChangeAt))
      : null

  const nameInvalid = !name.trim() || name.trim().length > 80

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {children &&
        (triggerTip ? (
          <TooltipProvider delayDuration={0} disableHoverableContent>
            <Tooltip disableHoverableContent>
              <TooltipTrigger asChild>
                <DialogTrigger asChild>{children}</DialogTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">{triggerTip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <DialogTrigger asChild>{children}</DialogTrigger>
        ))}
      <DialogContent className="max-w-[32.5rem]" data-atum-account-sheet onOpenAutoFocus={preventCloseButtonAutoFocus}>
        <DialogTitle className="sr-only">{t.atum.account.title}</DialogTitle>
        <DialogDescription className="sr-only">{t.atum.account.description}</DialogDescription>

        <div className="flex items-center gap-[1.125rem]">
          {identity?.avatarUrl ? (
            <img
              alt=""
              className="size-16 shrink-0 rounded-full object-cover"
              data-atum-account-avatar
              src={identity.avatarUrl}
            />
          ) : (
            <span
              aria-hidden
              className="grid size-16 shrink-0 place-items-center rounded-full bg-(--atum-sunk) text-[1.25rem] font-semibold text-(--atum-ink)"
              data-atum-account-avatar="initial"
            >
              {(identity?.displayName || identity?.handle || '').trim().charAt(0).toLocaleUpperCase() || (
                <UserCircle className="size-7 text-(--atum-ink-faint)" />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[1.25rem] font-semibold tracking-[-0.02em] text-(--atum-ink)">
              {identity?.displayName || <span className="text-(--atum-ink-muted)">{t.atum.account.unavailable}</span>}
            </div>
            <div className="mt-0.5 truncate text-(length:--atum-t-ui) text-(--atum-ink-muted)">
              {identity?.handle ? `@${identity.handle}` : t.atum.account.unavailable}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              aria-busy={photo.state === 'uploading'}
              disabled={!signedIn || photo.state === 'uploading'}
              onClick={() => photoInputRef.current?.click()}
              size="sm"
              variant="ghost"
            >
              {t.atum.account.changePhoto}
            </Button>
            {identity?.avatarUrl && (
              <Button
                disabled={photo.state === 'uploading'}
                onClick={() => void removePhoto()}
                size="sm"
                variant="text"
              >
                {t.atum.account.removePhoto}
              </Button>
            )}
          </div>
          <input
            accept={ATUM_AVATAR_ACCEPT}
            aria-label={t.atum.account.changePhoto}
            className="sr-only"
            data-atum-avatar-input
            onChange={event => void choosePhoto(event)}
            ref={photoInputRef}
            tabIndex={-1}
            type="file"
          />
        </div>
        <p className="sr-only">{t.atum.account.photoHint}</p>
        {photo.state !== 'idle' && (
          <p
            aria-live="polite"
            className={
              photo.state === 'failed'
                ? 'mt-2 text-(length:--atum-t-body) text-(--atum-danger)'
                : 'mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)'
            }
            role={photo.state === 'failed' ? 'alert' : undefined}
          >
            {photo.state === 'uploading'
              ? `${t.atum.account.photoUploading} ${photo.progress}%`
              : photo.reason === 'too_large'
                ? t.atum.account.photoTooLarge
                : photo.reason === 'wrong_type'
                  ? t.atum.account.photoWrongType
                  : t.atum.account.photoFailed}
          </p>
        )}

        <dl
          className="mt-6 grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3.5 text-(length:--atum-t-ui)"
          data-atum-account-grid
        >
          <dt className="text-(--atum-ink-muted)">{t.atum.account.name}</dt>
          {editing === 'name' ? (
            <dd className="col-span-2 min-w-0">
              <form
                className="space-y-2"
                onSubmit={event => {
                  event.preventDefault()
                  void saveName()
                }}
              >
                <input
                  aria-label={t.atum.account.name}
                  autoFocus
                  className="atum-input"
                  maxLength={80}
                  onChange={event => {
                    setNameState('idle')
                    setName(event.target.value)
                  }}
                  value={name}
                />
                <p
                  aria-live="polite"
                  className={
                    nameState === 'failed'
                      ? 'text-(length:--atum-t-body) text-(--atum-danger)'
                      : 'text-(length:--atum-t-body) text-(--atum-ink-muted)'
                  }
                  role={nameState === 'failed' ? 'alert' : undefined}
                >
                  {nameState === 'failed' ? t.atum.account.nameFailed : t.atum.account.nameHint}
                </p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditing(null)} type="button" variant="ghost">
                    {t.common.cancel}
                  </Button>
                  <Button aria-busy={saving} disabled={nameInvalid || saving} type="submit">
                    {t.atum.account.nameSave}
                  </Button>
                </div>
              </form>
            </dd>
          ) : (
            <>
              <dd className="min-w-0 truncate text-(--atum-ink)">
                {identity?.displayName || <span className="text-(--atum-ink-muted)">{t.atum.account.unavailable}</span>}
              </dd>
              <dd className="text-right">
                {signedIn && (
                  <button
                    className="text-(length:--atum-t-control) text-(--atum-ink-muted) hover:text-(--atum-ink)"
                    onClick={() => {
                      setName(identity?.displayName ?? '')
                      setNameState('idle')
                      setEditing('name')
                    }}
                    type="button"
                  >
                    {t.atum.account.editName}
                  </button>
                )}
              </dd>
            </>
          )}

          <dt className="text-(--atum-ink-muted)">{t.atum.account.username}</dt>
          {claimed ? (
            <dd className="col-span-2 min-w-0 rounded-[var(--atum-r-input)] bg-(--atum-sunk) px-3.5 py-3" role="status">
              <p className="text-(--atum-ink)">{t.atum.account.handleClaimed(claimed)}</p>
              <p className="mt-0.5 text-(length:--atum-t-body) text-(--atum-ink-muted)">
                {t.atum.account.handleClaimedHint}
              </p>
              <button
                className="mt-1.5 text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
                onClick={() => void navigator.clipboard.writeText(`@${claimed}`)}
                type="button"
              >
                {t.common.copy}
              </button>
            </dd>
          ) : editing === 'username' ? (
            <dd className="col-span-2 min-w-0">
              <form
                className="space-y-2"
                onSubmit={event => {
                  event.preventDefault()
                  void saveHandle()
                }}
              >
                <div className="atum-input flex items-center gap-1.5">
                  <span aria-hidden className="text-(--atum-ink-faint)">
                    @
                  </span>
                  <input
                    aria-label={t.atum.account.username}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-(--atum-ink) outline-none"
                    maxLength={33}
                    onChange={event => {
                      setHandleFailure(null)
                      setHandle(event.target.value.toLowerCase())
                    }}
                    spellCheck={false}
                    value={handle}
                  />
                </div>
                <p aria-live="polite" className="text-(length:--atum-t-body) text-(--atum-ink-muted)">
                  {handleMessage}
                </p>
                {nextChangeLabel && (
                  <p className="text-(length:--atum-t-body) text-(--atum-ink-faint)">{nextChangeLabel}</p>
                )}
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditing(null)} type="button" variant="ghost">
                    {t.common.cancel}
                  </Button>
                  <Button aria-busy={saving} disabled={availability.state !== 'available' || saving} type="submit">
                    {t.atum.account.handleSave}
                  </Button>
                </div>
              </form>
            </dd>
          ) : (
            <>
              <dd className="min-w-0 truncate text-(--atum-ink)">
                {identity?.handle ? (
                  `@${identity.handle}`
                ) : (
                  <span className="text-(--atum-ink-muted)">{t.atum.account.unavailable}</span>
                )}
              </dd>
              <dd className="text-right">
                {signedIn && (
                  <button
                    className="text-(length:--atum-t-control) text-(--atum-ink-muted) hover:text-(--atum-ink)"
                    onClick={() => {
                      setHandle(identity?.handle ?? '')
                      setHandleFailure(null)
                      setEditing('username')
                    }}
                    type="button"
                  >
                    {t.atum.account.editUsername}
                  </button>
                )}
              </dd>
            </>
          )}

        </dl>
        {identity?.id && (
          <div className="mt-5 text-(length:--atum-t-caption) text-(--atum-ink-faint)">
            <Button onClick={() => void navigator.clipboard.writeText(identity.id)} size="inline" type="button" variant="text">
              {t.atum.account.copyId}
            </Button>
          </div>
        )}

        <div className="mt-[1.625rem] flex items-center justify-between">
          {signedIn ? (
            <button
              className="text-(length:--atum-t-control) text-(--atum-danger) hover:underline hover:underline-offset-2"
              data-atum-sign-out
              onClick={() => void signOutOfAtum()}
              type="button"
            >
              {t.dm.signOut}
            </button>
          ) : (
            <span />
          )}
          <DialogClose asChild>
            <Button type="button">{t.common.done}</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
