import { useStore } from '@nanostores/react'
import { type FC, useEffect, useRef, useState } from 'react'

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
import { ipcErrorMessage } from '@/lib/ipc-error'
import { adoptPetFor } from '@/store/pet-gallery'

import { $atumAgents, ATUM_AGENT_ID, type AtumAgent } from './agents'
import {
  $atumAssistantDirectory,
  captureAtumAssistantDirectoryScope,
  clearAtumAssistantAvatar,
  hostedAtumAssistant,
  isAtumAssistantDirectoryScopeCurrent,
  refreshAtumAssistantDirectory,
  renameAtumMasterAssistant,
  uploadAtumAssistantAvatar,
  validateAtumAssistantAvatar
} from './assistant-directory'
import { AtumAssistantPetField } from './assistant-pet-field'
import { AtumAssistantPhotoField } from './assistant-photo-field'
import { AGENT_TEXT_MAX, ATUM_ASSISTANT_NAME_MAX } from './create-agent'
import { type AtumAgentInstructions, editAtumAgent, loadAtumAgentInstructions } from './edit-agent'
import { uploadPortableAtumAgent } from './portable-agent'
import { registerAtumAgents } from './register-agents'
import { UTILITY_COPY } from './utilities/copy'
import { $workspaceProtected } from './utilities/store'

/**
 * Changing an assistant, in the same three answers that made it.
 *
 * Name and photo are always editable. The persona and job are read back out
 * of the instructions Atum wrote; when those instructions were written by
 * hand instead, the sheet says so and edits identity only, rather than
 * flattening a person's own file into two text boxes.
 */

