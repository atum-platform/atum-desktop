import {
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
  useMessagePartReasoning
} from '@assistant-ui/react'
import { type ComponentProps, type FC, type ReactNode } from 'react'

import { ClarifyTool } from '@/components/assistant-ui/clarify-tool'
import { MarkdownText, MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { ToolFallback, ToolGroupSlot } from '@/components/assistant-ui/tool/fallback'
import { GeneratedImage } from '@/components/chat/generated-image-result'
import { generatedImageFromResult } from '@/lib/generated-images'

import { ThinkingDisclosure } from './thinking-disclosure'

const ImageGenerateTool: FC<ToolCallMessagePartProps> = props => {
  const { args, result } = props
  const aspectRatio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : undefined

  // The image card owns successful generations. Failed or malformed results
  // still need the normal tool row: it extracts the error text and gives the
  // user an honest, expandable failure rather than silently dropping the call.
  if (result !== undefined && !generatedImageFromResult(result)) {
    return <ToolFallback {...props} />
  }

  return (
    <div className="mt-1.5">
      <GeneratedImage aspectRatio={aspectRatio} result={result} />
    </div>
  )
}

const ChainToolFallback: FC<ToolCallMessagePartProps> = props => {
  // todo parts are hoisted to a dedicated panel above the message content.
  if (props.toolName === 'todo') {
    return null
  }

  if (props.toolName === 'image_generate') {
    return <ImageGenerateTool {...props} />
  }

  if (props.toolName === 'clarify') {
    return <ClarifyTool {...props} />
  }

  return <ToolFallback {...props} />
}

// Self-gate "Thinking…" on this message's own reasoning parts. Reading
// `thread.isRunning` directly would flicker shimmer/timer on every old
// assistant whenever the external-store runtime clears+reimports its
// repository (one ref-identity bump per streaming delta).
const ReasoningAccordionGroup: FC<{ children?: ReactNode; endIndex: number; startIndex: number }> = ({
  children,
  endIndex,
  startIndex
}) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  const pending = useAuiState(
    s =>
      s.thread.isRunning &&
      s.message.status?.type === 'running' &&
      s.message.parts
        .slice(Math.max(0, startIndex), endIndex + 1)
        .some(p => p?.type === 'reasoning' && p.status?.type !== 'complete')
  )

  // A reasoning group with no actual text is pure noise — drop the whole
  // "Thinking" disclosure rather than leave an empty header eating a row. This
  // applies live too: encrypted/spinner-coerced reasoning (Opus reasoning max)
  // never carries visible text, and the bottom-of-thread loader already signals
  // "thinking", so an empty header is never wanted. Real reasoning surfaces the
  // instant its first token lands.
  const hasContent = useAuiState(s =>
    s.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .some(p => p?.type === 'reasoning' && typeof p.text === 'string' && p.text.trim().length > 0)
  )

  if (!hasContent) {
    return null
  }

  return (
    <ThinkingDisclosure messageRunning={messageRunning} pending={pending} timerKey={`reasoning:${messageId}`}>
      {children}
    </ThinkingDisclosure>
  )
}

// Read the part from context, same contract as MarkdownText's
// useMessagePartText — the reasoning-only smoothing wrapper (removed) stalled
// the char-reveal at empty, blanking the widget.
const ReasoningTextPart: ReasoningMessagePartComponent = () => {
  const { status, text } = useMessagePartReasoning()
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  return (
    <MarkdownTextContent
      containerClassName="text-xs leading-snug text-muted-foreground/85"
      containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
      isRunning={status.type === 'running' || messageRunning}
      text={text.trimStart()}
    />
  )
}

// Module-level constant so the `components` prop on `MessagePrimitive.Parts`
// has a stable identity across renders. Without this every AssistantMessage
// render would create a fresh `components` object, invalidating the memo on
// `MessagePrimitivePartByIndex` and forcing every tool/reasoning child to
// re-render on every streaming delta. Memo invalidation alone doesn't
// remount, but combined with the previous ToolFallback group-swap it was a
// big chunk of the per-delta work.
export const MESSAGE_PARTS_COMPONENTS = {
  Reasoning: ReasoningTextPart,
  ReasoningGroup: ReasoningAccordionGroup,
  Text: MarkdownText,
  ToolGroup: ToolGroupSlot,
  tools: { Fallback: ChainToolFallback }
} as const
