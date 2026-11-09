import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tip } from '@/components/ui/tooltip'
import { ChevronDown, MoreHorizontal } from '@/lib/icons'

import type { DocumentCommandBarProps, DocumentCommandGroup, DocumentCommandItem } from './document-command-types'

type CommandBarLayout = 'wide' | 'compact' | 'minimal'

const GROUPS: DocumentCommandGroup[] = ['write', 'insert', 'page', 'view']
const COMPACT_WRITE_COMMANDS = 6

function layoutForWidth(width: number | null): CommandBarLayout {
  if (width === null || width >= 800) {
    return 'wide'
  }

  return width >= 480 ? 'compact' : 'minimal'
}

function usePanelWidth(): [React.RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const node = ref.current

    if (!node) {
      return
    }

    const measure = () => {
      const nextWidth = node.getBoundingClientRect().width

      if (nextWidth > 0) {
        setWidth(nextWidth)
      }
    }

    measure()

    if (typeof ResizeObserver !== 'function') {
      return
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      const nextWidth = entry?.contentRect.width ?? node.getBoundingClientRect().width

      if (nextWidth > 0) {
        setWidth(nextWidth)
      }
    })

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

function commandButton(
  item: DocumentCommandItem,
  index: number,
  rovingIndex: number,
  setRovingIndex: (index: number) => void,
  commandDisabled: boolean
) {
  const iconOnly = Boolean(item.icon)
  const label = item.label

  const button = (
    <Button
      aria-label={iconOnly ? label : undefined}
      aria-pressed={typeof item.pressed === 'boolean' ? item.pressed : undefined}
      data-document-command-button="true"
      data-document-command-index={index}
      disabled={commandDisabled || item.disabled}
      key={item.id}
      onClick={item.run}
      onFocus={() => setRovingIndex(index)}
      size={iconOnly ? 'icon-xs' : 'xs'}
      tabIndex={!commandDisabled && !item.disabled && index === rovingIndex ? 0 : -1}
      variant={item.pressed ? 'secondary' : 'ghost'}
    >
      {item.icon}
      {!iconOnly ? label : null}
    </Button>
  )

  return iconOnly ? (
    <Tip key={item.id} label={label}>
      {button}
    </Tip>
  ) : (
    button
  )
}

function groupLabel(group: DocumentCommandGroup, labels: DocumentCommandBarProps['labels']) {
  return labels[group]
}

/**
 * The document-local command area. It measures its own panel rather than the
 * window, so a split or expanded Atum workbench changes its density correctly.
 */
