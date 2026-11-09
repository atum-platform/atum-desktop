import './link-preview-card.css'

import { useStore } from '@nanostores/react'
import { useEffect, useMemo } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { X } from '@/lib/icons'

import type { MatrixMessage } from '../../shared/matrix'
import { type MatrixLinkPreview, matrixLinkPreviewKey } from '../../shared/matrix-link-preview'

import { useChatCopy } from './chat-copy'
import {
  $matrixHiddenLinkPreviews,
  $matrixLinkPreviews,
  hideMatrixLinkPreview,
  loadMatrixLinkPreview,
  matrixMessagePreviewLink
} from './link-previews'
import { openMatrixMarkdownLink } from './markdown-host'

/**
 * The preview card under a message with a web link (Element/Slack behaviour): one per message, for
 * its first link, only in chats without end-to-end encryption. Nothing is drawn or reserved until
 * the homeserver's answer arrives, then it fades in; no answer, or one with neither a title nor a
 * picture, draws nothing.
 */
export function MatrixLinkPreviewCard({
  message,
  roomId,
  roomEncrypted,
  own
}: {
  message: MatrixMessage
  roomId: string
  roomEncrypted: boolean
  /** Your own message in a bubble chat: the card sits at the bubble's end. */
  own?: boolean
}) {
  const url = useMemo(() => matrixMessagePreviewLink(message, roomEncrypted), [message, roomEncrypted])
  const key = url ? matrixLinkPreviewKey(url, Date.now()) : null
  const hidden = useStore($matrixHiddenLinkPreviews).includes(message.id)
  const preview = useStore($matrixLinkPreviews)[key ?? '']

  useEffect(() => {
    if (key && !hidden) {
      loadMatrixLinkPreview(roomId, message.id, key)
    }
  }, [hidden, key, message.id, roomId])

  if (!key || hidden || !preview) {
    return null
  }

  return <MatrixLinkPreviewView onHide={() => hideMatrixLinkPreview(message.id)} own={own} preview={preview} />
}

/** The card itself, from a preview already in hand (the playground draws it directly too). */
export function MatrixLinkPreviewView({
  preview,
  onHide,
  own
}: {
  preview: MatrixLinkPreview
  onHide(): void
  own?: boolean
}) {
  const copy = useChatCopy()

  return (
    <div className="atum-link-preview" data-matrix-link-preview data-own={own ? true : undefined}>
      <a
        className="atum-link-preview__link"
        href={preview.url}
        onClick={event => {
          event.preventDefault()
          void openMatrixMarkdownLink(preview.url)
        }}
        rel="noreferrer"
        target="_blank"
      >
        {preview.image && (
          <img alt="" className="atum-link-preview__image" decoding="async" draggable={false} src={preview.image} />
        )}
        <span className="atum-link-preview__words">
          <span className="atum-link-preview__site">{preview.siteName ?? preview.host}</span>
          {preview.title && <span className="atum-link-preview__title">{preview.title}</span>}
          {preview.description && <span className="atum-link-preview__description">{preview.description}</span>}
        </span>
      </a>
      <Tip label={copy.hideLinkPreview}>
        <button
          aria-label={copy.hideLinkPreview}
          className="ak-iconbtn ak-iconbtn--sm atum-link-preview__hide"
          onClick={onHide}
          type="button"
        >
          <X aria-hidden className="ak-icon ak-icon--sm" />
        </button>
      </Tip>
    </div>
  )
}
