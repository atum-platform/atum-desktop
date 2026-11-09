'use client'

import type { Unstable_DirectiveFormatter, Unstable_DirectiveSegment, Unstable_TriggerItem } from '@assistant-ui/core'
import type { TextMessagePartComponent, TextMessagePartProps } from '@assistant-ui/react'
import { type AkIconName, akIconPaths } from '@atum/kit/icon'
import type { FC } from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { extractEmbeddedImages } from '@/lib/embedded-images'
import { gatewayMediaDataUrl, isRemoteGateway } from '@/lib/media'

const HERMES_REF_TYPES = ['file', 'folder', 'url', 'image', 'tool', 'line', 'terminal', 'session'] as const
type HermesRefType = (typeof HERMES_REF_TYPES)[number]

/** Chip icon glyphs: the app's Phosphor icons (Atum Kit 0.1), by name. Used both by the rendered
 * <DirectiveIcon> and the raw SVG markup the contenteditable composer embeds via `directiveIconSvg`. */
const ICON_NAMES: Record<HermesRefType, AkIconName> = {
  file: 'file-text',
  folder: 'folder-open',
  url: 'link',
  image: 'image',
  tool: 'wrench',
  line: 'hash',
  terminal: 'terminal',
  session: 'chat-text'
}

const ICON_FALLBACK: AkIconName = 'at'

const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"'

const CHIP_ICON_CLASS = 'atum-icon size-3 shrink-0 opacity-80'

const iconPathsFor = (type: string) => akIconPaths(ICON_NAMES[type as HermesRefType] ?? ICON_FALLBACK)

/** SVG markup string for embedding directly in HTML (composer contenteditable). */
export function directiveIconSvg(type: string) {
  const inner = iconPathsFor(type)
    .map(d => `<path d="${d}"/>`)
    .join('')

  return `<svg ${SVG_ATTRS} class="${CHIP_ICON_CLASS}">${inner}</svg>`
}

function iconElementFromPaths(paths: readonly string[]) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', CHIP_ICON_CLASS)
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('viewBox', '0 0 256 256')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}

export function directiveIconElement(type: string) {
  return iconElementFromPaths(iconPathsFor(type))
}

/** Slash-command pill. The composer inserts these chips when a command is
 *  picked. All three kinds share one sunk chip in soft ink; the icon tells
 *  commands, skills and themes apart (Atum icon system: ink only). */
export type SlashChipKind = 'command' | 'skill' | 'theme'

const SLASH_ICON_NAMES: Record<SlashChipKind, AkIconName> = {
  command: 'terminal',
  skill: 'lightning',
  theme: 'paint-brush'
}

const SLASH_CHIP_TONE =
  'bg-[var(--atum-sunk,color-mix(in_srgb,currentColor_8%,transparent))] text-[var(--atum-ink-soft,var(--foreground))]'

export const SLASH_CHIP_BASE_CLASS =
  'mx-0.5 inline-flex max-w-64 items-center gap-1 rounded px-1.5 py-0.5 align-middle text-[0.86em] font-medium leading-none'

export function slashChipClass(_kind: SlashChipKind): string {
  return `${SLASH_CHIP_BASE_CLASS} ${SLASH_CHIP_TONE}`
}

export function slashIconElement(kind: SlashChipKind) {
  return iconElementFromPaths(akIconPaths(SLASH_ICON_NAMES[kind]))
}

const DirectiveIcon: FC<{ type: string }> = ({ type }) => (
  <svg className={CHIP_ICON_CLASS} fill="currentColor" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    {iconPathsFor(type).map(d => (
      <path d={d} key={d} />
    ))}
  </svg>
)

/** Shared chip styling — used by both the rendered <DirectiveChip> and the
 * raw HTML composer chips in `rich-editor.ts`. Neutral subtle wash + plain
 * muted-foreground text so chips read as quiet tags on any bubble color. */
export const DIRECTIVE_CHIP_CLASS =
  'mx-0.5 inline-flex max-w-56 items-center gap-1 rounded px-1.5 py-0.5 align-middle text-[0.86em] font-normal leading-none bg-[color-mix(in_srgb,currentColor_8%,transparent)] text-muted-foreground'

