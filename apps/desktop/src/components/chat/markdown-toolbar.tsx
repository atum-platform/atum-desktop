import type { Command } from '@codemirror/view'
import { type KeyboardEvent, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  Blockquote,
  Bold,
  Code,
  Heading,
  Italic,
  Link,
  List,
  ListNumbers,
  SourceCode,
  Strikethrough,
  Table
} from '@/lib/icons'

import {
  type ActiveFormats,
  cycleHeading,
  insertLink,
  insertTable,
  toggleBulletList,
  toggleCodeBlock,
  toggleEmphasis,
  toggleInlineCode,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleStrong
} from './markdown-commands'

export function isMacPlatform(): boolean {
  const platform = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`

  return /mac|iphone|ipad/iu.test(platform)
}

export const MARKDOWN_TOOLBAR_KEYBINDS = [
  'mod+b',
  'mod+i',
  'mod+shift+x',
  'mod+e',
  'mod+shift+8',
  'mod+shift+7',
  'mod+shift+9',
  'mod+k'
]

/**
 * The formatting actions of the document editor: every construct the Markdown
 * file can hold, and nothing it cannot (Atum Office Phase 1, completed in A4).
 * Each button dispatches one CodeMirror command through the host; the host
 * returns focus to the editor afterwards. Roving tabindex per WAI-ARIA toolbar.
 */
export function MarkdownToolbar({
  active,
  disabled = false,
  onCommand
}: {
  active: ActiveFormats
  disabled?: boolean
  onCommand: (command: Command) => void
}) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  // Roving tabindex: exactly one button is in the tab sequence, the last focused one.
  const [rovingIndex, setRovingIndex] = useState(0)

  const items: Array<{ command: Command; icon: typeof Bold; label: string; pressed?: boolean; shortcut: string }> = [
    {
      command: cycleHeading,
      icon: Heading,
      label: t.preview.toolbarHeading,
      pressed: active.heading > 0,
      shortcut: ''
    },
    { command: toggleStrong, icon: Bold, label: t.preview.toolbarStrong, pressed: active.strong, shortcut: 'mod+b' },
    {
      command: toggleEmphasis,
      icon: Italic,
      label: t.preview.toolbarEmphasis,
      pressed: active.emphasis,
      shortcut: 'mod+i'
    },
    {
      command: toggleStrikethrough,
      icon: Strikethrough,
      label: t.preview.toolbarStrikethrough,
      pressed: active.strikethrough,
      shortcut: 'mod+shift+x'
    },
    { command: toggleInlineCode, icon: Code, label: t.preview.toolbarCode, pressed: active.code, shortcut: 'mod+e' },
    {
      command: toggleBulletList,
      icon: List,
      label: t.preview.toolbarList,
      pressed: active.list,
      shortcut: 'mod+shift+8'
    },
    {
      command: toggleOrderedList,
      icon: ListNumbers,
      label: t.preview.toolbarOrderedList,
      pressed: active.orderedList,
      shortcut: 'mod+shift+7'
    },
    {
      command: toggleQuote,
      icon: Blockquote,
      label: t.preview.toolbarQuote,
      pressed: active.quote,
      shortcut: 'mod+shift+9'
    },
    {
      command: toggleCodeBlock,
      icon: SourceCode,
      label: t.preview.toolbarCodeBlock,
      pressed: active.codeBlock,
      shortcut: ''
    },
    { command: insertLink, icon: Link, label: t.preview.toolbarLink, pressed: active.link, shortcut: 'mod+k' },
    {
      command: insertTable({ column: t.preview.toolbarTableColumn }),
      icon: Table,
      label: t.preview.toolbarTable,
      shortcut: ''
    }
  ]

  // CodeMirror's `Mod` is Command on macOS and Control elsewhere. Both the
  // glyphs in the tip and the ARIA spelling follow the real platform, from one
  // canonical binding, so assistive technology is never told the wrong key.
  const mac = isMacPlatform()

  const displayShortcut = (canonical: string) =>
    canonical
      ? canonical
          .split('+')
          .map(part =>
            part === 'mod' ? (mac ? '⌘' : 'Ctrl') : part === 'shift' ? (mac ? '⇧' : 'Shift') : part.toUpperCase()
          )
          .join(mac ? '' : '+')
      : ''

  const ariaShortcut = (canonical: string) =>
    canonical
      ? canonical
          .split('+')
          .map(part => (part === 'mod' ? (mac ? 'Meta' : 'Control') : part === 'shift' ? 'Shift' : part.toUpperCase()))
          .join('+')
      : undefined

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(hostRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const index = buttons.findIndex(button => button === document.activeElement)

    if (index === -1 || buttons.length === 0) {
      return
    }

    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1

    if (next === -1) {
      return
    }

    event.preventDefault()
    setRovingIndex(next)
    buttons[next]?.focus()
  }

  return (
    <div
      aria-label={t.preview.toolbarLabel}
      className="flex h-8 shrink-0 items-center gap-1 border-b border-(--atum-line) px-2"
      onKeyDown={moveFocus}
      ref={hostRef}
      role="toolbar"
    >
      {items.map(({ command, icon: Icon, label, pressed, shortcut }, index) => {
        const tip = shortcut ? `${label} (${displayShortcut(shortcut)})` : label

        return (
          <Tip key={label} label={tip}>
            <Button
              aria-keyshortcuts={ariaShortcut(shortcut)}
              aria-label={tip}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => onCommand(command)}
              onFocus={() => setRovingIndex(index)}
              size="icon-xs"
              tabIndex={index === rovingIndex ? 0 : -1}
              variant={pressed ? 'secondary' : 'ghost'}
            >
              <Icon aria-hidden />
            </Button>
          </Tip>
        )
      })}
    </div>
  )
}
