import { useStore } from '@nanostores/react'
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
import { useI18n } from '@/i18n'
import { BarChart3, Calendar, Files, ImageIcon, Paperclip, Pin, Sparkles } from '@/lib/icons'
import { $betaFeatures } from '@/store/beta-features'

import { useMatrixCopy } from './copy'

/**
 * The composer's paperclip (T3's attach control, owner 2026-11-24): one small menu instead of a file picker. The two attach entries are
 * the same file pipeline the box always had; routines and skills belong to the assistant this
 * chat is with, and are absent where the chat has no assistant (a company channel, for one).
 */
export type ComposerPlusKind = 'photos' | 'files' | 'poll' | 'location' | 'routines' | 'skills'

export interface ComposerPlusAvailability {
  photos: boolean
  files: boolean
  poll?: boolean
  location?: boolean
  routines: boolean
  skills: boolean
}

const ORDER: readonly ComposerPlusKind[] = ['photos', 'files', 'poll', 'location', 'routines', 'skills']

/** The items that apply here, in the owner's order. Empty means the "+" has nothing to offer. */
export function composerPlusKinds(availability: ComposerPlusAvailability): ComposerPlusKind[] {
  return ORDER.filter(kind => availability[kind])
}

const ICONS: Record<ComposerPlusKind, ReactNode> = {
  photos: <ImageIcon aria-hidden />,
  files: <Files aria-hidden />,
  poll: <BarChart3 aria-hidden />,
  location: <Pin aria-hidden />,
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
  const { t } = useI18n()
  const kinds = composerPlusKinds(availability)
  // Skills wait for beta accounts (store/beta-features.ts): the entry stays, greyed "Coming soon".
  const skillsSoon = !useStore($betaFeatures).granted

  if (kinds.length === 0) {
    return null
  }

  const labels: Record<ComposerPlusKind, string> = {
    photos: copy.attachPhotos,
    files: copy.attachFiles,
    poll: 'Create poll',
    location: 'Share a place',
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
          kinds.filter(kind => kind === 'photos' || kind === 'files' || kind === 'poll' || kind === 'location'),
          kinds.filter(kind => kind === 'routines' || kind === 'skills')
        ]
          .filter(group => group.length > 0)
          .map((group, index) => (
            <Fragment key={group[0]}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.map(kind => {
                const soon = kind === 'skills' && skillsSoon

                return (
                  <DropdownMenuItem
                    data-composer-plus-coming-soon={soon ? true : undefined}
                    disabled={soon}
                    key={kind}
                    onSelect={() => onAction(kind)}
                  >
                    {ICONS[kind]}
                    {labels[kind]}
                    {soon && <span className="ml-auto pl-3">{t.surfaces.comingSoon}</span>}
                  </DropdownMenuItem>
                )
              })}
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
