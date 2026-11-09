import { useStore } from '@nanostores/react'
import { useRef } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { $threadJumpButtonVisible, requestScrollToBottom } from '@/store/thread-scroll'

interface ThreadScrollToBottomButtonProps {
  approval?: boolean
  /** The composer floats over the viewport's foot and reports its height as `--atum-dock-height`:
   * sit just above it. (Without that variable this is the viewport's own foot.) */
  inViewport?: boolean
}

/** Shared scroll control, without the legacy gateway's session/approval stores.
 * ThreadMessageList remains the only scroll owner. This just requests a jump. */
export function ThreadScrollToBottomButton({ approval = false, inViewport = false }: ThreadScrollToBottomButtonProps) {
  const { t } = useI18n()
  const visible = useStore($threadJumpButtonVisible)
  const hasShownRef = useRef(false)

  if (visible) {
    hasShownRef.current = true
  }

  const state = visible ? 'in' : hasShownRef.current ? 'out' : 'idle'
  const label = approval ? t.assistant.approval.jumpToApproval : t.assistant.thread.scrollToBottom

  return (
    <Tip label={label}>
      <button
        aria-hidden={!visible}
        aria-label={label}
        className={cn(
          'thread-jump-button absolute left-1/2 z-20 grid place-items-center backdrop-blur-[0.75rem] [-webkit-backdrop-filter:blur(0.75rem)]',
          approval
            ? 'h-8 grid-flow-col gap-1.5 rounded-full border border-primary/40 bg-(--composer-fill) px-3 text-primary hover:bg-primary/10'
            : 'size-8 rounded-full border border-border/65 bg-(--composer-fill) text-muted-foreground hover:text-foreground',
          !visible && 'pointer-events-none'
        )}
        // A strolling companion steps around it rather than standing over it.
        data-pet-avoid={visible ? '' : undefined}
        data-state={state}
        onClick={() => {
          triggerHaptic('selection')
          requestScrollToBottom()
        }}
        style={{
          bottom: inViewport
            ? 'calc(var(--atum-dock-height, 0px) + 0.625rem)'
            : 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.625rem)'
        }}
        tabIndex={visible ? 0 : -1}
        type="button"
      >
        <Codicon name="arrow-down" size={approval ? '0.875rem' : '1rem'} />
        {approval && <span className="text-xs font-medium">{label}</span>}
      </button>
    </Tip>
  )
}
