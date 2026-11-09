import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { $atumAppCatalog, appDisplayName, appSubtitle } from '@/lib/atum-app-catalog'

import type { AdvisorTarget, GroupAssistant } from '../../../shared/atum-group-conversations'
import { $atumAgents } from '../atum/agents'
import { AtumAssistantAvatar } from '../atum/assistant-avatar'
import { $atumAssistantDirectory } from '../atum/assistant-directory'

interface GroupParticipantIdentityProps {
  target: AdvisorTarget
  displayName: string
  status?: string
  /** Shared-room projections are authoritative over this machine's local profile cache. */
  assistant?: GroupAssistant
}

/** Presentation only: eligibility and target IDs remain server-owned. */
export function GroupParticipantIdentity({ assistant, target, displayName, status }: GroupParticipantIdentityProps) {
  const { locale, t } = useI18n()
  const agents = useStore($atumAgents)
  const directory = useStore($atumAssistantDirectory)
  const catalog = useStore($atumAppCatalog)
  const app = target.type === 'specialist' ? catalog.apps.find(candidate => candidate.app === target.id) ?? null : null
  const agent = target.type === 'assistant' ? agents.find(candidate => candidate.hostedId === target.id) : null
  const hosted = target.type === 'assistant' ? directory.entries.find(candidate => candidate.id === target.id) : null
  const name = (app ? appDisplayName(app, locale) : null) ?? assistant?.displayName ?? hosted?.displayName ?? agent?.title ?? displayName

  const description = app
    ? appSubtitle(app, locale)
    : assistant?.ownerDisplayName
      ? t.dm.group.participant.agentOwnedBy(assistant.ownerDisplayName, name)
      : agent?.description

  return (
    <span className="flex min-w-0 max-w-full items-center gap-2.5 text-left">
      <AtumAssistantAvatar
        avatarUrl={app?.icon?.url ?? assistant?.avatarUrl ?? hosted?.avatarUrl ?? agent?.avatarUrl}
        className="size-(--atum-avatar-md) shrink-0 rounded-(--atum-r-avatar) object-cover"
        id={`${target.type}:${target.id}`}
        name={name}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-(length:--atum-t-ui) leading-(--atum-lh-ui) text-(--atum-ink)">{name}</span>
        {description && (
          <span className="truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
            {description}
          </span>
        )}
        {status && (
          <span className="truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
            {status}
          </span>
        )}
      </span>
    </span>
  )
}