/**
 * Parses our composer's `@type:value` references into directive segments
 * so they render as inline chips in user messages instead of raw text.
 *
 * Supported types: file, folder, url, image. Anything else stays plain text.
 *
 * Mirrors the Python `agent/context_references.REFERENCE_PATTERN` syntax:
 * the value may be wrapped in backticks, single quotes, or double quotes so
 * paths with spaces/parens/etc. survive parsing intact.
 */
const CANONICAL_DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/g

const HERMES_DIRECTIVE_RE = new RegExp(
  '@(file|folder|url|image|tool|line|terminal|session):(' +
    '`[^`\\n]+`' +
    '|"[^"\\n]+"' +
    "|'[^'\\n]+'" +
    '|\\S+' +
    ')',
  'g'
)

const TRAILING_PUNCTUATION_RE = /[,.;!?]+$/

function unwrapRefValue(raw: string): string {
  if (raw.length < 2) {
    return raw
  }

  const head = raw[0]
  const tail = raw[raw.length - 1]

  if ((head === '`' && tail === '`') || (head === '"' && tail === '"') || (head === "'" && tail === "'")) {
    return raw.slice(1, -1)
  }

  return raw.replace(TRAILING_PUNCTUATION_RE, '')
}

function needsQuoting(value: string): boolean {
  return /[\s()[\]{}<>"'`]/.test(value)
}

export function formatRefValue(value: string): string {
  if (!needsQuoting(value)) {
    return value
  }

  if (!value.includes('`')) {
    return `\`${value}\``
  }

  if (!value.includes('"')) {
    return `"${value}"`
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  return value
}

export const hermesDirectiveFormatter: Unstable_DirectiveFormatter = {
  serialize(item: Unstable_TriggerItem): string {
    const metadata = item.metadata as { rawText?: unknown; insertId?: unknown } | undefined
    const rawText = typeof metadata?.rawText === 'string' ? metadata.rawText : null
    const insertId = typeof metadata?.insertId === 'string' ? metadata.insertId : null

    // Live-completion items carry the gateway's original `text` field via metadata.
    if (rawText) {
      // Palette starters (`@file:` with empty value) — insert verbatim so the
      // user can keep typing the path inline.
      if (rawText.endsWith(':') && !insertId) {
        return rawText
      }

      // Simple references like `@diff` / `@staged`.
      if (!insertId) {
        return rawText
      }

      // Typed references with a value — quote when needed.
      const kindMatch = rawText.match(/^@([^:]+):/)
      const kind = kindMatch?.[1] ?? item.type

      return `@${kind}:${formatRefValue(insertId)}`
    }

    // Fallback for legacy callers that pass raw `id` strings.
    if (item.id === `${item.type}:`) {
      return `@${item.id}`
    }

    return `@${item.type}:${formatRefValue(item.id)}`
  },
  parse(text: string): readonly Unstable_DirectiveSegment[] {
    return parseDirectiveText(text)
  }
}

function parseDirectiveText(text: string): Unstable_DirectiveSegment[] {
  const matches = [
    ...Array.from(text.matchAll(CANONICAL_DIRECTIVE_RE)).map(match => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      type: match[1] || 'tool',
      label: match[2] || match[3] || '',
      id: match[3] || match[2] || ''
    })),
    ...Array.from(text.matchAll(HERMES_DIRECTIVE_RE)).map(match => {
      const id = unwrapRefValue(match[2] || '')

      return {
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        type: match[1] || 'file',
        label: shortLabel(match[1] as HermesRefType, id),
        id
      }
    })
  ]
    .filter(match => match.id)
    .sort((a, b) => a.start - b.start)

  const segments: Unstable_DirectiveSegment[] = []
  let cursor = 0

  for (const match of matches) {
    if (match.start < cursor) {
      continue
    }

    if (match.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.start) })
    }

    segments.push({
      kind: 'mention',
      type: match.type,
      label: match.label,
      id: match.id
    })
    cursor = match.end
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }

  return segments
}

