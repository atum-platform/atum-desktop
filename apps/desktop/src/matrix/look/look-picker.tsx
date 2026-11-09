import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Check, Info, X } from '@/lib/icons'

import { appLocalizedCopy } from '../../../shared/app-catalog'
import type { LookPackGround, LookPackPublished, LookRoomAccountData } from '../../../shared/look-pack'
import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { useChatCopy } from '../chat-copy'
import { runMatrixCommand } from '../text-document-actions'

import { groundStyle, type LookCssProperties, resolveConversationLook } from './resolve-look'

interface LookChoice {
  id: string
  label: string
  pack: LookPackPublished | null
  selection: LookRoomAccountData
  section: 'default' | 'atum' | 'apps'
}

function packGround(pack: LookPackPublished, appearance: 'light' | 'dark'): {
  ground: LookPackGround
  style: LookCssProperties
} | null {
  const backgrounds = pack.chat?.background

  if (!backgrounds) {
    return null
  }

  const ground = appearance === 'dark' ? (backgrounds.dark ?? backgrounds.light) : backgrounds.light
  const derived = appearance === 'dark' ? (pack.derived.dark ?? pack.derived.light) : pack.derived.light

  return { ground, style: groundStyle(ground, derived, 'thumb') }
}

function LookPreview({ appearance, pack, selected }: { appearance: 'light' | 'dark'; pack: LookPackPublished | null; selected: boolean }) {
  const resolved = pack ? packGround(pack, appearance) : null
  const dark = resolved?.ground.tone === 'dark'

  return (
    <span
      className="relative block aspect-[4/3] overflow-hidden rounded-[0.625rem] shadow-[inset_0_0_0_0.5px_var(--atum-line-strong)]"
      data-atum-look-preview
      data-selected={selected ? true : undefined}
      style={resolved?.style}
    >
      <span className="absolute top-[22%] left-[9%] z-10 h-2.5 w-[54%] rounded-full bg-white/95" />
      <span
        className={`absolute top-[54%] right-[9%] z-10 h-2.5 w-[40%] rounded-full ${dark ? 'bg-white/35' : 'bg-black/14'}`}
      />
      {selected && (
        <span className="absolute right-1.5 bottom-1.5 z-20 grid size-[1.125rem] place-items-center rounded-full bg-(--atum-root-ink) text-(--atum-root-on-accent)">
          <Check aria-hidden className="size-3" />
        </span>
      )}
    </span>
  )
}

function selected(choice: LookChoice, current: LookRoomAccountData): boolean {
  return choice.selection.background.kind === current.background.kind &&
    (choice.selection.background.kind !== 'pack' ||
      (current.background.kind === 'pack' && choice.selection.background.pack_id === current.background.pack_id))
}

export interface ChatLookPickerProps {
  appearance: 'light' | 'dark'
  current: LookRoomAccountData
  onOpenChange(open: boolean): void
  onPreview(look: LookRoomAccountData): void
  open: boolean
  room: MatrixRoom
  snapshot: MatrixSnapshot
}

