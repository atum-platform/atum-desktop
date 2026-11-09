import { VerifiedMark } from '@/components/verified-mark'

import { FounderAvatar } from './founder-avatar'
import { useFounderCopy } from './founder-copy'

/**
 * The empty Founder chat's first words, drawn by the app (owner decision 2026-09-29): not a
 * message, since an automatic message in an encrypted chat would need something holding the
 * founder's keys. It gives way to the conversation as soon as anything is in it.
 */
export function FounderIntroCard() {
  const copy = useFounderCopy()

  return (
    <div
      className="flex max-w-[26rem] flex-col items-center justify-center self-center justify-self-center px-6 text-center"
      data-founder-intro
    >
      <FounderAvatar size={56} />
      <p className="mt-4 flex items-center gap-1.5 text-[1.0625rem] font-semibold text-(--atum-ink)">
        <span>{copy.name}</span>
        <VerifiedMark size="md" tier="official" />
      </p>
      <p className="mt-0.5 text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.subtitle}</p>
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-balance text-(--atum-ink-soft)" data-founder-intro-text>
        {copy.intro}
      </p>
    </div>
  )
}