export const AtumEditAgentDialog: FC<{
  /** The assistant being edited; `null` keeps the sheet closed. */
  agent: AtumAgent | null
  onClose: () => void
}> = ({ agent, onClose }) => {
  const { t, locale } = useI18n()
  const copy = t.atum.agents
  const { requestGateway } = useGatewayRequest()
  const directory = useStore($atumAssistantDirectory)

  const [name, setName] = useState('')
  const nameTouched = useRef(false)
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoProgress, setPhotoProgress] = useState<number | null>(null)
  // Staged like the photo: null means "leave this assistant's pet alone".
  const [pet, setPet] = useState<null | string>(null)
  const [persona, setPersona] = useState('')
  const [job, setJob] = useState('')
  // `loading` until the instructions arrive; `null` when they are hand-written.
  const [instructions, setInstructions] = useState<'loading' | AtumAgentInstructions | null>('loading')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<null | string>(null)
  const nameTooLong = name.trim().length > ATUM_ASSISTANT_NAME_MAX

  const agentId = agent?.id ?? null
  const hosted = agent ? hostedAtumAssistant(directory, agent.identityId, agent.isDefault) : null
  const currentName = agent?.isDefault ? hosted?.displayName || agent.title : agent?.title || ''
  const nameChanged = name.trim() !== currentName.trim()
  // A staged pet is a save in its own right. Signed out, the master's name is
  // not even available (it comes from the hosted directory), and the pet has
  // nothing to do with the name — it is written to the assistant's own profile.
  const canSubmit = !nameTooLong && (Boolean(name.trim()) || (Boolean(pet) && Boolean(agent?.isDefault)))

  // Every open starts from what the assistant IS now, not from what the last
  // edit left in these boxes.
  useEffect(() => {
    if (!agent) {
      return
    }

    nameTouched.current = false
    setName(currentName)
    setPhoto(null)
    setPhotoProgress(null)
    setPet(null)
    setPersona('')
    setJob('')
    setInstructions(agent.isDefault ? null : 'loading')
    setFailure(null)

    let cancelled = false

    if (agent.isDefault) {
      void refreshAtumAssistantDirectory()

      return
    }

    loadAtumAgentInstructions(agent.id)
      .then(loaded => {
        if (cancelled) {
          return
        }

        setInstructions(loaded)
        setPersona(loaded?.persona ?? '')
        setJob(loaded?.job ?? '')
      })
      .catch(() => {
        // Unreadable instructions are treated like hand-written ones: the
        // sheet still saves the name and symbol, and leaves the file alone.
        if (!cancelled) {
          setInstructions(null)
        }
      })

    return () => {
      cancelled = true
    }
    // The agent object changes identity on every roster refresh; only a
    // different assistant should reset the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, directory.accountId])

  // A late initial directory load may fill the master name. Background updates
  // must never reset a staged photo, instructions, or a name the person typed.
  useEffect(() => {
    if (agent?.isDefault && !nameTouched.current) {
      setName(currentName)
    }
  }, [agent?.isDefault, currentName])

  const close = () => {
    if (!busy) {
      onClose()
    }
  }

  const submit = async () => {
    if (busy || !agent || !canSubmit) {
      return
    }

    setBusy(true)
    setFailure(null)
    const operationScope = captureAtumAssistantDirectoryScope()

    const editable = !agent.isDefault && instructions !== 'loading' && instructions !== null
    const changed = editable && (instructions.persona !== persona || instructions.job !== job)

    try {
      // The master's name lives in the hosted directory, so signed out there is
      // no name to write and nothing to write it to. A pet-only save of the
      // master must not try. Named assistants keep writing on every save: the
      // edit is local, idempotent, and the sheet's contract is "Save saves".
      if (agent.isDefault) {
        if (nameChanged && name.trim()) {
          await renameAtumMasterAssistant({ avatar: agent.avatar, identityId: agent.identityId, name: name.trim() })

          if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
            throw new Error('assistant_profile_account_changed')
          }
        }
      } else {
        await editAtumAgent({
          id: agent.id,
          instructions: changed ? { job, persona } : null,
          name
        })

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        await registerAtumAgents()

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        await refreshAtumAssistantDirectory()

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }

        const refreshed = $atumAgents.get().find(candidate => candidate.id === agent.id)

        if (refreshed?.hostedId && !$workspaceProtected.get()) {
          await uploadPortableAtumAgent(refreshed, { avatar: agent.avatar, displayName: name.trim() })
        }
      }

      // The pet is cosmetic and its own RPC, so it is applied after the identity
      // write lands: a failure here must not cost the user their rename. It is
      // reported rather than swallowed, because they explicitly picked one.
      if (pet) {
        const adopted = await adoptPetFor(requestGateway, pet, agent.id, copy.petFailed)

        if (!adopted) {
          throw new Error('assistant_pet_failed')
        }
      }

      if (photo) {
        const invalid = validateAtumAssistantAvatar(photo)

        if (invalid) {
          throw new Error(`assistant_avatar_${invalid}`)
        }

        const latest = hostedAtumAssistant($atumAssistantDirectory.get(), agent.identityId, agent.isDefault)

        if (!latest) {
          throw new Error('assistant_avatar_profile_unavailable')
        }

        setPhotoProgress(0)
        await uploadAtumAssistantAvatar(latest.id, photo, setPhotoProgress)

        if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
          throw new Error('assistant_profile_account_changed')
        }
      }

      if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
        throw new Error('assistant_profile_account_changed')
      }

      onClose()
    } catch (error) {
      const code = ipcErrorMessage(error)

      const reasons: Record<string, string> = {
        google_workspace_local_only: UTILITY_COPY[locale].workspaceLocalOnly,
        agent_name_required: copy.nameRequired,
        agent_name_too_long: copy.nameTooLong,
        assistant_avatar_too_large: copy.photoTooLarge,
        assistant_avatar_wrong_type: copy.photoWrongType,
        // Upstream's optimistic-concurrency code, same meaning as a stale profile.
        assistant_definition_conflict: copy.changedElsewhere,
        assistant_pet_failed: copy.petFailed,
        assistant_profile_stale: copy.changedElsewhere
      }

      // Any other avatar failure still reads as a photo problem; everything
      // unrecognised is a failed edit.
      setFailure(reasons[code] ?? (code.startsWith('assistant_avatar_') ? copy.photoFailed : copy.editFailed))
    } finally {
      setBusy(false)
    }
  }

  const clearPhoto = async () => {
    if (busy || !hosted) {
      return
    }

    setBusy(true)
    setFailure(null)
    const operationScope = captureAtumAssistantDirectoryScope()

    try {
      await clearAtumAssistantAvatar(hosted.id)

      if (!isAtumAssistantDirectoryScopeCurrent(operationScope)) {
        throw new Error('assistant_profile_account_changed')
      }
    } catch {
      setFailure(copy.photoFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && close()} open={agent !== null}>
      <DialogContent className="max-w-[27.5rem]" data-atum-agent-sheet>
        <DialogHeader>
          <DialogTitle>{copy.editTitle}</DialogTitle>
          <DialogDescription>{copy.editBody}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label
              className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
              htmlFor="atum-agent-edit-name"
            >
              {copy.nameLabel}
            </label>
            <Input
              autoFocus
              className="atum-input"
              disabled={busy}
              id="atum-agent-edit-name"
              maxLength={ATUM_ASSISTANT_NAME_MAX}
              onChange={event => {
                nameTouched.current = true
                setName(event.target.value)
              }}
              placeholder={copy.namePlaceholder}
              value={name}
            />
          </div>

          {nameTooLong && (
            <p className="text-(length:--atum-t-body) text-(--atum-danger)" data-atum-agent-name-too-long role="alert">
              {copy.nameTooLong}
            </p>
          )}

          <div className="space-y-1">
            <AtumAssistantPhotoField
              avatarUrl={agent?.avatarUrl}
              changeLabel={copy.changePhoto}
              disabled={busy}
              id={agent?.id ?? ATUM_AGENT_ID}
              key={`${directory.accountId}:${agentId}`}
              name={name}
              onChoose={setPhoto}
              onRemove={() => void clearPhoto()}
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

          {/* Beside the photo, because a pet is the same kind of thing: what
              this assistant looks like, not a setting about pets in general. */}
          <AtumAssistantPetField agentId={agentId} disabled={busy} onChange={setPet} onClose={close} value={pet} />

          {!agent?.isDefault && instructions === null ? (
            <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" data-atum-agent-instructions-custom>
              {copy.instructionsCustom}
            </p>
          ) : !agent?.isDefault ? (
            <>
              <div className="space-y-1">
                <label
                  className="mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)"
                  htmlFor="atum-agent-edit-persona"
                >
                  {copy.personaLabel}
                </label>
                <Textarea
                  className="atum-input"
                  disabled={busy || instructions === 'loading'}
                  id="atum-agent-edit-persona"
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
                  htmlFor="atum-agent-edit-job"
                >
                  {copy.jobLabel}
                </label>
                <Textarea
                  className="atum-input"
                  disabled={busy || instructions === 'loading'}
                  id="atum-agent-edit-job"
                  maxLength={AGENT_TEXT_MAX}
                  onChange={event => setJob(event.target.value)}
                  placeholder={copy.jobPlaceholder}
                  rows={3}
                  value={job}
                />
              </div>
            </>
          ) : null}

          {failure && <NoticeBand role="alert">{failure}</NoticeBand>}
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={close} variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? copy.saving : copy.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
