import { useStore } from '@nanostores/react'
import { type FC, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { adoptPetFor } from '@/store/pet-gallery'
import { newSessionInProfile } from '@/store/profile'

import { NEW_CHAT_ROUTE } from '../routes'

import { $atumAgents } from './agents'
import {
  $atumAssistantDirectory,
  captureAtumAssistantDirectoryScope,
  hostedAtumAssistant,
  isAtumAssistantDirectoryScopeCurrent,
  refreshAtumAssistantDirectory,
  uploadAtumAssistantAvatar,
  validateAtumAssistantAvatar
} from './assistant-directory'
import { AtumAssistantPetField } from './assistant-pet-field'
import { AtumAssistantPhotoField } from './assistant-photo-field'
import { AGENT_TEXT_MAX, ATUM_ASSISTANT_NAME_MAX, createAtumAgent } from './create-agent'
import { uploadPortableAtumAgent } from './portable-agent'
import { registerAtumAgents } from './register-agents'
import { $workspaceProtected } from './utilities/store'

/**
 * Making an agent, in three answers.
 *
 * A name, who they are, and what they do. Everything a Hermes profile also
 * needs — an id, a model, skills, an approval posture, a workspace — is
 * derived or inherited from Atum, because a person making an assistant should
 * not have to know that any of it exists.
 *
 * The name is the only required field: an agent with no instructions is still
 * a working assistant, and the user can say more later.
 */

export const AtumCreateAgentDialog: FC<{ onOpenChange: (open: boolean) => void; open: boolean }> = ({
  onOpenChange,
  open
}) => {
  const { t } = useI18n()
  const copy = t.atum.agents
  const agents = useStore($atumAgents)
  const navigate = useNavigate()
  const { requestGateway } = useGatewayRequest()

  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [job, setJob] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  // The assistant does not exist yet, so the pet is held until it does.
  const [pet, setPet] = useState<null | string>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [createdAccountId, setCreatedAccountId] = useState<null | string>(null)
  const [photoProgress, setPhotoProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<null | string>(null)
  const nameTooLong = name.trim().length > ATUM_ASSISTANT_NAME_MAX
  const canSubmit = Boolean(name.trim()) && !nameTooLong

  const close = (next: boolean) => {
    if (busy) {
      return
    }

    if (!next) {
      setName('')
      setPersona('')
      setJob('')
      setPhoto(null)
      setPet(null)
      setCreatedId(null)
      setCreatedAccountId(null)
      setPhotoProgress(null)
      setFailure(null)
    }

    onOpenChange(next)
  }

  const submit = async () => {
    if (busy || !canSubmit) {
      return
    }

    setBusy(true)
    setFailure(null)
    const operationScope = captureAtumAssistantDirectoryScope()

    try {
      // Hold on to the created id before an optional photo upload. A retry
      // after a failed signed upload must finish this assistant, never make a
      // second profile with a suffixed local id.
      if (createdId && createdAccountId !== operationScope.accountId) {
        throw new Error('assistant_profile_account_changed')
      }

      const id = createdId ?? (await createAtumAgent({ avatar: '', job, name, persona }, agents)).id
      setCreatedId(id)
      setCreatedAccountId(createdAccountId ?? operationScope.accountId)

      if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
        throw new Error('assistant_profile_account_changed')
      }

      // The pet can only be adopted once the profile exists, so it rides the
      // post-creation work with the photo. A failure here does not undo the
      // assistant — the copy below says so rather than claiming nothing
      // happened — and it is reported, because the person chose one.
      if (pet) {
        const adopted = await adoptPetFor(requestGateway, pet, id, copy.petFailed)

        if (!adopted) {
          throw new Error('assistant_pet_failed')
        }
      }

      if (photo) {
        const invalid = validateAtumAssistantAvatar(photo)

        if (invalid) {
          throw new Error(`assistant_avatar_${invalid}`)
        }

        await registerAtumAgents()

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        await refreshAtumAssistantDirectory()

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        const local = $atumAgents.get().find(agent => agent.id === id)

        const hosted = local
          ? hostedAtumAssistant($atumAssistantDirectory.get(), local.identityId, local.isDefault)
          : null

        if (!hosted) {
          throw new Error('assistant_profile_unavailable')
        }

        setPhotoProgress(0)
        await uploadAtumAssistantAvatar(hosted.id, photo, setPhotoProgress)

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        setPhoto(null)
        setPhotoProgress(null)
      }

      // A newly created managed assistant is useful on its original device
      // before cloud sync succeeds, but when the account is available upload
      // the runtime's exact portable allowlist now. This is intentionally not
      // reconstructed from the form or from Atum's master settings.
      if (operationScope.accountId) {
        await registerAtumAgents()
        await refreshAtumAssistantDirectory()

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        const local = $atumAgents.get().find(agent => agent.id === id)

        if (local?.hostedId && !$workspaceProtected.get()) {
          try {
            await uploadPortableAtumAgent(local)
          } catch (error) {
            // Cloud unavailability never undoes local creation or prevents the
            // first chat. The roster retains the row and exposes Sync later.
            if (error instanceof Error && error.message === 'assistant_profile_account_changed') {
              throw error
            }
          }
        }
      }

      // Straight into a chat with the agent that was just made: point new
      // chats at it, open its backend, and land on the composer.
      if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
        throw new Error('assistant_profile_account_changed')
      }

      newSessionInProfile(id)
      navigate(NEW_CHAT_ROUTE)
      onOpenChange(false)
      setName('')
      setPersona('')
      setJob('')
      setPhoto(null)
      setPet(null)
      setCreatedId(null)
      setCreatedAccountId(null)
      setPhotoProgress(null)
    } catch (error) {
      // The agent may exist even when this failed: creation and instructions
      // are two steps, so the copy says what is true rather than "nothing
      // happened".
      const code = error instanceof Error ? error.message : ''

      const reasons: Record<string, string> = {
        agent_name_required: copy.nameRequired,
        agent_name_too_long: copy.nameTooLong,
        assistant_avatar_too_large: copy.photoTooLarge,
        assistant_avatar_wrong_type: copy.photoWrongType,
        assistant_pet_failed: copy.petFailed
      }

      setFailure(
        reasons[code] ??
          (code.startsWith('assistant_avatar_') || code === 'assistant_profile_unavailable'
            ? copy.photoFailed
            : copy.failed)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="max-w-[27.5rem]" data-atum-agent-sheet>
        <DialogHeader>
          <DialogTitle>{copy.createTitle}</DialogTitle>
          <DialogDescription>{copy.createBody}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <label
                className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
                htmlFor="atum-agent-name"
              >
                {copy.nameLabel}
              </label>
              <Input
                autoFocus
                className="atum-input"
                disabled={busy || createdId !== null}
                id="atum-agent-name"
                maxLength={ATUM_ASSISTANT_NAME_MAX}
                onChange={event => setName(event.target.value)}
                placeholder={copy.namePlaceholder}
                value={name}
              />
            </div>
          </div>

          {nameTooLong && (
            <p className="text-(length:--atum-t-body) text-(--atum-danger)" role="alert">
              {copy.nameTooLong}
            </p>
          )}

          <div className="space-y-1">
            <AtumAssistantPhotoField
              avatarUrl={null}
              changeLabel={copy.changePhoto}
              disabled={busy}
              id={createdId ?? 'new-assistant'}
              name={name}
              onChoose={setPhoto}
              photoLabel={copy.photoLabel}
              removeLabel={copy.removePhoto}
              uploading={photoProgress !== null}
            />
            <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.photoHint}</p>
            {photoProgress !== null && (
              <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                {copy.photoUploading(photoProgress)}
              </p>
            )}
          </div>

          {/* No agent id yet, so the field has no current pet to show — it is
              purely a choice, applied once the assistant exists. */}
          <AtumAssistantPetField agentId={createdId} disabled={busy} onChange={setPet} onClose={() => close(false)} value={pet} />

          {/* Owner decision, 2026-09-05: every named assistant will have a
              public/private switch that governs who may address it. Public
              mode is not built yet, so the control states the direction and
              is disabled rather than absent. The master assistant has no
              such switch at all. */}
          <div className="space-y-1">
            <span
              className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
              id="atum-agent-visibility-label"
            >
              {copy.visibilityLabel}
            </span>
            <div className="flex items-center justify-between gap-3 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-2.5 py-2">
              <span className="text-(length:--atum-t-body) text-(--atum-ink)">{copy.visibilityPrivate}</span>
              <button
                aria-checked="false"
                aria-describedby="atum-agent-visibility-soon"
                aria-labelledby="atum-agent-visibility-label"
                className="relative h-5 w-9 shrink-0 rounded-full bg-(--atum-line) opacity-50"
                data-atum-visibility-switch
                disabled
                role="switch"
                type="button"
              >
                <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-(--atum-card) shadow-(--atum-shadow-tile)" />
              </button>
            </div>
            <span
              className="mt-1.5 block text-(length:--atum-t-caption) text-(--atum-ink-muted)"
              id="atum-agent-visibility-soon"
            >
              {copy.visibilityPublicSoon}
            </span>
          </div>

          <div className="space-y-1">
            <label
              className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
              htmlFor="atum-agent-persona"
            >
              {copy.personaLabel}
            </label>
            <Textarea
              className="atum-input"
              disabled={busy || createdId !== null}
              id="atum-agent-persona"
              maxLength={AGENT_TEXT_MAX}
              onChange={event => setPersona(event.target.value)}
              placeholder={copy.personaPlaceholder}
              rows={2}
              value={persona}
            />
          </div>

          <div className="space-y-1">
            <label
              className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
              htmlFor="atum-agent-job"
            >
              {copy.jobLabel}
            </label>
            <Textarea
              className="atum-input"
              disabled={busy || createdId !== null}
              id="atum-agent-job"
              maxLength={AGENT_TEXT_MAX}
              onChange={event => setJob(event.target.value)}
              placeholder={copy.jobPlaceholder}
              rows={3}
              value={job}
            />
          </div>

          {failure && <NoticeBand role="alert">{failure}</NoticeBand>}
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={() => close(false)} variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? copy.creating : createdId && photo ? copy.photoRetry : copy.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
