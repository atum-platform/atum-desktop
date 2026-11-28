import { useEffect, useRef, useState } from 'react'

import { writeClipboardText } from '@/components/ui/copy-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { AtSign, Camera, Copy, MoreHorizontal, PawPrint, Pencil, Photo, Trash2 } from '@/lib/icons'

import type { MatrixAgentView, MatrixSnapshot } from '../../../shared/matrix'
import { matrixAliasCopy } from '../../../shared/matrix-alias-copy'
import { MatrixHandleEditor } from '../handle-editor'
import { suggestMatrixAgentHandle } from '../handle-rules'
import { rememberAgentHandle, useMatrixHandles } from '../person-handles'

import { useAssistantCardCopy } from './copy'

/** What the face can do from the menu, as the face reports it (only where the photo can change). */
export interface CardPhotoActions {
  hasPhoto: boolean
  pending: boolean
  change(): void
  remove(): void
}

/**
 * The assistant's bot handle (spec/public-handles/v1), read once for the header: what the directory
 * holds now, or the handle this window already verified. `editable` where the directory exists.
 */
export function useAgentHandle(agent: MatrixAgentView, snapshot: MatrixSnapshot) {
  const bridge = window.atumMatrix?.aliases
  const known = useMatrixHandles(snapshot.identity?.userId)[agent.userId]
  const [read, setRead] = useState<string | null>()
  const editable = Boolean(bridge && snapshot.domainEnabled && snapshot.identity && agent.assistantId)

  useEffect(() => {
    if (!bridge || !editable || !agent.assistantId) {
      return
    }

    let current = true
    void bridge
      .request({ action: 'current', assistantId: agent.assistantId })
      .then(result => {
        if (current && result.ok && result.value.kind === 'current') {
          setRead(result.value.alias?.handle ?? null)
        }
      })
      .catch(() => {})

    return () => {
      current = false
    }
  }, [agent.assistantId, bridge, editable])

  return { editable, handle: read === undefined ? known : (read ?? undefined), setHandle: setRead }
}

/**
 * The header's "…" (agent card revamp 2026-11-28): the rare actions, one tap away instead of front-row
 * rows. Change or remove the photo, rename, copy or change the @handle (the existing editor, in a
 * popover from here), choose or change its pet, and, after a separator in danger ink, delete it. The
 * primary's privileges: no Delete, and no Rename while its name is locked.
 */
