import { type MutableRefObject, useId, useLayoutEffect, useRef, useState } from 'react'

import { AtumAssistantPhotoField } from '@/app/atum/assistant-photo-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import {
  MATRIX_PROFILE_NAME_MAX,
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  MATRIX_PROFILE_PHOTO_TYPES,
  type MatrixProfile,
  matrixProfileDisplayName,
  matrixProfilePhoto,
  type MatrixProfilePhotoChange,
  type MatrixProfileTarget
} from '../../shared/matrix-profile'

import { MatrixHandleEditor } from './handle-editor'
import { matrixPersonName } from './person-name'
import { useProfileCopy } from './profile-copy'

/** The name the profile holds, or nothing when it is only an ID (the SDK's stand-in). */
function savedName(profile: MatrixProfile | undefined): string {
  return (profile && matrixPersonName(profile.displayName, profile.userId)) ?? ''
}

/**
 * The person's own profile: their display name (saved with Save) and their photo (saved as
 * chosen), round like every other picture of them. Never a raw Matrix ID. An assistant's
 * name, face and persona live on its own card (assistant-card/), not here.
 */
export function MatrixProfileEditor({
  name,
  onCloseAutoFocus,
  onOpenChange,
  open,
  scopeKey,
  target
}: {
  name: string
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus']
  onOpenChange(open: boolean): void
  open: boolean
  /** Account/device (and native generation, if supplied); never just the agent's name. */
  scopeKey: string
  target: MatrixProfileTarget
}) {
  const targetKey = target.kind === 'human' ? 'human' : target.principal
  const retire = useRef<() => void>(() => {})

  const changeOpen = (value: boolean) => {
    if (!value) {
      retire.current()
    }

    onOpenChange(value)
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      {open && (
        <ProfileEditorBody
          key={`${scopeKey}/${targetKey}`}
          name={name}
          onClose={() => changeOpen(false)}
          onCloseAutoFocus={onCloseAutoFocus}
          retire={retire}
          target={target}
        />
      )}
    </Dialog>
  )
}

