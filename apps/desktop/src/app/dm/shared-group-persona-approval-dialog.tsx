import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { Spinner } from '@/lib/icons'
import { refreshProfiles } from '@/store/profile'

import type { GroupAssistant } from '../../../shared/atum-group-conversations'
import type { SharedGroupPersonaPreview } from '../../../shared/atum-shared-group'
import { $atumAgents } from '../atum/agents'
import { refreshAtumAssistantDirectory } from '../atum/assistant-directory'

import { GroupParticipantIdentity } from './group-participant-identity'
import { $groupCapabilities, refreshGroupCapabilities } from './group-state'

export interface SharedGroupPersonaApprovalDialogProps {
  assistant: GroupAssistant
  onChanged?: () => Promise<void> | void
  onOpenChange: (open: boolean) => void
  open: boolean
}

async function profileForAssistant(assistantId: string): Promise<string> {
  const registered = await atumMessagingClient().listAssistants()
  const identityId = registered.find(row => row.id === assistantId && row.status === 'active')?.identityId?.trim()

  let agent = identityId ? $atumAgents.get().find(candidate => candidate.identityId === identityId) : undefined

  if (!agent && identityId) {
    await refreshProfiles()
    agent = $atumAgents.get().find(candidate => candidate.identityId === identityId)
  }

  if (!agent) {
    throw new Error('shared_group_owned_agent_unavailable')
  }

  return agent.id
}

/** Deliberate local-device binding; main independently authorizes every request. */
export function SharedGroupPersonaApprovalDialog({
  assistant,
  onChanged,
  onOpenChange,
  open
}: SharedGroupPersonaApprovalDialogProps) {
  const { t } = useI18n()
  const copy = t.dm.group.persona
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [preview, setPreview] = useState<SharedGroupPersonaPreview | null>(null)
  const [profile, setProfile] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [connected, setConnected] = useState(false)
  const request = useRef(0)
  const capabilities = useStore($groupCapabilities)
  // Unknown capability is not a disabled rollout. The service remains the
  // authority if its capability preview is unavailable during a retry.
  const sharingDisabled = capabilities?.sharedAgents?.enabled === false
  const offline = assistant.availability === 'assistant_offline'
  const bound = assistant.availability === 'available' || offline

  useEffect(() => {
    if (!open) {
      return
    }

    const bridge = window.hermesDesktop?.atumSharedGroups

    if (!bridge) {
      setLoading(false)
      setPreview(null)
      setProfile(null)
      setFailed(true)

      return
    }

    const current = ++request.current
    setLoading(true)
    setMutating(false)
    setFailed(false)
    setPreview(null)
    setProfile(null)
    setConnected(false)

    void refreshGroupCapabilities().catch(() => {
      if (request.current === current) {
        setFailed(true)
      }
    })

    void profileForAssistant(assistant.assistantId)
      .then(localProfile =>
        bridge
          .preview({ assistantId: assistant.assistantId, profile: localProfile })
          .then(result => ({ localProfile, result }))
      )
      .then(({ localProfile, result }) => {
        if (request.current !== current) {
          return
        }

        setProfile(localProfile)
        setPreview(result)
      })
      .catch(() => {
        if (request.current === current) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (request.current === current) {
          setLoading(false)
        }
      })

    return () => {
      request.current += 1
    }
  }, [assistant.assistantId, open])

  const mutate = async (action: 'approve' | 'revoke') => {
    const bridge = window.hermesDesktop?.atumSharedGroups

    if (!bridge || !profile || !preview || mutating || (action === 'approve' && sharingDisabled)) {
      return
    }

    setMutating(true)
    setFailed(false)
    setConnected(false)
    const current = request.current

    try {
      if (action === 'revoke') {
        await bridge.revoke({ assistantId: assistant.assistantId, profile })
      } else {
        await bridge.approve({ assistantId: assistant.assistantId, profile, expectedDigest: preview.digest })
      }

      const updated = await bridge.preview({ assistantId: assistant.assistantId, profile })

      if (request.current !== current) {
        return
      }

      setPreview(updated)
      setConnected(action === 'approve' && updated.approved && updated.digest === preview.digest)
      await Promise.allSettled([
        refreshAtumAssistantDirectory(),
        refreshGroupCapabilities(),
        Promise.resolve(onChanged?.())
      ])
    } catch {
      if (request.current !== current) {
        return
      }

      setFailed(true)

      // Local approval can succeed before registration/binding fails. Read it
      // back honestly and leave both retry and withdrawal available.
      try {
        const updated = await bridge.preview({ assistantId: assistant.assistantId, profile })

        if (request.current === current) {
          setPreview(updated)
        }
      } catch {
        // Keep the visible preview; the error remains actionable.
      }
    } finally {
      if (request.current === current) {
        setMutating(false)
      }
    }
  }

  return (
    <ConsentBoundary><Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent aria-busy={loading || mutating} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <GroupParticipantIdentity
          assistant={assistant}
          displayName={assistant.displayName}
          target={{ type: 'assistant', id: assistant.assistantId }}
        />
        {loading && (
          <div className="flex items-center gap-2" role="status">
            <Spinner className="size-4 animate-spin" /> {copy.loading}
          </div>
        )}
        {failed && <ErrorBanner>{copy.unavailable}</ErrorBanner>}
        {!loading && sharingDisabled && <p className="text-sm text-(--atum-ink-muted)">{copy.rolloutDisabled}</p>}
        {preview && (
          <div className="grid gap-3">
            <p className="text-sm text-(--atum-ink-muted)">
              {connected && !sharingDisabled
                ? copy.enabled
                : preview.approved && bound
                  ? copy.bound
                  : preview.approved
                    ? copy.approved
                    : copy.ready}
            </p>
            {offline && !connected && <p className="text-sm text-(--atum-ink-muted)">{copy.offline}</p>}
            <p className="text-sm text-(--atum-ink-muted)">{copy.disclosure}</p>
            <pre className="max-h-72 overflow-auto rounded-[var(--atum-r-control)] bg-(--atum-sunk) p-3 text-xs whitespace-pre-wrap text-(--atum-ink)">
              {preview.content}
            </pre>
          </div>
        )}
        <DialogFooter>
          <Button disabled={loading || mutating} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.close}
          </Button>
          {preview?.approved && (
            <Button disabled={mutating} onClick={() => void mutate('revoke')} type="button" variant="outline">
              {copy.revoke}
            </Button>
          )}
          {preview && !connected && (
            <Button disabled={mutating || sharingDisabled} onClick={() => void mutate('approve')} type="button">
              {mutating ? copy.saving : preview.approved ? copy.reconnect : copy.approve}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog></ConsentBoundary>
  )
}
