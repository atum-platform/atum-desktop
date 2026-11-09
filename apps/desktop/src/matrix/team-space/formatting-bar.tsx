import type { RefObject } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Bold, Code, Italic, Link, List, ListNumbers, SourceCode, Strikethrough, TextSize } from '@/lib/icons'

import { applyTeamSpaceFormat, type FormattedText, type TeamSpaceFormat } from './formatting'
import { useTeamSpaceLayoutCopy } from './layout-copy'

/**
 * The box's "Aa": opens and closes the formatting row, so a channel's box stays as plain as a chat's
 * until someone asks for bold or a list (Atum Kit 0.1).
 */
export function TeamSpaceFormattingToggle({ disabled, onToggle, open }: {
  disabled?: boolean
  onToggle(): void
  open: boolean
}) {
  const copy = useTeamSpaceLayoutCopy()

  return (
    <Tip label={copy.formatting}>
      <button
        aria-label={copy.formatting}
        aria-pressed={open}
        className="atum-icon-btn size-7 rounded-full disabled:opacity-40 aria-pressed:bg-(--ak-fill-quiet) aria-pressed:text-(--atum-ink)"
        data-team-space-format-toggle
        disabled={disabled}
        onClick={onToggle}
        onMouseDown={event => event.preventDefault()}
        type="button"
      >
        <TextSize aria-hidden className="size-4" />
      </button>
    </Tip>
  )
}

/**
 * Slack's formatting row over the Team Space message box: bold, italic, strikethrough, link, the
 * two lists, code and a code block. Each writes markdown around the selection in the box (what
 * every Atum client renders), so nothing about sending changes.
 */
export function TeamSpaceFormattingBar({ disabled, input, onFormat }: {
  disabled?: boolean
  input: RefObject<HTMLTextAreaElement | null>
  onFormat(next: FormattedText): void
}) {
  const copy = useTeamSpaceLayoutCopy()

  const groups: Array<Array<{ format: TeamSpaceFormat; label: string; Icon: typeof Bold }>> = [
    [
      { format: 'bold', label: copy.bold, Icon: Bold },
      { format: 'italic', label: copy.italic, Icon: Italic },
      { format: 'strike', label: copy.strike, Icon: Strikethrough }
    ],
    [{ format: 'link', label: copy.link, Icon: Link }],
    [
      { format: 'bullets', label: copy.bulletList, Icon: List },
      { format: 'numbers', label: copy.numberedList, Icon: ListNumbers }
    ],
    [
      { format: 'code', label: copy.code, Icon: Code },
      { format: 'codeBlock', label: copy.codeBlock, Icon: SourceCode }
    ]
  ]

  const apply = (format: TeamSpaceFormat) => {
    const box = input.current

    if (!box) {
      return
    }

    onFormat(applyTeamSpaceFormat(box.value, box.selectionStart, box.selectionEnd, format))
  }

  return (
    <div aria-label={copy.formatting} className="flex items-center gap-0.5 pb-1" data-team-space-formatting role="toolbar">
      {groups.map((group, index) => (
        <div className="flex items-center gap-0.5" key={group[0]!.format}>
          {index > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-(--atum-line)" />}
          {group.map(({ format, label, Icon }) => (
            <Tip key={format} label={label}>
              <button
                aria-label={label}
                className="atum-icon-btn size-7 disabled:opacity-40"
                data-team-space-format={format}
                disabled={disabled}
                // Keep the selection in the box: the button must not take focus on press.
                onClick={() => apply(format)}
                onMouseDown={event => event.preventDefault()}
                type="button"
              >
                <Icon aria-hidden className="size-4" />
              </button>
            </Tip>
          ))}
        </div>
      ))}
    </div>
  )
}
