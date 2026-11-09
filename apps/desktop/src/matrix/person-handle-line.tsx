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
 * The handle beside a name, for a chat row whose second line is its latest message (X's message
 * list: "Name @handle"). It gives way first when the row is narrow, so the name keeps its room.
 */
export function PersonHandleInline({ handle, name }: { handle: string | null | undefined; name?: string }) {
  const text = shownHandle(handle, name)

  return text ? (
    <span
      className="ms-1.5 min-w-0 shrink-[10] truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)"
      data-person-handle
    >
      {text}
    </span>
  ) : null
}
