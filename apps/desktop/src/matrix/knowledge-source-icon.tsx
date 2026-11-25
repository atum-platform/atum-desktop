import type { ReactNode } from 'react'

import { GoogleMark } from '@/components/brand/google-mark'
import { Briefcase, Compass, Database, Folder, Globe, Messages } from '@/lib/icons'

import { safeMatrixAgentSourceIconDataUrl } from '../../shared/matrix-agent-sources'

import type { MatrixKnowledgeSourceKind } from './knowledge-source-projection'
const ICONS: Record<Exclude<MatrixKnowledgeSourceKind, 'google'>, ReactNode> = {
  folders: <Folder aria-hidden className="size-4" />,
  messages: <Messages aria-hidden className="size-4" />,
  browser: <Globe aria-hidden className="size-4" />,
  location: <Compass aria-hidden className="size-4" />,
  teamSpaces: <Briefcase aria-hidden className="size-4" />,
  unknown: <Database aria-hidden className="size-4" />
}

export function MatrixKnowledgeSourceIcon({ kind, iconDataUrl }: { kind: MatrixKnowledgeSourceKind; iconDataUrl?: string }) {
  const safeIconDataUrl = safeMatrixAgentSourceIconDataUrl(iconDataUrl)

  if (safeIconDataUrl) {
    return (
      <span aria-hidden className="ak-appicon ak-appicon--sm">
        <img alt="" className="size-full object-cover" src={safeIconDataUrl} />
      </span>
    )
  }

  return kind === 'google' ? (
    <GoogleMark className="size-4 shrink-0" />
  ) : (
    <span aria-hidden className="shrink-0 text-(--ak-ink-3)">
      {ICONS[kind]}
    </span>
  )
}
