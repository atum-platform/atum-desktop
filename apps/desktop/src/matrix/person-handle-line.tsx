import { cn } from '@/lib/utils'

import { validMatrixHandle } from './person-name'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function personHandleText(handle: string | null | undefined): string | undefined {
  const valid = validMatrixHandle(handle?.replace(/^@/u, '') || undefined)

  return valid ? `@${valid}` : undefined
}

/** The handle unless it would only repeat the name (someone named by their handle). */
function shownHandle(handle: string | null | undefined, name: string | undefined) {
  const text = personHandleText(handle)

  return text && text !== name?.trim() ? text : undefined
}

/** The quiet second line under a name in a list that finds or picks people. */
export function PersonHandleLine({
  className,
  handle,
  id,
  name
}: {
  className?: string
  handle: string | null | undefined
  id?: string
  /** The name above it, so a handle that is the name is not said twice. */
  name?: string
}) {
  const text = shownHandle(handle, name)

  return text ? (
    <span
      className={cn('block truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)', className)}
      data-person-handle
      id={id}
    >
      {text}
    </span>
  ) : null
}

/**
 * A one-to-one chat row's handle, shown as its second line (where the latest message goes):
 * while nobody has written yet, the handle says who this is; once the chat has any message you
 * know them, so the line is the conversation's own and no handle shows. Finding someone (a
 * search) always shows it. Never beside the name.
 */
export function chatRowHandle({
  handle,
  hasMessages,
  name,
  searching = false
}: {
  handle: string | null | undefined
  hasMessages: boolean
  name?: string
  searching?: boolean
}): string | undefined {
  return searching || !hasMessages ? shownHandle(handle, name) : undefined
}
