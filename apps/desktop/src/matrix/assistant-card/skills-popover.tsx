import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { ArrowUpRight, ChevronRight } from '@/lib/icons'
import { $betaFeatures } from '@/store/beta-features'

import { useAssistantCardCopy } from './copy'

/** A skill's name as people read it: "google-calendar" → "Google calendar". */
export function skillLabel(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()

  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : name
}

/** Card 2's "Skills · N": a short read-only list, and the way to find more. */
export function SkillsRow({
  glyph,
  onFindMore,
  skills
}: {
  /** The card's leading glyph for the row. */
  glyph?: ReactNode
  onFindMore?(): void
  skills: readonly string[]
}) {
  const copy = useAssistantCardCopy()
  const { t } = useI18n()
  // Finding skills waits for beta accounts (store/beta-features.ts); the skills it has stay listed.
  const soon = !useStore($betaFeatures).granted

  if (!skills.length) {
    return null
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={copy.skillsLabel(skills.length)}
          className="atum-settings-row atum-settings-link"
          data-assistant-card-skills
          type="button"
        >
          {glyph}
          <span className="atum-settings-row-title min-w-0 flex-1">{copy.skills}</span>
          <span className="atum-card-row-value">{skills.length}</span>
          <ChevronRight aria-hidden className="atum-settings-chevron" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="atum-card-popover z-[140] w-[17.5rem] p-1.5" data-assistant-card-skills-list>
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {skills.map(skill => (
            <li className="truncate px-2.5 py-1.5 text-(length:--atum-t-ui)" key={skill}>
              {skillLabel(skill)}
            </li>
          ))}
        </ul>
        {onFindMore && (
          <>
            <div aria-hidden className="mx-2 my-1 h-px bg-(--atum-line)" />
            <button
              aria-label={soon ? `${copy.findSkills}: ${t.surfaces.comingSoon}` : undefined}
              className="atum-row flex h-8 w-full items-center gap-2 px-2.5 text-left text-(length:--atum-t-ui) disabled:pointer-events-none disabled:opacity-50"
              data-assistant-card-skills-coming-soon={soon ? true : undefined}
              disabled={soon}
              onClick={onFindMore}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{copy.findSkills}</span>
              {soon ? (
                <span className="shrink-0">{t.surfaces.comingSoon}</span>
              ) : (
                <ArrowUpRight aria-hidden className="size-3.5 text-(--atum-ink-faint)" />
              )}
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
