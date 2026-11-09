import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

import type { MatrixBotApiMessage, MatrixBotApiPhoto } from '../../../shared/matrix'

import { botApiCopy } from './bot-api-copy'
import { MatrixBotApiText } from './bot-api-text'

type Media = (input: { appId: string; roomId: string; eventId: string }) => Promise<MatrixBotApiPhoto | null>

function load(
  appId: string,
  roomId: string,
  eventId: string,
  media: Media | undefined
): Promise<MatrixBotApiPhoto | null> {
  if (!media) {
    return Promise.resolve(null)
  }

  return Promise.resolve()
    .then(() => media({ appId, roomId, eventId }))
    .then(photo => {
      if (
        !photo ||
        typeof photo.url !== 'string' ||
        !photo.url.startsWith(`data:${photo.mimeType};base64,`) ||
        !Number.isSafeInteger(photo.width) ||
        !Number.isSafeInteger(photo.height) ||
        photo.width < 1 ||
        photo.height < 1 ||
        (photo.mimeType !== 'image/jpeg' && photo.mimeType !== 'image/png' && photo.mimeType !== 'image/webp')
      ) {
        return null
      }

      return photo
    })
    .catch(() => null)
}

/**
 * One bot-api photo: a thumbnail that opens the full image, with the caption below. The bytes
 * arrive from native through the authenticated bot-api media bridge; the metadata's dimensions
 * only size the frame. A redacted or inaccessible photo says so in place instead of leaving a
 * broken image or a spinner.
 */
export function MatrixBotApiPhotoView({
  appId,
  body,
  caption,
  eventId,
  fallbackText,
  formattedBody,
  locale,
  media,
  photo,
  roomId
}: {
  appId: string
  body: string
  caption?: string
  eventId: string
  fallbackText?: string
  formattedBody?: string
  locale: string | undefined
  media?: Media
  photo: NonNullable<MatrixBotApiMessage['photo']>
  roomId: string
}) {
  const copy = botApiCopy(locale)
  const [loaded, setLoaded] = useState<MatrixBotApiPhoto | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const bridge = media ?? window.atumMatrix?.apps?.botApiMedia

  useEffect(() => {
    let live = true

    setLoaded(null)
    setFailed(false)
    void load(appId, roomId, eventId, bridge).then(value => {
      if (live) {
        setLoaded(value)
        setFailed(!value)
      }
    })

    return () => {
      live = false
    }
  }, [appId, bridge, eventId, roomId])

  const plainText = caption?.trim() || fallbackText?.trim() || body.trim()
  const label = plainText || copy.photo
  const description =
    formattedBody || caption || fallbackText ? (
      <figcaption className="text-[length:var(--atum-t-label)] text-(--atum-ink-muted)">
        <MatrixBotApiText body={plainText} formattedBody={formattedBody} />
      </figcaption>
    ) : null

  if (failed) {
    return (
      <figure className="m-0 flex max-w-[26rem] flex-col gap-1.5" data-matrix-bot-api-photo="unavailable">
        <p className="text-[length:var(--atum-t-label)] text-(--atum-ink-muted)">{copy.photoUnavailable}</p>
        {description ?? (
          <figcaption className="text-[length:var(--atum-t-label)] text-(--atum-ink-muted)">
            <MatrixBotApiText body={body} />
          </figcaption>
        )}
      </figure>
    )
  }

  if (!loaded) {
    return (
      <span
        aria-hidden
        className="block animate-pulse rounded-(--atum-r-card) bg-(--atum-sunk)"
        data-matrix-bot-api-photo="loading"
        style={{ aspectRatio: photo.width / photo.height, maxHeight: '20rem', maxWidth: '26rem', width: '100%' }}
      />
    )
  }

  return (
    <figure className="m-0 flex max-w-[26rem] flex-col gap-1.5" data-matrix-bot-api-photo>
      <button
        aria-label={copy.openPhoto}
        className="block overflow-hidden rounded-(--atum-r-card) border border-(--atum-border) bg-(--atum-sunk) focus-visible:outline-2 focus-visible:outline-(--atum-accent)"
        onClick={() => setOpen(true)}
        type="button"
      >
        <img
          alt={label}
          className="block max-h-80 w-full object-contain"
          height={loaded.height}
          loading="lazy"
          onError={() => setFailed(true)}
          src={loaded.url}
          width={loaded.width}
        />
      </button>
      {description}
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-w-[min(92vw,56rem)]" showCloseButton>
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img alt={label} className="max-h-[78vh] w-full object-contain" src={loaded.url} />
          {(formattedBody || caption || fallbackText) && (
            <div className="text-center text-sm text-(--atum-ink-muted)">
              <MatrixBotApiText body={plainText} formattedBody={formattedBody} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  )
}
