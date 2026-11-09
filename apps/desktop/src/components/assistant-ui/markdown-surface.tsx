'use client'

import { TextMessagePartProvider, useMessagePartText } from '@assistant-ui/react'
import {
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps,
  tailBoundedRemend
} from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useMemo
} from 'react'
import { defaultRehypePlugins } from 'streamdown'
import type { PluggableList } from 'unified'

import { ExpandableBlock } from '@/components/chat/expandable-block'
import { chunkByLines, SyntaxHighlighter } from '@/components/chat/shiki-highlighter'
import { normalizeExternalUrl, PrettyLink, safeWebLink } from '@/lib/external-link'
import { createMemoizedMathPlugin } from '@/lib/katex-memo'
import { parseMarkdownIntoBlocksCached } from '@/lib/markdown-blocks'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'
import { cn } from '@/lib/utils'

import { detectEmbed, extractAlert, MarkdownAlert, RichCodeBlock, UrlEmbed } from './embeds'

/**
 * The assistant markdown renderer, without any tie to the desktop app's workspace:
 * the desktop app (markdown-text.tsx) adds its local media and preview links through
 * a host, and the Matrix window uses it as is. Keep this module free of the desktop
 * stores; the Matrix build refuses them.
 */
export interface MarkdownHost {
  /** Rewrites app-owned link syntax before Markdown parsing. It must leave code spans/fences and
   * every unrecognized string unchanged. */
  prepareMarkdown?: (text: string) => string
  /** Renders a link the app handles itself (a local file, media or preview target),
   * or returns null for an ordinary web link. */
  renderLink?: (href: string | undefined) => ReactNode | null
  /** Admits one app-owned link shape before the shared web-only policy. The host must return a
   * canonical URL or null; ordinary links still pass through `safeWebLink`. */
  resolveLink?: (href: string | undefined) => string | null
  /** Renders images; without it a web image is shown as a link. */
  Image?: ComponentType<ComponentProps<'img'>>
  /** Opens a web link; without it the desktop bridge opens it. */
  openLink?: (url: string) => void
}

const NO_HOST: MarkdownHost = {}
const MarkdownHostContext = createContext<MarkdownHost>(NO_HOST)

// Math rendering plugin (KaTeX). Configured once at module scope — the
// plugin is stateless beyond its internal cache so re-creating per-render
// would needlessly thrash. We use a memoizing wrapper around rehype-katex
// (see lib/katex-memo.ts) so that during streaming we re-katex only the
// equations whose source actually changed since the last token. With the
// stock @streamdown/math plugin every equation re-renders on every token,
// which throttles UI updates badly for math-heavy responses; the memoized
// plugin keeps the steady-state work proportional to "new equations
// arriving" rather than "equations × tokens-per-second".
//
// `singleDollarTextMath: true` enables `$x^2$` for inline math (de-facto
// LLM convention). The default false-setting only accepts `$$...$$`.
const mathPlugin = createMemoizedMathPlugin({ singleDollarTextMath: true })

// Streamdown's own HTML pipeline (raw HTML, then sanitize, then harden), with one change: a
// link or image the hardening step refuses (`javascript:`, `data:`, `file:`, a link still
// streaming in) keeps only its words or its description, inert, instead of an English
// "[blocked]" marker inside the message. Module scope: Streamdown compares it by identity.
const REHYPE_PLUGINS: PluggableList = Object.entries(defaultRehypePlugins).map(([name, plugin]) => {
  if (name === 'harden' && Array.isArray(plugin)) {
    const policy = plugin[1] as { allowedProtocols?: string[] }

    return [plugin[0], {
      ...policy,
      allowedProtocols: [...(policy.allowedProtocols ?? []), 'atum'],
      imageBlockPolicy: 'text-only',
      linkBlockPolicy: 'text-only'
    }]
  }
  if (name === 'sanitize' && Array.isArray(plugin)) {
    const schema = plugin[1] as { protocols?: Record<string, string[]> }

    return [plugin[0], {
      ...schema,
      protocols: {
        ...schema.protocols,
        // The shared component still renders this inert unless a host validates the exact URL.
        href: [...(schema.protocols?.href ?? []), 'atum']
      }
    }]
  }

  return plugin
}) as PluggableList

