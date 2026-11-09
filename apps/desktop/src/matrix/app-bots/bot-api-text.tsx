import { type ReactNode, useMemo } from 'react'

import type { MatrixBotApiMessage } from '../../../shared/matrix'

import { safeBotApiButtonUrl } from './bot-api'

const ALLOWED = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'i',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'u'
])

/** One link from the platform's already-sanitized Matrix HTML. Main validates again before
 * opening it; this pass keeps unsafe schemes and embedded credentials out of the DOM. */
export function safeBotApiLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    return undefined
  }

  try {
    const url = new URL(value)

    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return value
    }

    if (url.protocol !== 'mailto:' || url.hash) {
      return undefined
    }

    const fields = [...url.searchParams.keys()]
    const address = decodeURIComponent(url.pathname)

    return /^[^@\s,;]+@[^@\s,;]+$/u.test(address) &&
      fields.every(field => field === 'subject' || field === 'body') &&
      new Set(fields).size === fields.length
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function openLink(url: string): void {
  void window.atumMatrix?.openLink(url).catch(() => {})
}

/** Telegram-style URL buttons, preserving the app's declared rows. The strict metadata parser
 * admits only bounded HTTPS URLs; this component checks again before creating an action. */
export function MatrixBotApiKeyboard({
  keyboard,
  onOpenLink = openLink
}: {
  keyboard: MatrixBotApiMessage['keyboard']
  onOpenLink?: (url: string) => void
}) {
  if (
    !keyboard?.length ||
    keyboard.length > 8 ||
    keyboard.some(
      row =>
        row.length < 1 ||
        row.length > 4 ||
        row.some(
          button =>
            button.kind !== 'url' ||
            button.label.length < 1 ||
            button.label.length > 64 ||
            safeBotApiButtonUrl(button.url) === undefined
        )
    )
  ) {
    return null
  }

  return (
    <div className="mt-2 flex max-w-[26rem] flex-col gap-1.5" data-matrix-bot-api-keyboard>
      {keyboard.map((row, rowIndex) => (
        <div
          className="grid gap-1.5"
          data-matrix-bot-api-keyboard-row={rowIndex}
          key={rowIndex}
          style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
        >
          {row.map((button, buttonIndex) => (
            <button
              className="ak-btn ak-btn--plain ak-btn--sm min-w-0 w-full h-auto min-h-(--ak-h-sm) break-words text-center whitespace-normal"
              data-matrix-bot-api-button
              key={`${buttonIndex}:${button.label}:${button.url}`}
              onClick={() => onOpenLink(button.url)}
              type="button"
            >
              {button.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function renderNode(node: Node, key: string, onOpenLink: (url: string) => void): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? ''
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null
  }

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  const children = [...element.childNodes].map((child, index) => renderNode(child, `${key}:${index}`, onOpenLink))

  if (!ALLOWED.has(tag)) {
    return <span key={key}>{children}</span>
  }

  switch (tag) {
    case 'br':
      return <br key={key} />
    case 'strong':
    case 'b':
      return <strong key={key}>{children}</strong>
    case 'em':
    case 'i':
      return <em key={key}>{children}</em>
    case 'u':
      return <u key={key}>{children}</u>
    case 's':
    case 'del':
      return <s key={key}>{children}</s>
    case 'code':
      return (
        <code className="rounded bg-(--atum-sunk) px-1 py-0.5 font-mono text-[0.9em]" key={key}>
          {children}
        </code>
      )
    case 'pre':
      return (
        <pre className="overflow-x-auto rounded bg-(--atum-sunk) p-2 font-mono text-xs" key={key}>
          {children}
        </pre>
      )
    case 'blockquote':
      return (
        <blockquote
          className="my-2 border-s-2 border-(--atum-border) ps-3 text-(--atum-ink-muted)"
          dir="auto"
          key={key}
        >
          {children}
        </blockquote>
      )
    case 'p':
      return (
        <p className="my-1 first:mt-0 last:mb-0" key={key}>
          {children}
        </p>
      )
    case 'span':
      return element.hasAttribute('data-mx-spoiler') ? (
        <span
          className="rounded bg-(--atum-ink) px-0.5 text-transparent hover:bg-(--atum-sunk) hover:text-inherit focus:bg-(--atum-sunk) focus:text-inherit focus:outline-2 focus:outline-(--atum-accent)"
          data-matrix-bot-api-spoiler
          key={key}
          tabIndex={0}
        >
          {children}
        </span>
      ) : (
        <span key={key}>{children}</span>
      )
    case 'a': {
      const href = safeBotApiLink(element.getAttribute('href'))

      return href ? (
        <a
          className="font-medium text-(--atum-accent) underline underline-offset-2"
          href={href}
          key={key}
          onClick={event => {
            event.preventDefault()
            onOpenLink(href)
          }}
          rel="noopener noreferrer"
          target="_blank"
        >
          {children}
        </a>
      ) : (
        <span key={key}>{children}</span>
      )
    }
    default:
      return <span key={key}>{children}</span>
  }
}

function formatted(formattedBody: string, onOpenLink: (url: string) => void): ReactNode[] | null {
  try {
    const document = new DOMParser().parseFromString(formattedBody, 'text/html')
    const nodes = [...document.body.childNodes]

    return nodes.map((node, index) => renderNode(node, String(index), onOpenLink))
  } catch {
    return null
  }
}

/**
 * Bot-api text is already parsed by the platform into a bounded Matrix HTML subset (v1.1 §5).
 * Only that subset renders here, through typed React nodes; `formatted_body` never reaches
 * `innerHTML`, and only an http(s) or mailto link reaches main's second validation boundary.
 */
export function MatrixBotApiText({
  body,
  formattedBody,
  onOpenLink = openLink
}: {
  body: string
  formattedBody?: string
  onOpenLink?: (url: string) => void
}) {
  const content = useMemo(
    () => (formattedBody ? formatted(formattedBody, onOpenLink) : null),
    [formattedBody, onOpenLink]
  )

  if (content) {
    return (
      <div className="whitespace-pre-wrap break-words" data-matrix-bot-api-text>
        {content}
      </div>
    )
  }

  return (
    <span className="whitespace-pre-wrap break-words" data-matrix-bot-api-text>
      {body}
    </span>
  )
}
