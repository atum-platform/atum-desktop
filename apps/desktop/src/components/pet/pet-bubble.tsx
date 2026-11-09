import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { AlertCircle, Clock, type IconComponent } from '@/lib/icons'
import { $petActivity, $petReplyByAgent, $petState } from '@/store/pet'

/**
 * The pet's speech bubble, on the popped-out overlay only (in the window, the
 * app itself is the surface).
 *
 * It speaks for three reasons and no others: she has an answer, the turn is
 * blocked on you, or something broke. Each is an actual interaction — something
 * you would want to know without switching windows.
 *
 * It used to also narrate work in progress from a pool of ten random phrasings
 * per mood ("crunching…", "in the weeds…", "scheming…"), rotating every 2.6s.
 * That was decoration: the sprite already runs while tools run and tilts its
 * head while reasoning, so the words added noise and no information — and being
 * random, they could not be translated into anything meaningful either. A bubble
 * that only speaks when it has something to say is worth reading.
 */

type Tone = 'error' | 'wait'

const TONE_COLOR: Record<Tone, string> = {
  error: 'var(--ui-red)',
  wait: 'var(--ui-yellow)'
}

export function PetBubble() {
  const { t } = useI18n()
  const state = useStore($petState)
  const activity = useStore($petActivity)
  // The overlay window holds exactly one pet, so its mirrored record has a
  // single entry; taking the first avoids threading an agent key through a
  // component that has no other use for one.
  const reply = Object.values(useStore($petReplyByAgent))[0] ?? ''

  // What she actually said wins: an answer is the point, everything else is
  // status. It decays on its own (see `sayPetReply`).
  if (reply) {
    return (
      <div
        className="atum-pet-glass"
        style={{
          fontSize: 11.5,
          fontWeight: 480,
          lineHeight: 1.35,
          maxWidth: 232,
          padding: '8px 11px',
          pointerEvents: 'none',
          textWrap: 'pretty'
        }}
      >
        {reply}
      </div>
    )
  }

  const waiting = state === 'waiting' || (state === 'idle' && activity.awaitingInput)
  const failed = state === 'failed'

  if (!waiting && !failed) {
    return null
  }

  const Glyph: IconComponent = failed ? AlertCircle : Clock
  const tone: Tone = failed ? 'error' : 'wait'
  const text = failed ? t.atum.pet.somethingBroke : t.atum.pet.yourTurn

  return (
    <div
      className="atum-pet-glass"
      style={{
        alignItems: 'center',
        display: 'inline-flex',
        fontSize: 11,
        fontWeight: 500,
        gap: 5,
        lineHeight: 1,
        padding: '5px 9px',
        pointerEvents: 'none',
        whiteSpace: 'nowrap'
      }}
    >
      <span style={{ display: 'inline-flex' }}>
        <Glyph style={{ color: TONE_COLOR[tone], height: 13, width: 13 }} />
      </span>
      {text}
    </div>
  )
}