// Replaces Streamdown's `parseIncompleteMarkdown` (full-text remend per
// flush) with a tail-bounded repair. Must stay module-scope so the prop
// identity is stable across renders.
function preprocessWithTailRepair(text: string): string {
  try {
    return tailBoundedRemend(preprocessMarkdown(text))
  } catch {
    return text
  }
}

function childrenToText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children).trim()
  }

  if (Array.isArray(children) && children.every(c => typeof c === 'string' || typeof c === 'number')) {
    return children.join('').trim()
  }

  return ''
}

function MarkdownLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const host = useContext(MarkdownHostContext)
  const local = host.renderLink?.(href)

  if (local) {
    return local
  }

  const internal = host.resolveLink?.(href)
  const target = internal ?? safeWebLink(href)

  // Only a web address is a link. Anything else a message can carry (`javascript:`, `data:`,
  // `file:`, `mailto:`, a relative or protocol-relative path, a link still streaming in) keeps
  // its words as inert text: never an `<a href>`, nothing to click.
  if (!target) {
    return <span className="wrap-anywhere">{children}</span>
  }

  if (internal && host.openLink) {
    return (
      <a
        className={cn('wrap-anywhere font-semibold text-foreground underline underline-offset-4 decoration-current/20', className)}
        href={internal}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          host.openLink?.(internal)
        }}
        {...props}
      >
        {children}
      </a>
    )
  }

  const text = childrenToText(children)

  // Bare autolink → inline rich embed when a provider matches. Labeled links
  // (`[watch](url)`) stay plain. Desktop only (webview / iframe renderers).
  if (window.hermesDesktop && text && normalizeExternalUrl(text) === target) {
    const embed = detectEmbed(target)

    if (embed) {
      return <UrlEmbed descriptor={embed} />
    }
  }

  const fallbackLabel = text && normalizeExternalUrl(text) !== target ? text : undefined

  const open = host.openLink

  const onClick = open
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault()
        open(target)
      }
    : undefined

  return (
    <PrettyLink
      className={cn('wrap-anywhere', className)}
      fallbackLabel={fallbackLabel}
      href={target}
      {...props}
      {...(onClick ? { onClick } : {})}
    />
  )
}

/** Without a host that can load images, a web image is shown as its link (nothing is
 * fetched); any other source is its description only. */
function MarkdownImageLink({ alt, src }: ComponentProps<'img'>) {
  const target = typeof src === 'string' ? safeWebLink(src) : null

  if (!target) {
    return alt ? <span>{alt}</span> : null
  }

  return <PrettyLink fallbackLabel={alt || undefined} href={target} />
}

export interface MarkdownTextSurfaceProps {
  containerClassName?: string
  containerProps?: ComponentProps<'div'>
  defer?: boolean
  /** What the embedding app can do with local files; without it, only web links render. */
  host?: MarkdownHost
}

// Headings shrink to chat scale rather than the prose default (h1≈xl). Kept
// table-driven so adding/tweaking levels is one row.
const HEADING_SIZES: Record<'h1' | 'h2' | 'h3' | 'h4', string> = {
  h1: 'text-[1rem] tracking-tight',
  h2: 'text-[0.9375rem] tracking-tight',
  h3: 'text-[0.875rem]',
  h4: 'text-[0.8125rem]'
}

const MARKDOWN_CONTAINER_CLASS_NAME = cn(
  'aui-md prose w-full max-w-none overflow-hidden text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
  'prose-p:leading-(--dt-line-height) prose-li:leading-(--dt-line-height)',
  'prose-headings:text-foreground prose-strong:text-foreground',
  'prose-a:break-words prose-p:[overflow-wrap:anywhere]',
  'prose-li:marker:text-muted-foreground/70',
  'prose-code:rounded-[0.25rem] prose-code:px-[0.1875rem] prose-code:py-px prose-code:font-mono prose-code:text-[0.9em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-(--paragraph-gap)'
)

const MAX_MARKDOWN_CHARS = 200_000

