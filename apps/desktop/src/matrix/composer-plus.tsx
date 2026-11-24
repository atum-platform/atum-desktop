import { Fragment, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { Calendar, Files, ImageIcon, Paperclip, Sparkles } from '@/lib/icons'

import { useMatrixCopy } from './copy'

/**
 * The composer's paperclip (T3's attach control, owner 2026-11-24): one small menu instead of a file picker. The two attach entries are
 * the same file pipeline the box always had; routines and skills belong to the assistant this
 * chat is with, and are absent where the chat has no assistant (a company channel, for one).
 */
export type ComposerPlusKind = 'photos' | 'files' | 'routines' | 'skills'

export interface ComposerPlusAvailability {
  photos: boolean
  files: boolean
  routines: boolean
  skills: boolean
}

const ORDER: readonly ComposerPlusKind[] = ['photos', 'files', 'routines', 'skills']

/** The items that apply here, in the owner's order. Empty means the "+" has nothing to offer. */
export function composerPlusKinds(availability: ComposerPlusAvailability): ComposerPlusKind[] {
  return ORDER.filter(kind => availability[kind])
}

const ICONS: Record<ComposerPlusKind, ReactNode> = {
  photos: <ImageIcon aria-hidden />,
  files: <Files aria-hidden />,
  routines: <Calendar aria-hidden />,
  skills: <Sparkles aria-hidden />
}

export function ComposerPlusMenu({
  availability,
  disabled = false,
  onAction
}: {
  availability: ComposerPlusAvailability
  disabled?: boolean
  onAction(kind: ComposerPlusKind): void
}) {
  const copy = useMatrixCopy()
  const kinds = composerPlusKinds(availability)

  if (kinds.length === 0) {
    return null
  }

  const labels: Record<ComposerPlusKind, string> = {
    photos: copy.attachPhotos,
    files: copy.attachFiles,
    routines: copy.addRoutines,
    skills: copy.addSkills
  }

  return (
    <DropdownMenu>
      <Tip label={copy.composerAdd}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={copy.composerAdd}
            className="atum-icon-btn size-7"
            disabled={disabled}
            size="icon"
            variant="ghost"
          >
            {/* The clip's weight sits in its upper loop; 1px down reads as centred on the row (T3). */}
            <Paperclip aria-hidden className="size-4 translate-y-px" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      {/* Atum Kit (FlowChat › Add menu): what to attach, then what to add to the assistant, then
          one quiet line on dropping and pasting, each group set off by a separator. */}
      <DropdownMenuContent align="start" className="min-w-56" side="top">
        {[
          kinds.filter(kind => kind === 'photos' || kind === 'files'),
          kinds.filter(kind => kind === 'routines' || kind === 'skills')
        ]
          .filter(group => group.length > 0)
          .map((group, index) => (
            <Fragment key={group[0]}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.map(kind => (
                <DropdownMenuItem key={kind} onSelect={() => onAction(kind)}>
                  {ICONS[kind]}
                  {labels[kind]}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        {(availability.photos || availability.files) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel
              className="font-normal text-(--ak-ink-3) [font:var(--ak-t-caption)]"
              data-composer-plus-hint
            >
              {copy.plusHint}
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
