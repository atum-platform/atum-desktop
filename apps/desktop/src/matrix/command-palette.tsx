import { useStore } from '@nanostores/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactNode, useCallback, useRef } from 'react'

import { HUD_ITEM } from '@/app/floating-hud'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { KbdCombo } from '@/components/ui/kbd'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $bindings, bindingsFor } from '@/store/keybinds'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

import { matrixCompanyCopy } from '../../shared/matrix-company-copy'

import { useChatCopy } from './chat-copy'
import { normalizeMatrixRosterQuery } from './roster-model'

/** Where an entry is listed: what you can do, then who and what you can open. */
export type MatrixPaletteGroup = 'actions' | 'assistants' | 'channels' | 'chats' | 'people'

export interface MatrixPaletteAction {
  id: string
  label: string
  keywords?: string[]
  /** Defaults to `actions`. */
  group?: MatrixPaletteGroup
  /** A chat's or a person's avatar beside the name. */
  icon?: ReactNode
  /** A role/verification mark drawn directly after the visible label. */
  adornment?: ReactNode
  run(): void
}

export interface MatrixCommandPaletteProps {
  open: boolean
  onOpenChange(open: boolean): void
  actions: MatrixPaletteAction[]
  onCloseAutoFocus?: React.ComponentProps<typeof DialogPrimitive.Content>['onCloseAutoFocus']
}

const GROUPS: readonly MatrixPaletteGroup[] = ['actions', 'assistants', 'channels', 'chats', 'people']

// cmdk selection values must be unique even when two callers expose the same
// label. The caller remains the sole authority for which actions are allowed.
function paletteValue(action: MatrixPaletteAction): string {
  return `${action.label}\u0001${action.id}`
}

/**
 * What a search matches: words of what an entry shows and of its keywords — never letters
 * scattered through a long title, and never the id its value carries for uniqueness (every
 * chat's id names the server, so "atum" would match them all) — folded the way the roster's
 * search is, so "gia dinh" finds "Gia đình". What an entry is called outranks what it
 * merely mentions, and the start of a word outranks its middle.
 */
function matrixPaletteFilter(value: string, search: string, keywords: string[] = []): number {
  const query = normalizeMatrixRosterQuery(search)

  if (!query) {
    return 1
  }

  const label = normalizeMatrixRosterQuery(value.split('\u0001', 1)[0] ?? '')
  const text = [label, ...keywords.map(normalizeMatrixRosterQuery)].join(' ')

  if (!query.split(' ').every(word => text.includes(word))) {
    return 0
  }

  return label.startsWith(query) ? 1 : ` ${label}`.includes(` ${query}`) ? 0.9 : label.includes(query) ? 0.8 : 0.5
}

/**
 * The Matrix window's palette (launch night): one search across what you can do and the
 * assistants, chats and people you can open, on the product's own glass (the popover
 * recipe, so Atum's tokens and focus contract apply), never the legacy cream HUD.
 */
export function MatrixCommandPalette({ actions, onCloseAutoFocus, onOpenChange, open }: MatrixCommandPaletteProps) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const bindings = useStore($bindings)
  const actionsRef = useRef(actions)
  const openRef = useRef(open)
  const previousOpenPropRef = useRef(open)
  const selectingRef = useRef(false)

  // Retained closing content can still receive an event while another modal is
  // taking over. Resolve selection against the latest caller-owned action list
  // and reject it once this controlled dialog is no longer open.
  if (open && !previousOpenPropRef.current) {
    selectingRef.current = false
  }

  actionsRef.current = actions
  previousOpenPropRef.current = open
  openRef.current = open

  const changeOpen = useCallback(
    (next: boolean) => {
      if (!next) {
        openRef.current = false
      }

      onOpenChange(next)
    },
    [onOpenChange]
  )

  const select = useCallback(
    (id: string) => {
      if (!openRef.current || selectingRef.current) {
        return
      }

      const action = actionsRef.current.find(candidate => candidate.id === id)

      if (!action) {
        return
      }

      selectingRef.current = true
      openRef.current = false
      onOpenChange(false)
      action.run()
    },
    [onOpenChange]
  )

  const headings: Record<MatrixPaletteGroup, string> = {
    actions: chat.paletteActions,
    assistants: chat.paletteAssistants,
    channels: matrixCompanyCopy(locale).channels,
    chats: chat.paletteChats,
    people: chat.palettePeople
  }

  const item = (action: MatrixPaletteAction) => {
    const combo = bindingsFor(action.id, bindings)[0]

    return (
      <CommandItem
        className={cn(
          HUD_ITEM,
          'min-h-8 rounded-(--atum-r-control) text-(length:--atum-t-control) text-(--atum-ink) data-[selected=true]:bg-(--atum-hover) data-[selected=true]:text-(--atum-ink)'
        )}
        key={action.id}
        keywords={action.keywords}
        onSelect={() => select(action.id)}
        value={paletteValue(action)}
      >
        {action.icon}
        <span className="min-w-0 flex-1 truncate">{action.label}</span>
        {action.adornment}
        {combo && <KbdCombo className="ml-auto opacity-55" combo={combo} size="sm" />}
      </CommandItem>
    )
  }

  // One group, as before, when the caller lists only actions.
  const grouped = actions.some(action => action.group && action.group !== 'actions')

  return (
    <DialogPrimitive.Root onOpenChange={changeOpen} open={open}>
      <DialogPrimitive.Portal>
        {/* Atum's dialog scrim, as Start a chat has: the palette is a sheet over the window,
            not the old engine's HUD pinned over the titlebar (launch night). */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-[200]" data-slot="dialog-overlay" />
        <AppViewOverlayHold />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed top-[max(4.5rem,14vh)] left-1/2 z-[210] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-(--atum-r-card) text-(--atum-ink) duration-150 [-webkit-app-region:no-drag] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:zoom-in-95'
          )}
          data-matrix-command-palette
          // The product's popover surface: Atum's glass, tokens and focus contract.
          data-slot="popover-content"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <DialogPrimitive.Title className="sr-only">{t.commandCenter.paletteTitle}</DialogPrimitive.Title>
          <Command className="bg-transparent" filter={matrixPaletteFilter} label={t.commandCenter.commands} loop>
            <CommandInput
              aria-label={t.commandCenter.paletteTitle}
              className="text-(length:--atum-t-ui) text-(--atum-ink) placeholder:text-(--atum-ink-faint)"
              placeholder={grouped ? chat.paletteSearch : t.commandCenter.searchPlaceholder}
            />
            <CommandList className="dt-portal-scrollbar max-h-[min(24rem,60vh)] p-1.5" label={t.commandCenter.commands}>
              <CommandEmpty>{t.commandCenter.noResults}</CommandEmpty>
              {grouped
                ? GROUPS.map(group => {
                    const entries = actions.filter(action => (action.group ?? 'actions') === group)

                    return entries.length > 0 ? (
                      <CommandGroup
                        className="p-0 **:[[cmdk-group-heading]]:static **:[[cmdk-group-heading]]:bg-transparent **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-(length:--atum-t-label) **:[[cmdk-group-heading]]:text-(--atum-ink-muted)"
                        heading={headings[group]}
                        key={group}
                      >
                        {entries.map(item)}
                      </CommandGroup>
                    ) : null
                  })
                : actions.map(item)}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
