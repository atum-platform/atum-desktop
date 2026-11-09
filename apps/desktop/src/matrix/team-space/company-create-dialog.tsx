import { type ChangeEvent, type FormEvent, useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { photoCrop, photoPreviewUrl, prepareBitmapPhoto, type PreparedPhoto } from '../assistant-card/photo'
import { focusDialogField, MatrixDialogHeader } from '../dialog-header'

import { useTeamSpaceCopy } from './copy'
import { useTeamSpaceLayoutCopy } from './layout-copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'

export interface CompanyCreationSetup {
  companyId: string
  defaultChannelId?: string
  description?: string
  inviteHandles: string[]
  /** Prepared through the existing square avatar pipeline; persistence needs the platform route noted by the caller. */
  logo?: PreparedPhoto
}

export interface CompanyCreateDialogProps {
  open: boolean
  onClose(): void
  onCreated(setup: CompanyCreationSetup): void
  /** Another change is running or waiting to be retried: nothing else may start. */
  blocked: boolean
  mutate: TeamSpaceMutate
  /** Joining someone else's company belongs under Add company, not beside Invite teammates. */
  onJoinInviteLink?(): void
}

const STEPS = 4
const handles = (value: string) => [...new Set(value.split(/[,\n]/u).map(item => item.trim()).filter(Boolean))]

/** One short dialog: name, optional logo, optional description, optional invitations. */
export function CompanyCreateDialog({ blocked, mutate, onClose, onCreated, onJoinInviteLink, open }: CompanyCreateDialogProps) {
  const { company, team } = useTeamSpaceCopy()
  const layout = useTeamSpaceLayoutCopy()
  const logoInputId = useId()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [logo, setLogo] = useState<PreparedPhoto>()
  const [logoPreview, setLogoPreview] = useState<string>()
  const [logoBusy, setLogoBusy] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const [description, setDescription] = useState('')
  const [inviteHandles, setInviteHandles] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (open) {
      setStep(0)
      setName('')
      setLogo(undefined)
      setLogoBusy(false)
      setLogoFailed(false)
      setDescription('')
      setInviteHandles('')
      setBusy(false)
      setError(undefined)
    }
  }, [open])

  const displayName = name.trim()

  const chooseLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {return}

    setLogoBusy(true)
    setLogoFailed(false)

    try {
      const bitmap = await createImageBitmap(file)
      const prepared = await prepareBitmapPhoto(bitmap, photoCrop(bitmap.width, bitmap.height, { x: 0.5, y: 0.5, zoom: 1 }))
      bitmap.close()
      setLogo(prepared)
      setLogoPreview(photoPreviewUrl(prepared))
    } catch {
      setLogo(undefined)
      setLogoPreview(undefined)
      setLogoFailed(true)
    } finally {
      setLogoBusy(false)
    }
  }

  const finish = async (invites = inviteHandles) => {
    if (!displayName || busy || blocked || logoBusy) {return}

    setBusy(true)
    setError(undefined)

    const outcome = await mutate({ action: 'create', requestId: globalThis.crypto.randomUUID(), displayName })

    setBusy(false)

    if (!outcome) {return}

    if (outcome.ok) {
      if ('company' in outcome.value && 'members' in outcome.value) {
        onCreated({
          companyId: outcome.value.company.id,
          ...('defaultChannelId' in outcome.value && outcome.value.defaultChannelId
            ? { defaultChannelId: outcome.value.defaultChannelId }
            : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          inviteHandles: handles(invites),
          ...(logo ? { logo } : {})
        })
        onClose()
      }

      return
    }

    // Made, but the answer was lost: the workspace keeps the exact create request and offers Retry.
    if (outcome.uncertain) {
      onClose()

      return
    }

    setError(outcomeText(outcome, team, company))
  }

  const next = () => {
    if (step === 0 && !displayName) {return}
    setError(undefined)
    setStep(value => Math.min(STEPS - 1, value + 1))
  }

  const skip = () => {
    if (step === 1) {
      setLogo(undefined)
      setLogoPreview(undefined)
    } else if (step === 2) {
      setDescription('')
    } else if (step === 3) {
      setInviteHandles('')
      void finish('')

      return
    }

    next()
  }

  const heading = [company.newCompany, layout.logoTitle, layout.descriptionTitle, layout.inviteTitle][step]!
  const body = [company.emptyBody, layout.logoBody, layout.descriptionBody, layout.inviteBody][step]!

  return (
    <Dialog onOpenChange={nextOpen => !nextOpen && !busy && !logoBusy && onClose()} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-md"
        data-company-create-step={step + 1}
        data-matrix-company-create
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <div className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{layout.creationStep(`${step + 1}/${STEPS}`)}</div>
        <MatrixDialogHeader description={body} title={heading} />
        <form className="grid gap-4" onSubmit={(event: FormEvent) => {
          event.preventDefault()

          if (step === STEPS - 1) {void finish()} else {next()}
        }}>
          {step === 0 && (
            <label className="grid gap-1 text-sm">
              <span className="text-(--atum-ink-muted)">{company.companyName}</span>
              <Input autoFocus disabled={busy} onChange={event => setName(event.target.value)} value={name} />
            </label>
          )}
          {step === 1 && (
            <div className="grid justify-items-start gap-3">
              {logoPreview && <img alt="" className="atum-avatar size-24 object-cover" src={logoPreview} />}
              <input accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={logoBusy || busy}
                id={logoInputId} onChange={event => void chooseLogo(event)} type="file" />
              <Button asChild disabled={logoBusy || busy} variant="secondary">
                <label htmlFor={logoInputId}>{logoBusy ? team.working : logoPreview ? layout.replaceLogo : layout.chooseLogo}</label>
              </Button>
              {logoFailed && <p className="text-sm text-destructive" role="alert">{layout.logoFailed}</p>}
            </div>
          )}
          {step === 2 && (
            <Input autoFocus disabled={busy} maxLength={250} onChange={event => setDescription(event.target.value)}
              placeholder={layout.descriptionPlaceholder} value={description} />
          )}
          {step === 3 && (
            <Input autoFocus disabled={busy} onChange={event => setInviteHandles(event.target.value)}
              placeholder={layout.invitePlaceholder} value={inviteHandles} />
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button disabled={busy || logoBusy} onClick={step === 0 ? onClose : () => setStep(value => value - 1)}
              type="button" variant="ghost">
              {step === 0 ? company.cancel : layout.back}
            </Button>
            {step === 0 && onJoinInviteLink && (
              <Button
                disabled={busy || logoBusy}
                onClick={() => {
                  onClose()
                  onJoinInviteLink()
                }}
                type="button"
                variant="text"
              >
                {layout.joinWithInviteLink}
              </Button>
            )}
            {step > 0 && <Button disabled={busy || logoBusy} onClick={skip} type="button" variant="text">{layout.skip}</Button>}
            <Button disabled={busy || logoBusy || blocked || (step === 0 && !displayName)} type="submit">
              {busy ? team.working : step === STEPS - 1 ? layout.finish : layout.next}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
