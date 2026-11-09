import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import { getSessionMessages, listAllProfileSessions } from '@/hermes'
import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { mediaExternalUrl } from '@/lib/media'

import { sessionRoute } from '../routes'

import { type ArtifactsPageClient, ArtifactsPresentation, type ArtifactsPresentationProps } from './presentation'

export { type ArtifactsPageClient, ArtifactsPresentation, type ArtifactsPresentationProps } from './presentation'

/** Desktop-shell adapter. The Matrix pages import ArtifactsPresentation directly
 * so their renderer never gets the legacy gateway or unrestricted file bridge. */
export function ArtifactsView({
  setStatusbarItemGroup,
  ...props
}: Omit<ArtifactsPresentationProps, 'client' | 'onOpenExternal'>) {
  const navigate = useNavigate()

  const client = useMemo<ArtifactsPageClient>(
    () => ({
      getSessionMessages: (id, profile) => getSessionMessages(id, profile),
      listSessions: () => listAllProfileSessions(30, 1)
    }),
    []
  )

  return (
    <ArtifactsPresentation
      {...props}
      client={client}
      hrefForValue={mediaExternalUrl}
      onOpenExternal={url => window.hermesDesktop?.openExternal?.(url)}
      onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
      readMedia={readDesktopFileDataUrl}
      setStatusbarItemGroup={setStatusbarItemGroup}
    />
  )
}