export function DocumentCommandBar({
  commands,
  disabled = false,
  documentMenu,
  heading,
  labels,
  onHeading,
  pageControls,
  status,
  styles,
  viewControls
}: DocumentCommandBarProps) {
  const [hostRef, panelWidth] = usePanelWidth()
  const layout = layoutForWidth(panelWidth)
  const [activeGroup, setActiveGroup] = useState<DocumentCommandGroup>('write')
  const [rovingIndex, setRovingIndex] = useState(0)

  const compactWrite = commands.write.slice(0, COMPACT_WRITE_COMMANDS)
  const minimalWrite = commands.write.filter(item => /^(undo|redo)$/iu.test(item.id)).slice(0, 2)
  const fallbackMinimalWrite = minimalWrite.length === 2 ? minimalWrite : commands.write.slice(0, 2)

  const visibleGroup = layout === 'wide' ? activeGroup : 'write'

  const visibleCommands =
    layout === 'wide' ? commands[activeGroup] : layout === 'compact' ? compactWrite : fallbackMinimalWrite

  const overflowWrite = commands.write.filter(item => !visibleCommands.includes(item))

  const commandDisabled = (item: DocumentCommandItem, group: DocumentCommandGroup) =>
    Boolean(item.disabled) || (disabled && group !== 'view')

  const enabledRovingIndexes = visibleCommands.flatMap((item, index) =>
    commandDisabled(item, visibleGroup) ? [] : [index]
  )

  const activeRovingIndex = enabledRovingIndexes.includes(rovingIndex) ? rovingIndex : (enabledRovingIndexes[0] ?? -1)

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    if (
      !target.matches('[data-document-command-button]') ||
      target.closest('[data-slot="select"]') ||
      target.getAttribute('aria-haspopup')
    ) {
      return
    }

    const buttons = Array.from(
      hostRef.current?.querySelectorAll<HTMLButtonElement>('[data-document-command-button]') ?? []
    ).filter(button => !button.disabled)

    const current = buttons.findIndex(button => button === document.activeElement)

    if (current === -1 || buttons.length === 0) {
      return
    }

    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % buttons.length
        : event.key === 'ArrowLeft'
          ? (current - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1

    if (next === -1) {
      return
    }

    event.preventDefault()
    const nextButton = buttons[next]
    const nextIndex = Number(nextButton?.dataset.documentCommandIndex)

    if (!Number.isSafeInteger(nextIndex)) {
      return
    }

    setRovingIndex(nextIndex)
    nextButton.focus()
  }

  const renderCommands = (items: DocumentCommandItem[], group: DocumentCommandGroup) =>
    items.map((item, index) =>
      commandButton(item, index, activeRovingIndex, setRovingIndex, commandDisabled(item, group))
    )

  const moveCategory = (event: KeyboardEvent<HTMLButtonElement>, group: DocumentCommandGroup) => {
    const current = GROUPS.indexOf(group)

    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % GROUPS.length
        : event.key === 'ArrowLeft'
          ? (current - 1 + GROUPS.length) % GROUPS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? GROUPS.length - 1
              : -1

    if (next === -1) {
      return
    }

    event.preventDefault()
    const nextGroup = GROUPS[next]!
    setActiveGroup(nextGroup)
    setRovingIndex(0)
    hostRef.current?.querySelector<HTMLButtonElement>(`[data-document-command-category="${nextGroup}"]`)?.focus()
  }

  const styleSelector = (
    <Select disabled={disabled} onValueChange={value => onHeading(Number(value))} value={String(heading)}>
      <SelectTrigger aria-label={labels.style} className="w-36 max-w-[9rem] shrink-0" size="xs">
        <SelectValue aria-label={labels.style} />
      </SelectTrigger>
      <SelectContent>
        {styles.map(style => (
          <SelectItem key={style.value} value={String(style.value)}>
            {style.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const overflow =
    layout === 'wide' ? null : (
      <DropdownMenu>
        <Tip label={labels.more}>
          <DropdownMenuTrigger asChild>
            <Button aria-label={labels.more} size={layout === 'minimal' ? 'xs' : 'icon-xs'} variant="ghost">
              {layout === 'minimal' ? (
                <>
                  {labels.more}
                  <ChevronDown aria-hidden />
                </>
              ) : (
                <MoreHorizontal aria-hidden />
              )}
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end">
          {overflowWrite.length > 0 ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{labels.write}</DropdownMenuLabel>
              {overflowWrite.map(item => (
                <DropdownMenuItem disabled={commandDisabled(item, 'write')} key={item.id} onSelect={item.run}>
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ) : null}
          {GROUPS.filter(group => group !== 'write').map(group => (
            <DropdownMenuGroup key={group}>
              {overflowWrite.length > 0 || group !== 'insert' ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{groupLabel(group, labels)}</DropdownMenuLabel>
              {commands[group].map(item => (
                <DropdownMenuItem disabled={commandDisabled(item, group)} key={item.id} onSelect={item.run}>
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
              {group === 'page' ? pageControls : null}
              {group === 'view' ? viewControls : null}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )

  return (
    <div
      aria-label={labels.toolbar}
      className="shrink-0 border-b border-(--atum-line) bg-(--atum-bg-high)"
      data-document-command-layout={layout}
      onKeyDown={moveFocus}
      ref={hostRef}
      role="toolbar"
    >
      {layout === 'wide' ? (
        <div className="flex h-7 items-center gap-4 px-3 text-[0.6875rem] text-(--atum-ink-muted)">
          <div aria-label={labels.toolbar} className="flex items-center gap-1" role="group">
            {GROUPS.map(group => (
              <Button
                aria-pressed={activeGroup === group}
                data-document-command-category={group}
                key={group}
                onClick={() => {
                  setActiveGroup(group)
                  setRovingIndex(0)
                }}
                onKeyDown={event => moveCategory(event, group)}
                size="xs"
                variant={activeGroup === group ? 'secondary' : 'ghost'}
              >
                {groupLabel(group, labels)}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div aria-live="polite" className="truncate" role="status">
              {status}
            </div>
            {documentMenu}
          </div>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-1 px-2 py-1">
        {layout !== 'wide' || activeGroup === 'write' ? styleSelector : null}
        <div className="flex min-w-0 items-center gap-0.5">{renderCommands(visibleCommands, visibleGroup)}</div>
        {layout === 'wide'
          ? activeGroup === 'page'
            ? pageControls
            : activeGroup === 'view'
              ? viewControls
              : null
          : null}
        {overflow}
        {layout !== 'wide' ? (
          <div
            aria-live="polite"
            className="ml-auto min-w-0 truncate text-[0.6875rem] text-(--atum-ink-muted)"
            role="status"
          >
            {status}
          </div>
        ) : null}
        {layout !== 'wide' ? documentMenu : null}
      </div>
    </div>
  )
}