function shortLabel(type: HermesRefType, id: string): string {
  if (type === 'terminal') {
    return id || 'terminal'
  }

  if (type === 'url') {
    try {
      const parsed = new URL(id)

      return parsed.hostname || id
    } catch {
      return id
    }
  }

  // `@session:<profile>/<id>` — show a short id; the composer chip carries the
  // friendly title, but once sent the wire form only has the id.
  if (type === 'session') {
    const sid = id.split('/').filter(Boolean).pop() || id

    return sid.length > 10 ? `${sid.slice(0, 8)}…` : sid
  }

  const tail = id.split(/[\\/]/).filter(Boolean).pop()

  return tail || id
}

function safeEmbeddedImages(text: string) {
  try {
    return extractEmbeddedImages(text)
  } catch {
    return { cleanedText: text, images: [] as string[] }
  }
}

function safeDirectiveSegments(text: string): Unstable_DirectiveSegment[] {
  try {
    return [...hermesDirectiveFormatter.parse(text)]
  } catch {
    return [{ kind: 'text', text }]
  }
}

/**
 * Renders text containing Hermes directives (`@file:...`, `@image:...`) as
 * inline chips. Embedded MEDIA images render below as a thumbnail row.
 */
export function DirectiveContent({ text }: { text: string }) {
  const { cleanedText, images } = useMemo(() => safeEmbeddedImages(text ?? ''), [text])
  const segments = useMemo(() => safeDirectiveSegments(cleanedText), [cleanedText])

  return (
    <span className="whitespace-pre-line" data-slot="aui_directive-text">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={`t-${index}`}>{segment.text}</Fragment>
        ) : segment.type === 'image' ? (
          <DirectiveImage id={segment.id} key={`img-${index}-${segment.id}`} label={segment.label} />
        ) : (
          <DirectiveChip id={segment.id} key={`m-${index}-${segment.id}`} label={segment.label} type={segment.type} />
        )
      )}
      {images.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-2" data-slot="aui_embedded-images">
          {images.map((src, index) => (
            <ZoomableImage
              alt=""
              className="max-h-48 max-w-full rounded-lg border border-border/60 object-contain"
              draggable={false}
              key={`img-${index}`}
              slot="aui_embedded-image"
              src={src}
            />
          ))}
        </span>
      )}
    </span>
  )
}

/** assistant-ui adapter: same renderer, exposed as a TextMessagePartComponent. */
export const DirectiveText: TextMessagePartComponent = ({ text }: TextMessagePartProps) => (
  <DirectiveContent text={text ?? ''} />
)

/** Image refs render as a thumbnail rather than a chip — matches how persisted
 * messages render after the backend embeds the data URL, so the UX is stable
 * across initial send and refresh. */
const DirectiveImage: FC<{ id: string; label: string }> = ({ id, label }) => {
  const isUrl = /^(?:https?|data):/i.test(id)
  const [src, setSrc] = useState<string | null>(isUrl ? id : null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (isUrl || !id) {
      return
    }

    let alive = true

    // Remote gateway: the image lives on the gateway's disk, not ours — fetch
    // it over the authenticated API. Local: read it straight off this disk.
    const load =
      window.hermesDesktop && isRemoteGateway() ? gatewayMediaDataUrl(id) : window.hermesDesktop?.readFileDataUrl(id)

    void Promise.resolve(load)
      .then(url => alive && url && setSrc(url))
      .catch(() => alive && setFailed(true))

    return () => {
      alive = false
    }
  }, [id, isUrl])

  if (failed) {
    return <DirectiveChip id={id} label={label} type="image" />
  }

  if (!src) {
    return (
      <span
        aria-hidden
        className="inline-block size-12 shrink-0 animate-pulse rounded-md bg-[color-mix(in_srgb,currentColor_8%,transparent)]"
      />
    )
  }

  return (
    <ZoomableImage
      alt={label}
      className="max-h-32 max-w-48 rounded-md border border-border/40 object-contain"
      draggable={false}
      slot="aui_directive-image"
      src={src}
    />
  )
}

const DirectiveChip: FC<{
  type: string
  label: string
  id: string
}> = ({ type, label, id }) => (
  <span
    className={DIRECTIVE_CHIP_CLASS}
    data-directive-id={id}
    data-directive-type={type}
    data-slot="aui_directive-chip"
    title={id}
  >
    <DirectiveIcon type={type} />
    <span className="truncate">{label}</span>
  </span>
)