/** One root-scope sheet for every chat type; account data remains the authority. */
export function ChatLookPicker({
  appearance,
  current,
  onOpenChange,
  onPreview,
  open,
  room,
  snapshot
}: ChatLookPickerProps) {
  const chat = useChatCopy()
  const { locale, t } = useI18n()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const [bounds, setBounds] = useState<DOMRect>()

  useLayoutEffect(() => {
    if (!open) {
      return
    }

    const host = anchor.current?.closest('[data-atum-chat]')

    if (!(host instanceof HTMLElement)) {
      return
    }

    const measure = () => setBounds(host.getBoundingClientRect())
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    measure()
    observer?.observe(host)
    window.addEventListener('resize', measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  const choices = useMemo<LookChoice[]>(() => {
    const defaultPack = resolveConversationLook({
      snapshot,
      room,
      appearance,
      accountData: { v: 1, background: { kind: 'default' } }
    }).pack
    const items: LookChoice[] = [
      {
        id: 'default',
        label: chat.backgroundDefault,
        pack: defaultPack,
        selection: { v: 1, background: { kind: 'default' } },
        section: 'default'
      }
    ]
    const seen = new Set<string>()

    for (const pack of snapshot.apps?.gallery ?? []) {
      if (!pack.chat?.background || seen.has(pack.pack_id)) {
        continue
      }

      seen.add(pack.pack_id)
      items.push({
        id: `atum:${pack.pack_id}`,
        label: appLocalizedCopy(pack.name, locale, chat.backgroundAtum),
        pack,
        selection: { v: 1, background: { kind: 'pack', pack_id: pack.pack_id } },
        section: 'atum'
      })
    }

    for (const app of snapshot.apps?.apps ?? []) {
      const pack = app.look

      if (!pack?.chat?.background || seen.has(pack.pack_id)) {
        continue
      }

      seen.add(pack.pack_id)
      items.push({
        id: `app:${pack.pack_id}`,
        label: appLocalizedCopy(app.name, locale, app.app),
        pack,
        selection: { v: 1, background: { kind: 'pack', pack_id: pack.pack_id } },
        section: 'apps'
      })
    }

    return items
  }, [appearance, chat.backgroundAtum, chat.backgroundDefault, locale, room, snapshot])

  const apply = async (choice: LookChoice) => {
    if (pending || selected(choice, current)) {
      return
    }

    const previous = current
    setPending(true)
    setFailed(false)
    onPreview(choice.selection)

    try {
      await runMatrixCommand({ kind: 'chatLook', roomId: room.id, look: choice.selection })
    } catch {
      onPreview(previous)
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = 3
    let next = index

    if (event.key === 'ArrowRight') {
      next = Math.min(choices.length - 1, index + 1)
    } else if (event.key === 'ArrowLeft') {
      next = Math.max(0, index - 1)
    } else if (event.key === 'ArrowDown') {
      next = Math.min(choices.length - 1, index + columns)
    } else if (event.key === 'ArrowUp') {
      next = Math.max(0, index - columns)
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = choices.length - 1
    } else {
      return
    }

    event.preventDefault()
    buttons.current[next]?.focus()
  }

  const grid = (section: LookChoice['section']) => {
    const items = choices.filter(choice => choice.section === section)

    if (!items.length) {
      return null
    }

    return (
      <div className="grid grid-cols-3 gap-x-2.5 gap-y-3" role="grid">
        {items.map(choice => {
          const index = choices.indexOf(choice)
          const active = selected(choice, current)

          return (
            <button
              aria-label={choice.label}
              aria-pressed={active}
              className="group min-w-0 rounded-(--atum-r-row) p-1 text-center text-(length:--atum-t-caption) text-(--atum-root-ink-soft) hover:bg-(--atum-root-hover) focus-visible:bg-(--atum-root-hover) disabled:opacity-60"
              data-look-choice={choice.id}
              disabled={pending}
              key={choice.id}
              onClick={() => void apply(choice)}
              onKeyDown={event => move(event, index)}
              ref={node => { buttons.current[index] = node }}
              role="gridcell"
              tabIndex={active || (!choices.some(item => selected(item, current)) && index === 0) ? 0 : -1}
              type="button"
            >
              <LookPreview appearance={appearance} pack={choice.pack} selected={active} />
              <span className="mt-1 block truncate">{choice.label}</span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <span hidden ref={anchor} />
      <Sheet
      onOpenChange={value => {
        setFailed(false)
        onOpenChange(value)
      }}
      open={open}
    >
      <SheetContent
        aria-describedby={undefined}
        className="atum-sheet gap-3 overflow-y-auto rounded-(--atum-r-card) border border-(--atum-root-line-strong) bg-(--atum-root-glass-strong) p-3 text-(--atum-root-ink) shadow-(--atum-root-sheet-shadow) sm:max-w-none"
        data-chat-look-picker
        onOpenAutoFocus={event => {
          event.preventDefault()
          requestAnimationFrame(() => content.current?.focus())
        }}
        ref={content}
        showCloseButton={false}
        style={bounds
          ? {
              top: bounds.top + 12,
              right: window.innerWidth - bounds.right + 12,
              bottom: window.innerHeight - bounds.bottom + 12,
              height: 'auto',
              width: Math.min(420, Math.max(280, bounds.width - 24))
            }
          : { top: '0.75rem', right: '0.75rem', bottom: '0.75rem', height: 'auto', width: 'min(26.25rem, calc(100vw - 1.5rem))' }}
        tabIndex={-1}
      >
        <header className="flex items-center gap-1.5 px-1">
          <SheetTitle className="text-sm font-semibold text-(--atum-root-ink)">{chat.background}</SheetTitle>
          <Tip label={chat.backgroundPrivate}>
            <button
              aria-label={chat.backgroundPrivate}
              className="atum-icon-btn size-6 text-(--atum-root-ink-muted)"
              type="button"
            >
              <Info aria-hidden className="size-3.5" />
            </button>
          </Tip>
          <Tip label={t.common.close}>
            <SheetClose asChild>
              <Button aria-label={t.common.close} className="ms-auto" size="icon-xs" variant="ghost">
                <X aria-hidden />
              </Button>
            </SheetClose>
          </Tip>
        </header>

        {grid('default')}
        {choices.some(choice => choice.section === 'atum') && (
          <section>
            <h3 className="mb-1.5 px-1 text-(length:--atum-t-caption) text-(--atum-root-ink-muted)">{chat.backgroundAtum}</h3>
            {grid('atum')}
          </section>
        )}
        {choices.some(choice => choice.section === 'apps') && (
          <section>
            <h3 className="mb-1.5 px-1 text-(length:--atum-t-caption) text-(--atum-root-ink-muted)">{chat.backgroundApps}</h3>
            {grid('apps')}
          </section>
        )}
        {failed && (
          <NoticeBand role="alert" tone="failure">
            {chat.backgroundSaveFailed}
          </NoticeBand>
        )}
      </SheetContent>
      </Sheet>
    </>
  )
}
