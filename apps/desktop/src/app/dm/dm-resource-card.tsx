import { useState } from 'react'

import { useI18n } from '@/i18n'
import type { AtumArtifactRef } from '@/lib/atum-artifacts'
import { File, FileText, Globe, Photo } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { selectAtumDmArtifact, setAtumDmConversationPreviewTarget } from '@/store/atum-dm-workspace'

import { canHostInPanel, type DmResource, formatResourceSize } from './dm-resources'

const RESOURCE_ICON = {
  document: FileText,
  file: File,
  image: Photo,
  page: Globe
} as const

interface DmResourceCardProps {
  conversationId: string
  own: boolean
  resource: DmResource
}

export function DmArtifactCard({
  conversationId,
  own,
  resource
}: {
  conversationId: string
  own: boolean
  resource: AtumArtifactRef
}) {
  const { t } = useI18n()

  const open = () => {
    selectAtumDmArtifact(conversationId, resource)
  }

  return (
    <div className="mt-1.5">
      <button
        aria-label={t.dm.artifact.openAria(resource.title)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-[var(--atum-r-row)] border px-2.5 py-2 text-left transition-colors',
          own
            ? 'border-(--atum-card)/25 bg-(--atum-card)/10 hover:bg-(--atum-card)/18'
            : 'border-(--atum-line) bg-(--atum-sunk) hover:bg-(--atum-hover)'
        )}
        onClick={open}
        type="button"
      >
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-[var(--atum-r-sm)]',
            own ? 'bg-(--atum-card)/15 text-(--atum-card)' : 'bg-(--atum-card) text-(--atum-ink-soft)'
          )}
        >
          <FileText aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn('block truncate text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium', own ? 'text-(--atum-card)' : 'text-(--atum-ink)')}
            title={resource.title}
          >
            {resource.title}
          </span>
          <span className={cn('block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption)', own ? 'text-(--atum-card)/65' : 'text-(--atum-ink-muted)')}>
            {resource.status === 'generating' ? t.dm.artifact.generating : resource.type}
          </span>
        </span>
        <span
          className={cn('shrink-0 text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium', own ? 'text-(--atum-card)/80' : 'text-(--atum-ink-soft)')}
        >
          {t.dm.artifact.open}
        </span>
      </button>
    </div>
  )
}

/**
 * A specialist's resource, inside the bubble that delivered it.
 *
 * Tapping it records the target under the originating conversation. The Atum
 * workspace projects that scoped target into the same PreviewPane used by the
 * agent side, without writing a hosted URL into the active Hermes session's
 * persistent preview registry.
 *
 * The panel only hosts allowlisted https origins (see `dm-resources.ts`).
 * Everything else opens in the user's own browser, which is stated on the
 * control rather than discovered by clicking it.
 */
export function DmResourceCard({ conversationId, own, resource }: DmResourceCardProps) {
  const { locale, t } = useI18n()
  const [failed, setFailed] = useState(false)
  const Icon = RESOURCE_ICON[resource.kind]
  const hostable = canHostInPanel(resource.url)
  const size = formatResourceSize(resource.sizeBytes, locale)
  const actionLabel = hostable ? t.dm.resource.open : t.dm.resource.openExternal

  const download = async () => {
    setFailed(false)

    try {
      const { url } = await window.hermesDesktop.messaging.downloadMedia(resource.id)
      await window.hermesDesktop.openExternal(url)
    } catch {
      setFailed(true)
    }
  }

  const open = () => {
    setFailed(false)

    if (!hostable) {
      void window.hermesDesktop?.openExternal(resource.url)

      return
    }

    try {
      setAtumDmConversationPreviewTarget(conversationId, {
        kind: 'url',
        label: resource.name,
        source: resource.url,
        url: resource.url
      })
    } catch {
      setFailed(true)
    }
  }

  return (
    <div className="mt-1.5">
      <button
        aria-label={t.dm.resource.openAria(resource.name)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-[var(--atum-r-row)] border px-2.5 py-2 text-left transition-colors',
          own
            ? 'border-(--atum-card)/25 bg-(--atum-card)/10 hover:bg-(--atum-card)/18'
            : 'border-(--atum-line) bg-(--atum-sunk) hover:bg-(--atum-hover)'
        )}
        onClick={open}
        type="button"
      >
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-[var(--atum-r-sm)]',
            own ? 'bg-(--atum-card)/15 text-(--atum-card)' : 'bg-(--atum-card) text-(--atum-ink-soft)'
          )}
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn('block truncate text-(length:--atum-t-body) leading-(--atum-lh-body) font-medium', own ? 'text-(--atum-card)' : 'text-(--atum-ink)')}
            title={resource.name}
          >
            {resource.name}
          </span>
          <span className={cn('block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption)', own ? 'text-(--atum-card)/65' : 'text-(--atum-ink-muted)')}>
            {[t.dm.resource.kind[resource.kind], size].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span
          className={cn('shrink-0 text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium', own ? 'text-(--atum-card)/80' : 'text-(--atum-ink-soft)')}
        >
          {actionLabel}
        </span>
      </button>
      {!own && resource.kind === 'file' && (
        <button className="mt-1 text-(length:--atum-t-caption) leading-(--atum-lh-caption) underline opacity-75" onClick={() => void download()} type="button">
          {t.dm.download}
        </button>
      )}
      {failed && (
        <p className={cn('mt-1 text-(length:--atum-t-caption) leading-(--atum-lh-caption)', own ? 'text-(--atum-card)/70' : 'text-(--atum-ink-muted)')} role="alert">
          {t.dm.resource.openFailed}
        </p>
      )}
    </div>
  )
}