function ProfileEditorBody({
  name,
  onClose,
  onCloseAutoFocus,
  retire,
  target
}: {
  name: string
  onClose(): void
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus']
  retire: MutableRefObject<() => void>
  target: MatrixProfileTarget
}) {
  const { t } = useI18n()
  const copy = t.atum.account
  const words = useProfileCopy()
  const nameId = useId()
  const human = target.kind === 'human'
  const [profile, setProfile] = useState<MatrixProfile>()
  // The name being typed; undefined until the person edits it (then it is theirs).
  const [draft, setDraft] = useState<string>()
  const [savingName, setSavingName] = useState(false)
  const [nameFailed, setNameFailed] = useState(false)
  const [scope, setScope] = useState<string>()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<'load' | 'size' | 'type' | 'change'>()
  const [fieldRevision, setFieldRevision] = useState(0)
  const [retry, setRetry] = useState<MatrixProfilePhotoChange>()
  const [openingAttempt, setOpeningAttempt] = useState(0)
  const lifetime = useRef(true)
  const changing = useRef(false)
  const changeRevision = useRef(0)
  const scopeRef = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const bridge = window.atumMatrix.profiles
    let current = true
    lifetime.current = true
    setScope(undefined)
    setFailure(undefined)

    const close = () => {
      current = false
      lifetime.current = false

      if (scopeRef.current && bridge) {
        void bridge.close(scopeRef.current).catch(() => {})
        scopeRef.current = undefined
      }
    }

    retire.current = close

    if (!bridge) {
      setFailure('load')

      return close
    }

    void bridge
      .open(target)
      .then(async value => {
        if (!current) {
          await bridge.close(value.scope)

          return
        }

        scopeRef.current = value.scope
        setScope(value.scope)
        const revision = changeRevision.current
        const loaded = await bridge.read(target)

        if (current && revision === changeRevision.current) {
          setProfile(loaded)
        }
      })
      .catch(() => {
        if (current) {
          setFailure('load')
        }
      })

    return close
    // Target changes remount the body (including A → B → A), retiring its native scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingAttempt])

  const change = async (next: MatrixProfilePhotoChange) => {
    if (!scopeRef.current || !window.atumMatrix.profiles || changing.current || !lifetime.current) {
      return
    }

    changing.current = true
    changeRevision.current++
    setPending(true)
    setFailure(undefined)
    setRetry(next)

    try {
      const value = await window.atumMatrix.profiles.change(scopeRef.current, next)

      if (lifetime.current) {
        setProfile(value)
        setRetry(undefined)
        setFieldRevision(value => value + 1)
      }
    } catch {
      if (lifetime.current) {
        setFailure('change')
      }
    } finally {
      changing.current = false

      if (lifetime.current) {
        setPending(false)
      }
    }
  }

  const typed = draft ?? savedName(profile)

  const nameValid = (() => {
    try {
      return matrixProfileDisplayName(typed) !== savedName(profile)
    } catch {
      return false
    }
  })()

  const saveName = async () => {
    if (!scopeRef.current || !window.atumMatrix.profiles || changing.current || !lifetime.current || !nameValid) {
      return
    }

    changing.current = true
    changeRevision.current++
    setSavingName(true)
    setNameFailed(false)

    try {
      const value = await window.atumMatrix.profiles.change(scopeRef.current, {
        kind: 'name',
        displayName: matrixProfileDisplayName(typed)
      })

      if (lifetime.current) {
        setProfile(value)
        setDraft(undefined)
        onClose()
      }
    } catch {
      if (lifetime.current) {
        setNameFailed(true)
      }
    } finally {
      changing.current = false

      if (lifetime.current) {
        setSavingName(false)
      }
    }
  }

  const choose = async (file: File) => {
    if (changing.current || !lifetime.current) {
      return
    }

    setRetry(undefined)

    if (file.size > MATRIX_PROFILE_PHOTO_MAX_BYTES || !MATRIX_PROFILE_PHOTO_TYPES.includes(file.type as never)) {
      setFailure(file.size > MATRIX_PROFILE_PHOTO_MAX_BYTES ? 'size' : 'type')
      setFieldRevision(value => value + 1)

      return
    }

    // Read/validation can finish after the editor is replaced. Never start a new
    // native change for that retired view, even if the same agent is open again.
    changing.current = true
    changeRevision.current++
    setPending(true)
    setFailure(undefined)

    try {
      const photo = matrixProfilePhoto({ type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })
      changing.current = false

      if (lifetime.current) {
        await change(photo)
      }
    } catch {
      if (lifetime.current) {
        setFailure('type')
        setFieldRevision(value => value + 1)
      }
    } finally {
      changing.current = false

      if (lifetime.current) {
        setPending(false)
      }
    }
  }

  return (
    <DialogContent
      aria-describedby="matrix-profile-photo-hint"
      className="atum-sheet max-w-[520px]"
      data-matrix-profile-editor
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <DialogTitle>{human ? copy.editProfile : t.atum.agents.editTitle}</DialogTitle>
      {/* The product dialog has no gap of its own: the body keeps its own rhythm. */}
      <div className="mt-5 flex flex-col gap-4" data-matrix-profile-body>
        {!human && <p className="truncate text-(length:--atum-t-body) font-medium">{name}</p>}
        {human && (
          <div className="flex flex-col gap-1.5" data-matrix-profile-name>
            <label className="text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)" htmlFor={nameId}>
              {words.displayName}
            </label>
            <Input
              aria-describedby={`${nameId}-hint`}
              className="atum-input"
              disabled={!scope || savingName}
              id={nameId}
              maxLength={MATRIX_PROFILE_NAME_MAX * 2}
              onChange={event => {
                setDraft(event.target.value)
                setNameFailed(false)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void saveName()
                }
              }}
              placeholder={name}
              value={typed}
            />
            <span className="text-(length:--atum-t-caption) text-(--atum-ink-faint)" id={`${nameId}-hint`}>
              {words.displayNameHint}
            </span>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <AtumAssistantPhotoField
            avatarUrl={profile?.avatarUrl}
            changeLabel={copy.changePhoto}
            disabled={!scope || pending || savingName}
            id={human ? (profile?.userId ?? 'human') : target.principal}
            key={fieldRevision}
            name={(human && draft?.trim()) || name}
            onChoose={file => {
              void choose(file)
            }}
            onRemove={
              profile?.avatarMxc
                ? () => {
                    void change({ kind: 'remove' })
                  }
                : undefined
            }
            photoLabel={copy.photo}
            removeLabel={copy.removePhoto}
            round={human}
            uploading={pending}
          />
          {/* Unavailable old media still has an explicit remove path. */}
          {profile?.avatarMxc && !profile.avatarUrl && (
            <Button
              disabled={!scope || pending}
              onClick={() => {
                void change({ kind: 'remove' })
              }}
              variant="text"
            >
              {copy.removePhoto}
            </Button>
          )}
          <DialogDescription className="text-(length:--atum-t-caption)" id="matrix-profile-photo-hint">
            {copy.photoHint}
          </DialogDescription>
        </div>
        {human && window.atumMatrix.aliases && (
          <div data-matrix-profile-handle>
            <MatrixHandleEditor bridge={window.atumMatrix.aliases} name={typed || name} names={[]} />
          </div>
        )}
        {nameFailed && (
          <NoticeBand role="alert" tone="failure">
            {words.nameFailed}
          </NoticeBand>
        )}
        {pending && <p role="status">{copy.photoUploading}</p>}
        {failure && (
          <NoticeBand role="alert" tone="failure">
            {failure === 'size' ? copy.photoTooLarge : failure === 'type' ? copy.photoWrongType : copy.photoFailed}
          </NoticeBand>
        )}
        {failure === 'change' && retry && (
          <Button
            disabled={pending || !scope}
            onClick={() => {
              void change(retry)
            }}
            variant="secondary"
          >
            {t.atum.agents.photoRetry}
          </Button>
        )}
        {failure === 'load' && (
          <Button onClick={() => setOpeningAttempt(value => value + 1)} variant="secondary">
            {t.atum.agents.photoRetry}
          </Button>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2" data-matrix-profile-actions>
        {human ? (
          <>
            <Button disabled={savingName} onClick={onClose} variant="text">
              {words.cancel}
            </Button>
            <Button
              aria-busy={savingName || undefined}
              disabled={!nameValid || savingName}
              onClick={() => void saveName()}
            >
              {words.save}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{words.done}</Button>
        )}
      </div>
    </DialogContent>
  )
}
