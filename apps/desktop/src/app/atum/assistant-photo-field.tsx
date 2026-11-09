import { type ChangeEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ATUM_AVATAR_ACCEPT } from '@/lib/atum-avatar'

import { AtumAssistantAvatar } from './assistant-avatar'

/** A staged image is local-only UI state until the upload completes. */
export function AtumAssistantPhotoField({
  avatarUrl,
  changeLabel,
  disabled,
  id,
  name,
  onChoose,
  onRemove,
  photoLabel,
  removeLabel,
  round = false,
  uploading
}: {
  avatarUrl: null | string | undefined
  changeLabel: string
  disabled: boolean
  id: string
  name: string
  onChoose: (file: File) => void
  onRemove?: () => void
  photoLabel: string
  removeLabel: string
  /** A person's photo is round, like every other picture of them; an assistant's keeps its tile. */
  round?: boolean
  uploading?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreview(null)

      return
    }

    const url = URL.createObjectURL(file)
    setPreview(url)

    return () => URL.revokeObjectURL(url)
  }, [file])

  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    event.target.value = ''

    if (!next) {
      return
    }

    setFile(next)
    onChoose(next)
  }

  return (
    <div className="flex items-center gap-3">
      {preview ? (
        <img
          alt=""
          className={`atum-avatar size-14 shrink-0 object-cover ${round ? 'rounded-full' : ''}`}
          src={preview}
        />
      ) : (
        <AtumAssistantAvatar
          avatarUrl={avatarUrl}
          className={`atum-avatar size-14 shrink-0 text-lg ${round ? 'rounded-full' : ''}`}
          id={id}
          name={name}
        />
      )}
      <div className="min-w-0 space-y-1">
        <span className="block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)">{photoLabel}</span>
        <div className="flex flex-wrap gap-1.5">
          <Button disabled={disabled} onClick={() => inputRef.current?.click()} size="sm" variant="secondary">
            {changeLabel}
          </Button>
          {avatarUrl && onRemove && !file && (
            <Button disabled={disabled} onClick={onRemove} size="sm" variant="text">
              {removeLabel}
            </Button>
          )}
        </div>
      </div>
      <input
        accept={ATUM_AVATAR_ACCEPT}
        aria-label={photoLabel}
        className="sr-only"
        data-atum-assistant-avatar-input
        disabled={disabled || uploading}
        onChange={select}
        ref={inputRef}
        type="file"
      />
    </div>
  )
}
