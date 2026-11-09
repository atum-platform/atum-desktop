'use client'

import { type ComponentProps, memo, useEffect, useState } from 'react'

import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { openExternalLink } from '@/lib/external-link'
import {
  downloadGatewayMediaFile,
  isInlineMediaSrc,
  isRemoteGateway,
  mediaExternalUrl,
  mediaKind,
  mediaName,
  mediaPathFromMarkdownHref,
  mediaStreamUrl,
  resolveMediaDisplaySrc
} from '@/lib/media'
import { previewTargetFromMarkdownHref } from '@/lib/preview-targets'
import { cn } from '@/lib/utils'

import { MarkdownContent, type MarkdownHost, type MarkdownTextContentProps, MarkdownTextSurface } from './markdown-surface'

async function mediaSrc(path: string): Promise<string> {
  // Stream audio/video through the custom protocol: data URLs are capped and
  // load the whole file into memory, which broke playback for larger videos.
  if (window.hermesDesktop && ['audio', 'video'].includes(mediaKind(path))) {
    return mediaStreamUrl(path)
  }

  return resolveMediaDisplaySrc(path)
}

function useOpenMediaFile(path: string) {
  const [openFailed, setOpenFailed] = useState(false)

  const open = () => {
    if (window.hermesDesktop && isRemoteGateway()) {
      setOpenFailed(false)
      void downloadGatewayMediaFile(path).catch(() => setOpenFailed(true))
    } else {
      openExternalLink(mediaExternalUrl(path))
    }
  }

  return { open, openFailed }
}

function OpenMediaFailedNote({ name }: { name: string }) {
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      Couldn&apos;t fetch {name} from the gateway (missing, unreadable, or too large).
    </span>
  )
}

function OpenMediaButton({ kind, path }: { kind: 'audio' | 'video'; path: string }) {
  const { open, openFailed } = useOpenMediaFile(path)

  return (
    <span className="block">
      <button
        className="mt-2 bg-transparent text-xs font-medium text-muted-foreground underline underline-offset-4 decoration-current/20 hover:text-foreground"
        onClick={open}
        type="button"
      >
        Open {kind} file
      </button>
      {openFailed && <OpenMediaFailedNote name={mediaName(path)} />}
    </span>
  )
}

function MediaAttachment({ path }: { path: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const { open, openFailed } = useOpenMediaFile(path)
  const kind = mediaKind(path)
  const name = mediaName(path)

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    setFailed(false)
    setSrc('')

    if (kind === 'file') {
      setFailed(true)

      return () => {
        cancelled = true
      }
    }

    void mediaSrc(path)
      .then(value => {
        if (value.startsWith('blob:')) {
          objectUrl = value
        }

        if (!cancelled) {
          setSrc(value)
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })

    return () => {
      cancelled = true

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [kind, path])

  if (kind === 'image' && src) {
    return (
      <span className="block">
        <MarkdownImage alt={name} src={src} />
      </span>
    )
  }

  if (kind === 'audio' && src) {
    return (
      <span className="my-3 block max-w-md rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <audio className="block w-full" controls onError={() => setFailed(true)} preload="metadata" src={src} />
        {failed && <OpenMediaButton kind="audio" path={path} />}
      </span>
    )
  }

  if (kind === 'video' && src) {
    return (
      <span className="my-3 block max-w-2xl rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <video
          className="block max-h-112 w-full rounded-lg bg-black"
          controls
          onError={() => setFailed(true)}
          src={src}
        />
        {failed && <OpenMediaButton kind="video" path={path} />}
      </span>
    )
  }

  return (
    <span className="wrap-anywhere">
      <a
        className="font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere"
        href="#"
        onClick={event => {
          event.preventDefault()
          open()
        }}
      >
        {failed ? `Open ${name}` : `Loading ${name}...`}
      </a>
      {openFailed && <OpenMediaFailedNote name={name} />}
    </span>
  )
}

function MarkdownImage({ className, src, alt, ...props }: ComponentProps<'img'>) {
  const rawSrc = typeof src === 'string' ? src : ''
  const [resolvedSrc, setResolvedSrc] = useState(() => (rawSrc && isInlineMediaSrc(rawSrc) ? rawSrc : ''))
  const [failed, setFailed] = useState(false)
  const { open, openFailed } = useOpenMediaFile(rawSrc)
  const name = mediaName(rawSrc || String(alt || 'image'))

  useEffect(() => {
    let cancelled = false

    setFailed(false)
    setResolvedSrc(rawSrc && isInlineMediaSrc(rawSrc) ? rawSrc : '')

    if (!rawSrc || isInlineMediaSrc(rawSrc)) {
      return () => {
        cancelled = true
      }
    }

    void resolveMediaDisplaySrc(rawSrc)
      .then(value => {
        if (!cancelled) {
          setResolvedSrc(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [rawSrc])

  if (!rawSrc) {
    return null
  }

  if (failed) {
    return (
      <span className="my-2 block text-sm text-muted-foreground">
        Couldn&apos;t load {name}.{' '}
        <button
          className="bg-transparent font-medium text-foreground underline underline-offset-4 decoration-current/20 hover:text-foreground"
          onClick={open}
          type="button"
        >
          Open image
        </button>
        {openFailed && <OpenMediaFailedNote name={name} />}
      </span>
    )
  }

  if (!resolvedSrc) {
    return <span className="my-2 block text-sm text-muted-foreground">Loading {name}...</span>
  }

  return (
    <ZoomableImage
      alt={alt}
      className={cn(
        'm-0 block h-auto w-auto max-h-(--image-preview-height) max-w-[min(100%,var(--image-preview-max-width))] rounded-lg object-contain shadow-[0_0.0625rem_0.125rem_color-mix(in_srgb,#000_4%,transparent),0_0.625rem_1.5rem_color-mix(in_srgb,#000_5%,transparent)]',
        className
      )}
      containerClassName="my-2 block w-fit max-w-full"
      slot="aui_markdown-image"
      src={resolvedSrc}
      {...props}
    />
  )
}

/** Local media paths play inline; preview targets open the preview pane. */
function desktopLink(href: string | undefined) {
  const mediaPath = mediaPathFromMarkdownHref(href)

  if (mediaPath) {
    return <MediaAttachment path={mediaPath} />
  }

  const previewTarget = previewTargetFromMarkdownHref(href)

  if (previewTarget) {
    return <PreviewAttachment source="explicit-link" target={previewTarget} />
  }

  return null
}

/** The desktop app's markdown host: its workspace files, media and preview pane. */
const DESKTOP_HOST: MarkdownHost = { renderLink: desktopLink, Image: MarkdownImage }

/**
 * Host for text another account wrote (a DM or group message). It must not own `#media:` or
 * `#preview:` links: those render an "Open <name>" control that hands an author-chosen local path
 * to the OS handler, which is the owner's authority, not the peer's. With no `renderLink`, such a
 * link falls through to the web-only policy and stays inert text.
 *
 * It owns no `Image` either: `MarkdownImage` reads the author-chosen path from disk
 * (`readFileDataUrl`) and, on failure, offers an "Open image" button that hands it to the OS. With
 * no host image, a peer's web image is shown as its link (nothing is fetched) and any other source
 * is its description only.
 */
export const PEER_MARKDOWN_HOST: MarkdownHost = {}

export function MarkdownTextContent(props: MarkdownTextContentProps) {
  return <MarkdownContent host={DESKTOP_HOST} {...props} />
}

const MarkdownTextImpl = () => {
  return <MarkdownTextSurface defer host={DESKTOP_HOST} />
}

export const MarkdownText = memo(MarkdownTextImpl)
