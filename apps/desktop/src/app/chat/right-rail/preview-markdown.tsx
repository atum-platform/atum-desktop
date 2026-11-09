/**
 * preview-markdown.tsx
 *
 * The preview rail's Markdown body. Extracted from `preview-file.tsx` so the
 * `.md` preview and the `.docx` document view render through exactly the same
 * typography — the docx route converts OOXML to Markdown precisely so it can
 * reuse this and inherit the app's tokens in both themes.
 *
 * Streamdown does the parse; these components keep typography simple and route
 * fenced code through Shiki without the library's copy/download/fullscreen
 * chrome.
 */

import type * as React from 'react'
import type { ComponentProps } from 'react'
import ShikiHighlighter from 'react-shiki'
import { Streamdown } from 'streamdown'

import { RichCodeBlock } from '@/components/assistant-ui/embeds'
import { cn } from '@/lib/utils'

const SHIKI_THEME = { dark: 'github-dark-default', light: 'github-light-default' } as const

const MD_TAG_CLASSES = {
  h1: 'mb-3 mt-6 text-3xl font-bold leading-tight tracking-tight first:mt-0',
  h2: 'mb-2.5 mt-5 text-2xl font-semibold leading-snug tracking-tight first:mt-0',
  h3: 'mb-2 mt-4 text-xl font-semibold leading-snug first:mt-0',
  h4: 'mb-2 mt-3 text-base font-semibold leading-snug first:mt-0',
  p: 'mb-4 leading-relaxed text-foreground last:mb-0',
  ul: 'mb-4 list-disc pl-6 marker:text-muted-foreground/70 last:mb-0',
  ol: 'mb-4 list-decimal pl-6 marker:text-muted-foreground/70 last:mb-0',
  li: 'mt-1 leading-relaxed',
  blockquote: 'mb-4 border-l-2 border-border pl-3 text-muted-foreground italic last:mb-0',
  pre: 'mb-4 overflow-hidden rounded-lg border border-border bg-card font-mono text-xs leading-relaxed last:mb-0 [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:font-mono',
  // Tables arrive from Word documents (the docx route emits GFM tables), so
  // they need to read at projector distance rather than inherit browser
  // defaults. Header row is the only tint; borders stay hairline.
  table: 'mb-4 block w-full overflow-x-auto border-collapse text-[0.8125rem] last:mb-0',
  thead: 'border-b border-border',
  th: 'px-2.5 py-1.5 text-left font-semibold text-foreground',
  td: 'border-t border-border/50 px-2.5 py-1.5 align-top'
} as const

function tagged<T extends keyof typeof MD_TAG_CLASSES>(Tag: T) {
  const base = MD_TAG_CLASSES[Tag]

  const Component = (({ className, ...rest }: ComponentProps<T>) => {
    const Element = Tag as React.ElementType

    return <Element className={cn(base, className)} {...rest} />
  }) as React.FC<ComponentProps<T>>

  Component.displayName = `Md.${Tag}`

  return Component
}

function MarkdownCode({ className, children, ...props }: ComponentProps<'code'>) {
  const language = /language-([^\s]+)/.exec(className || '')?.[1]

  if (!language) {
    return (
      <code
        className={cn(
          'rounded bg-muted px-1 py-0.5 font-mono text-[0.86em] text-pink-700 dark:text-pink-300',
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  }

  const code = String(children).replace(/\n$/, '')

  const highlighted = (
    <ShikiHighlighter
      addDefaultStyles={false}
      as="div"
      defaultColor="light-dark()"
      delay={80}
      language={language}
      showLanguage={false}
      theme={SHIKI_THEME}
    >
      {code}
    </ShikiHighlighter>
  )

  // ```mermaid / ```svg fences route to the shared lazy renderers (same
  // registry the chat transcript uses); everything else stays on Shiki.
  return <RichCodeBlock code={code} fallback={highlighted} language={language} />
}

const MARKDOWN_COMPONENTS = {
  h1: tagged('h1'),
  h2: tagged('h2'),
  h3: tagged('h3'),
  h4: tagged('h4'),
  p: tagged('p'),
  ul: tagged('ul'),
  ol: tagged('ol'),
  li: tagged('li'),
  blockquote: tagged('blockquote'),
  pre: tagged('pre'),
  code: MarkdownCode,
  table: tagged('table'),
  thead: tagged('thead'),
  th: tagged('th'),
  td: tagged('td')
}

export function MarkdownPreview({ className, text }: { className?: string; text: string }) {
  return (
    <div
      className={cn('preview-markdown mx-auto max-w-3xl px-4 py-3 text-sm text-foreground', className)}
      data-selectable-text="true"
    >
      <Streamdown components={MARKDOWN_COMPONENTS} controls={false} mode="static" parseIncompleteMarkdown={false}>
        {text}
      </Streamdown>
    </div>
  )
}

