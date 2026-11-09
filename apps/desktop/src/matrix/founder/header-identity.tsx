import { VerifiedMark } from '@/components/verified-mark'

import { FounderAvatar } from './founder-avatar'
import { useFounderCopy } from './founder-copy'
import { openFounderProfile } from './founder-store'

/**
 * The Founder chat's identity in the chat's top row: the raven, "Founder" with its mark, and
 * who they are, the way an assistant's chat shows its name and history. A click opens the
 * profile sheet. Its label replaces what it holds, so it names the mark itself.
 */
export function FounderHeaderIdentity() {
  const copy = useFounderCopy()

  return (
    <button
      aria-haspopup="dialog"
      aria-label={`${copy.name}, ${copy.officialAccount}, ${copy.subtitle}`}
      className="-ms-1 flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-(--atum-hover) focus-visible:bg-(--atum-hover) [-webkit-app-region:no-drag]"
      data-founder-header
      onClick={openFounderProfile}
      type="button"
    >
      <FounderAvatar size={22} />
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm font-semibold">{copy.name}</span>
        <VerifiedMark tier="official" tip={false} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-(--atum-ink-muted)" data-matrix-chat-subtitle>
        {copy.subtitle}
      </span>
    </button>
  )
}