export function CardMenu({
  agent,
  handle,
  name,
  onDelete,
  onHandleChanged,
  onPet,
  onRename,
  pet,
  photo,
  ready,
  snapshot
}: {
  agent: MatrixAgentView
  handle: { editable: boolean; value?: string }
  name: string
  /** Absent for the primary, which cannot be deleted. */
  onDelete?(): void
  onHandleChanged(handle: string): void
  /** Opens the Store's pets; absent where there is no Store. */
  onPet?(): void
  /** Absent where the name cannot change here. */
  onRename?(): void
  pet?: string
  photo?: CardPhotoActions
  ready: boolean
  snapshot: MatrixSnapshot
}) {
  const copy = useAssistantCardCopy()
  const { locale } = useI18n()
  const alias = matrixAliasCopy(locale)
  const [editingHandle, setEditingHandle] = useState(false)
  // A menu item that opens a popover keeps focus there, not back on "…".
  const opening = useRef(false)
  // An action that takes focus (Rename) runs once the menu has closed, so the menu's own focus
  // return cannot blur the field it opened.
  const afterClose = useRef<(() => void) | undefined>(undefined)
  const bridge = window.atumMatrix?.aliases

  const hasItems = Boolean(photo || onRename || handle.value || handle.editable || onPet || onDelete)

  if (!hasItems) {
    return null
  }

  return (
    <Popover onOpenChange={setEditingHandle} open={editingHandle}>
      <PopoverAnchor asChild>
        <span className="atum-card-more">
          <DropdownMenu>
            <Tip label={copy.more}>
              <DropdownMenuTrigger asChild>
                <button aria-label={copy.more} className="atum-icon-btn size-7" data-assistant-card-more data-icon-only type="button">
                  <MoreHorizontal aria-hidden className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent
              align="end"
              className="z-[150]"
              data-assistant-card-menu
              onCloseAutoFocus={event => {
                const next = afterClose.current
                afterClose.current = undefined

                if (opening.current || next) {
                  event.preventDefault()
                  opening.current = false
                }

                next?.()
              }}
            >
              {photo && (
                <DropdownMenuItem data-assistant-card-menu-photo disabled={photo.pending || !ready} onSelect={photo.change}>
                  <Camera aria-hidden />
                  {copy.menuPhoto}
                </DropdownMenuItem>
              )}
              {photo?.hasPhoto && (
                <DropdownMenuItem data-assistant-card-menu-photo-remove disabled={photo.pending || !ready} onSelect={photo.remove}>
                  <Photo aria-hidden />
                  {copy.photoRemove}
                </DropdownMenuItem>
              )}
              {onRename && (
                <DropdownMenuItem
                  data-assistant-card-menu-rename
                  disabled={!ready}
                  onSelect={() => {
                    // The name field takes focus; "…" must not take it back and close the field.
                    afterClose.current = onRename
                  }}
                >
                  <Pencil aria-hidden />
                  {copy.menuRename}
                </DropdownMenuItem>
              )}
              {handle.value && (
                <DropdownMenuItem
                  data-assistant-card-menu-copy-handle
                  onSelect={() => void writeClipboardText(`@${handle.value}`).catch(() => {})}
                >
                  <Copy aria-hidden />
                  {copy.copyHandle(handle.value)}
                </DropdownMenuItem>
              )}
              {handle.editable && (
                <DropdownMenuItem
                  data-assistant-card-menu-change-handle
                  disabled={!ready}
                  onSelect={() => {
                    opening.current = true
                    setEditingHandle(true)
                  }}
                >
                  <AtSign aria-hidden />
                  {copy.menuChangeHandle}
                </DropdownMenuItem>
              )}
              {onPet && (
                <DropdownMenuItem data-assistant-card-menu-pet onSelect={onPet}>
                  <PawPrint aria-hidden />
                  {pet ? copy.menuPetChange : copy.menuPetChoose}
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-assistant-card-delete
                    disabled={snapshot.state !== 'ready'}
                    onSelect={() => {
                      opening.current = true
                      onDelete()
                    }}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden />
                    {copy.deleteRow(name)}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </PopoverAnchor>
      {bridge && handle.editable && snapshot.identity && agent.assistantId && (
        <PopoverContent
          align="end"
          aria-label={alias.botName}
          className="atum-card-popover z-[150] w-[22rem] max-w-[calc(100vw-1rem)] p-1.5"
          data-assistant-card-handle
          onEscapeKeyDown={event => {
            // Esc steps back one level: the field first (it reverts itself), then the popover.
            if ((event.target as HTMLElement | null)?.closest('[data-matrix-handle-field]')) {
              event.preventDefault()
            }
          }}
        >
          <div className="ak-menu-label">{alias.botName}</div>
          <div className="ak-group atum-settings-group">
            <MatrixHandleEditor
              assistantId={agent.assistantId}
              bridge={bridge}
              disabled={!ready}
              key={`${snapshot.identity.userId}:${agent.assistantId}`}
              name={name}
              names={snapshot.agents}
              onChanged={(next, previous) => {
                rememberAgentHandle(agent.userId, next, previous)
                onHandleChanged(next)
              }}
              suggestion={suggestMatrixAgentHandle(name)}
            />
          </div>
        </PopoverContent>
      )}
    </Popover>
  )
}

/** The @handle under the name, saying what it is for on hover; nothing until it has one. */
export function CardHandle({ handle }: { handle?: string }) {
  const { locale } = useI18n()

  if (!handle) {
    return null
  }

  return (
    <Tip label={matrixAliasCopy(locale).botNameHelp}>
      <p className="atum-card-handle" data-assistant-card-handle-line tabIndex={0}>
        @{handle}
      </p>
    </Tip>
  )
}
