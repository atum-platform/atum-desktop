import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { matrixProfileMxc } from '../../../shared/matrix-profile'
import { photoCrop, photoPreviewUrl, prepareBitmapPhoto, type PreparedPhoto } from '../assistant-card/photo'

import { useTeamSpaceCopy } from './copy'
import { useTeamSpaceLayoutCopy } from './layout-copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'

export interface CompanyAvatarSettingsProps {
  avatarUrl?: string
  blocked: boolean
  bridge: MatrixCompanyBridge
  companyId: string
  mutate: TeamSpaceMutate
  onUploadBusyChange(busy: boolean): void
  settlement?: { requestId: string; ok: boolean }
}

/** Owner/admin company identity. Matrix upload happens first; only the MXC URI enters the mutation journal. */
export function CompanyAvatarSettings({
  avatarUrl,
  blocked,
  bridge,
  companyId,
  mutate,
  onUploadBusyChange,
  settlement
}: CompanyAvatarSettingsProps) {
  const { company, team } = useTeamSpaceCopy()
  const copy = useTeamSpaceLayoutCopy()
  const inputId = useId()
  const [photo, setPhoto] = useState<PreparedPhoto>()
  const [preview, setPreview] = useState<string>()
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const pendingRequestId = useRef<string | undefined>(undefined)

  useEffect(() => {
    setPhoto(undefined)
    setPreview(undefined)
    setStatus(undefined)
    setError(undefined)
  }, [companyId])

  useEffect(() => {
    if (!settlement || settlement.requestId !== pendingRequestId.current) {return}

    pendingRequestId.current = undefined
    setPhoto(undefined)

    if (settlement.ok) {
      setStatus(copy.logoSaved)
    } else {
      setPreview(undefined)
    }
  }, [copy.logoSaved, settlement])

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {return}

    setPreparing(true)
    setStatus(undefined)
    setError(undefined)

    try {
      const bitmap = await createImageBitmap(file)
      const prepared = await prepareBitmapPhoto(bitmap, photoCrop(bitmap.width, bitmap.height, { x: 0.5, y: 0.5, zoom: 1 }))
      bitmap.close()
      setPhoto(prepared)
      setPreview(photoPreviewUrl(prepared))
    } catch {
      setPhoto(undefined)
      setPreview(undefined)
      setError(copy.logoFailed)
    } finally {
      setPreparing(false)
    }
  }

  const save = async () => {
    if (!photo || !bridge.uploadAvatar || busy || blocked) {return}

    setBusy(true)
    onUploadBusyChange(true)
    setStatus(undefined)
    setError(undefined)

    try {
      const avatarUri = matrixProfileMxc(await bridge.uploadAvatar(photo))

      if (!avatarUri) {throw new Error('matrix_company_avatar_unavailable')}
      const requestId = globalThis.crypto.randomUUID()
      pendingRequestId.current = requestId
      const outcome = await mutate({ action: 'set-avatar', companyId, requestId, avatarUri })

      if (!outcome) {return}
      if (outcome.ok) {
        setPhoto(undefined)
        setStatus(copy.logoSaved)

        return
      }

      setError(outcomeText(outcome, team, company))

      if (!outcome.uncertain) {
        setPhoto(undefined)
        setPreview(undefined)
      }
    } catch {
      // Upload failure is safe to retry with the prepared bytes; no company mutation was sent.
      setError(copy.logoUploadFailed)
    } finally {
      setBusy(false)
      onUploadBusyChange(false)
    }
  }

  return (
    <section className="grid gap-3" data-matrix-company-avatar-settings>
      <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{copy.companyLogo}</h3>
      {(preview || avatarUrl) ? (
        <img alt="" className="atum-avatar size-16 object-cover" src={preview ?? avatarUrl} />
      ) : null}
      <input accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy || preparing}
        id={inputId} onChange={event => void choose(event)} type="file" />
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild disabled={busy || preparing} variant="secondary">
          <label htmlFor={inputId}>{preparing ? team.working : preview || avatarUrl ? copy.replaceLogo : copy.chooseLogo}</label>
        </Button>
        {photo && (
          <Button disabled={blocked || busy || preparing} onClick={() => void save()}>
            {busy ? team.working : copy.saveLogo}
          </Button>
        )}
      </div>
      {status && <p className="text-sm text-(--atum-ink-muted)" role="status">{status}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </section>
  )
}
