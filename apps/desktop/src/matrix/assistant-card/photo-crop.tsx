import { type PointerEvent, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

import { movePhotoFraming, photoCrop, type PhotoFraming, prepareBitmapPhoto, type PreparedPhoto } from './photo'
import { usePhotoCropCopy } from './photo-crop-copy'

interface PhotoCropDialogProps {
  file: Blob
  round?: boolean
  onCancel(): void
  onConfirm(photo: PreparedPhoto): void
}

/** One local draft. Only Use photo hands cropped bytes to the canonical avatar write. */
export function PhotoCropDialog({ file, onCancel, onConfirm, round }: PhotoCropDialogProps) {
  const copy = usePhotoCropCopy()
  const hintId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const alive = useRef(true)
  const saving = useRef(false)
  const drag = useRef<{ pointer: number; x: number; y: number; edge: number; framing: PhotoFraming }>(undefined)
  const [image, setImage] = useState<ImageBitmap>()
  const [attempt, setAttempt] = useState(0)
  const [framing, setFraming] = useState<PhotoFraming>({ x: 0.5, y: 0.5, zoom: 1 })
  const [failure, setFailure] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let current = true
    let bitmap: ImageBitmap | undefined
    alive.current = true
    setImage(undefined)
    setFailure(false)

    void createImageBitmap(file).then(
      value => {
        if (!current) {
          value.close()

          return
        }

        bitmap = value
        setImage(value)
      },
      () => {
        if (current) {setFailure(true)}
      }
    )

    return () => {
      current = false
      alive.current = false
      drag.current = undefined
      bitmap?.close()
    }
  }, [file, attempt])

  useEffect(() => {
    if (!image) {return}
    const context = canvas.current?.getContext('2d')

    if (!context) {
      setFailure(true)

      return
    }

    const crop = photoCrop(image.width, image.height, framing)
    context.clearRect(0, 0, 512, 512)
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512)
  }, [image, framing])

  const cancel = () => {
    alive.current = false
    onCancel()
  }

  const confirm = async () => {
    if (!image || saving.current || !alive.current) {return}
    saving.current = true
    setPending(true)
    setFailure(false)

    try {
      const photo = await prepareBitmapPhoto(image, photoCrop(image.width, image.height, framing))
      if (alive.current) {onConfirm(photo)}
    } catch {
      if (alive.current) {setFailure(true)}
    } finally {
      saving.current = false
      if (alive.current) {setPending(false)}
    }
  }

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointer === event.pointerId) {drag.current = undefined}
  }

  return (
    <Dialog onOpenChange={open => !open && cancel()} open>
      <DialogContent
        className="atum-sheet max-w-[27.5rem]"
        data-photo-crop
        onOpenAutoFocus={event => {
          event.preventDefault()
          dialog.current?.focus()
        }}
        ref={dialog}
        showCloseButton={false}
        tabIndex={-1}
      >
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription id={hintId}>{copy.hint}</DialogDescription>
        {image && (
          <>
            <canvas
              aria-describedby={hintId}
              aria-disabled={pending || undefined}
              aria-label={copy.position}
              className={cn(
                'mx-auto aspect-square w-full max-w-72 touch-none bg-(--atum-sunk) outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--atum-focus)',
                round ? 'rounded-full' : 'rounded-(--atum-r-avatar-lg)',
                pending ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'
              )}
              height={512}
              onKeyDown={event => {
                const directions: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
                }
                const direction = directions[event.key]
                if (!direction) {return}
                event.preventDefault()
                event.stopPropagation()
                if (pending) {return}
                const step = event.shiftKey ? 0.1 : 0.02
                setFraming(current =>
                  movePhotoFraming(image.width, image.height, current, direction[0] * step, direction[1] * step)
                )
              }}
              onLostPointerCapture={endDrag}
              onPointerCancel={endDrag}
              onPointerDown={event => {
                if (pending || event.button !== 0 || drag.current) {return}
                const edge = event.currentTarget.getBoundingClientRect().width
                if (!edge) {return}
                event.currentTarget.focus()
                event.currentTarget.setPointerCapture(event.pointerId)
                drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, edge, framing }
              }}
              onPointerMove={event => {
                const start = drag.current
                if (!start || start.pointer !== event.pointerId) {return}
                const next = movePhotoFraming(
                  image.width,
                  image.height,
                  start.framing,
                  (event.clientX - start.x) / start.edge,
                  (event.clientY - start.y) / start.edge
                )
                drag.current = { ...start, framing: next, x: event.clientX, y: event.clientY }
                setFraming(next)
              }}
              onPointerUp={endDrag}
              ref={canvas}
              role="img"
              tabIndex={0}
              width={512}
            />
            <div className="flex items-center gap-3">
              <span className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.zoom}</span>
              <Slider
                aria-label={copy.zoom}
                aria-valuetext={`${Math.round(framing.zoom * 100)}%`}
                disabled={pending}
                max={4}
                min={1}
                onValueChange={values => values[0] !== undefined &&
                  setFraming(current => ({ ...current, zoom: values[0]! }))}
                step={0.01}
                value={[framing.zoom]}
              />
            </div>
          </>
        )}
        {!image && !failure && <p role="status">{copy.loading}</p>}
        {failure && <NoticeBand role="alert" tone="failure">{copy.failed}</NoticeBand>}
        {failure && !image && (
          <Button onClick={() => setAttempt(value => value + 1)} variant="secondary">{copy.retry}</Button>
        )}
        <DialogFooter>
          <Button onClick={cancel} variant="text">{copy.cancel}</Button>
          <Button aria-busy={pending || undefined} disabled={!image || pending} onClick={() => void confirm()}>
            {copy.use}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