function HugeTextFallback({ containerClassName, text }: { containerClassName?: string; text: string }) {
  const chunks = useMemo(() => chunkByLines(text, 200), [text])

  return (
    <div
      className={cn(
        'aui-md w-full max-w-none overflow-hidden rounded-[0.625rem] border border-border font-mono text-[0.7rem] leading-relaxed text-foreground/90',
        containerClassName
      )}
    >
      <ExpandableBlock className="p-2">
        {chunks.map((chunk, index) => (
          <div
            className="[content-visibility:auto]"
            key={index}
            style={{ containIntrinsicSize: `auto ${chunk.lines * 16}px` }}
          >
            {chunk.text}
          </div>
        ))}
      </ExpandableBlock>
    </div>
  )
}

export function MarkdownTextSurface({ containerClassName, containerProps, defer, host }: MarkdownTextSurfaceProps) {
  const { status, text } = useMessagePartText()
  const isStreaming = status.type === 'running'

  // Keep code parsing enabled while streaming so incomplete fenced blocks still
  // render as code cards. The expensive Shiki pass is deferred by
  // `SyntaxHighlighter` below when `isStreaming` is true.
  const plugins = useMemo(() => ({ math: mathPlugin, code }), [])
  const preprocess = useMemo(
    () => host?.prepareMarkdown
      ? (value: string) => preprocessWithTailRepair(host.prepareMarkdown!(value))
      : preprocessWithTailRepair,
    [host]
  )

  const components = useMemo(
    () =>
      ({
        h1: ({ className, ...props }: ComponentProps<'h1'>) => (
          <h1 className={cn('my-1 font-semibold', HEADING_SIZES.h1, className)} {...props} />
        ),
        h2: ({ className, ...props }: ComponentProps<'h2'>) => (
          <h2 className={cn('my-1 font-semibold', HEADING_SIZES.h2, className)} {...props} />
        ),
        h3: ({ className, ...props }: ComponentProps<'h3'>) => (
          <h3 className={cn('my-1 font-semibold', HEADING_SIZES.h3, className)} {...props} />
        ),
        h4: ({ className, ...props }: ComponentProps<'h4'>) => (
          <h4 className={cn('my-1 font-semibold', HEADING_SIZES.h4, className)} {...props} />
        ),
        p: ({ className, ...props }: ComponentProps<'p'>) => (
          // Vertical rhythm is owned by styles.css (`--paragraph-gap`), which
          // must out-specify Tailwind Typography's `prose` margins — so no
          // `my-*` here on purpose.
          <p className={cn('wrap-anywhere leading-(--dt-line-height)', className)} {...props} />
        ),
        a: MarkdownLink,
        // Inline code must not vote when an ancestor resolves `dir="auto"`
        // (HTML's algorithm skips descendants that carry their own dir),
        // mirroring the CSS isolate that already keeps it out of the
        // plaintext scan. Fenced code never reaches this override; it goes
        // through the code plugin's CodeCard path.
        inlineCode: ({ className, ...props }: ComponentProps<'code'>) => (
          <code className={className} dir="ltr" {...props} />
        ),
        // `---` as quiet spacing, not a heavy full-width rule.
        hr: (_props: ComponentProps<'hr'>) => <div aria-hidden className="my-3" />,
        // Lists and blockquotes have chrome that sits *beside* the text
        // (markers, the quote border), and that side is driven by the CSS
        // `direction` of the box, which `unicode-bidi: plaintext` never
        // touches — an RTL list otherwise renders its numbers stranded at
        // the far left. `dir="auto"` lets the browser resolve the box
        // direction from content; the plaintext rules in styles.css keep
        // owning per-line text direction. Inline code carries `dir="ltr"`
        // (see the `code` override) so it doesn't vote here either, same
        // contract as the CSS isolate.
        // A `> [!NOTE]`/`[!WARNING]`/... blockquote renders as a GFM alert
        // callout; everything else stays a plain quote.
        blockquote: ({ children, className, ...props }: ComponentProps<'blockquote'>) => {
          const alert = extractAlert(children)

          if (alert) {
            return <MarkdownAlert type={alert.type}>{alert.body}</MarkdownAlert>
          }

          return (
            <blockquote
              className={cn('border-s-2 border-border ps-3 text-muted-foreground italic', className)}
              dir="auto"
              {...props}
            >
              {children}
            </blockquote>
          )
        },
        ul: ({ className, ...props }: ComponentProps<'ul'>) => (
          <ul className={cn('my-1 gap-0', className)} dir="auto" {...props} />
        ),
        ol: ({ className, ...props }: ComponentProps<'ol'>) => (
          <ol className={cn('my-1 gap-0', className)} dir="auto" {...props} />
        ),
        li: ({ className, ...props }: ComponentProps<'li'>) => (
          <li className={cn('leading-(--dt-line-height)', className)} {...props} />
        ),
        table: ({ className, ...props }: ComponentProps<'table'>) => (
          <div className="aui-md-table my-2 max-w-full overflow-x-auto rounded-[0.375rem] border border-border">
            <table
              className={cn(
                'm-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-border last:[&_tr]:border-0',
                className
              )}
              {...props}
            />
          </div>
        ),
        thead: ({ className, ...props }: ComponentProps<'thead'>) => (
          <thead className={cn('m-0 bg-muted/35 text-muted-foreground', className)} {...props} />
        ),
        th: ({ className, ...props }: ComponentProps<'th'>) => (
          <th
            className={cn(
              'whitespace-nowrap px-2.5 py-1.5 text-left align-middle text-[0.75rem] font-medium text-muted-foreground',
              className
            )}
            {...props}
          />
        ),
        td: ({ className, ...props }: ComponentProps<'td'>) => (
          <td className={cn('px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug', className)} {...props} />
        ),
        img: host?.Image ?? MarkdownImageLink,
        // ```mermaid / ```svg fences route to their lazy renderers; every other
        // language falls back to the Shiki-highlighted code block.
        SyntaxHighlighter: (props: SyntaxHighlighterProps) => (
          <RichCodeBlock
            code={props.code}
            fallback={<SyntaxHighlighter {...props} defer={isStreaming} />}
            language={props.language}
            streaming={isStreaming}
          />
        )
      }) as StreamdownTextComponents,
    [host, isStreaming]
  )

  if (text.length > MAX_MARKDOWN_CHARS) {
    return <HugeTextFallback containerClassName={containerClassName} text={text} />
  }

  return (
    <MarkdownHostContext.Provider value={host ?? NO_HOST}>
      <StreamdownTextPrimitive
      components={components}
      containerClassName={cn(MARKDOWN_CONTAINER_CLASS_NAME, containerClassName)}
      containerProps={containerProps}
      defer={defer}
      lineNumbers={false}
      mode="streaming"
      // Incomplete-markdown repair runs in preprocessWithTailRepair on the
      // full accumulated text; the built-in tail-bounded remend is disabled
      // because a custom parseMarkdownIntoBlocksFn is supplied, and
      // parseIncompleteMarkdown stays false to avoid a second full-text
      // remend pass.
      parseIncompleteMarkdown={false}
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocksCached}
      plugins={plugins}
      preprocess={preprocess}
      rehypePlugins={REHYPE_PLUGINS}
      />
    </MarkdownHostContext.Provider>
  )
}

export interface MarkdownTextContentProps extends MarkdownTextSurfaceProps {
  isRunning: boolean
  text: string
}

/** Markdown for a standalone text (not a message part), e.g. reasoning or a live answer. */
export function MarkdownContent({ isRunning, text, ...surfaceProps }: MarkdownTextContentProps) {
  // No `smooth` on purpose — same as the assistant answer. `TextMessagePartProvider`
  // mints a fresh part object on every `text` change, and useSmooth resets its
  // reveal to empty whenever the part identity changes, so a smoothed reasoning
  // stream re-types from the first character on every delta (the flash). Token-
  // streaming reasoners (R1/Qwen/GLM/Claude thinking) hit it hardest; GPT-5's
  // coarse summary updates too rarely to notice. Plain append matches the answer.
  return (
    <TextMessagePartProvider isRunning={isRunning} text={text}>
      <MarkdownTextSurface defer {...surfaceProps} />
    </TextMessagePartProvider>
  )
}
