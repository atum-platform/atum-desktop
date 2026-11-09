import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { markAtumWelcomeSeen } from './startup-ownership'

const STORY_MS = 5200
const HANDOFF_MS = 400

export interface AtumWelcomeTransit {
  x: number
  y: number
  scale: number
}

export function calculateAtumWelcomeTransit(mark: DOMRect, target: DOMRect): AtumWelcomeTransit {
  return {
    x: target.left + target.width / 2 - (mark.left + mark.width / 2),
    y: target.top + target.height / 2 - (mark.top + mark.height / 2),
    scale: target.width / mark.width
  }
}

interface AtumWelcomeStoryboardProps {
  onComplete: () => void
}

const CAST = [
  ['./specialists/moon-avatar.png', 'Moon'],
  ['./specialists/andy-avatar.svg', 'Andy'],
  ['./specialists/taylor-avatar.svg', 'Taylor'],
  ['./specialists/ben-avatar.png', 'Ben']
] as const

/**
 * HyperFrames determinism contract: React may measure the two real DOM rects
 * once and choose a terminal mode (normal, skipped, or reduced), but it never
 * advances the animation. CSS owns every keyframe and literal delay; there is
 * no requestAnimationFrame loop, wall-clock read, spring, or physics state, so
 * an external HTML renderer can seek and capture the same timeline by frame.
 */
export function AtumWelcomeStoryboard({ onComplete }: AtumWelcomeStoryboardProps) {
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const [handoff, setHandoff] = useState(false)
  const markRef = useRef<HTMLDivElement>(null)
  const [transit, setTransit] = useState<AtumWelcomeTransit | null>(null)
  const [chatRect, setChatRect] = useState<DOMRect | null>(null)
  const completed = useRef(false)
  // The parent passes an inline onComplete, so it must never be an effect
  // dependency: re-rendering the shell during boot would reset the story
  // timer and the welcome could hold the app forever.
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const finish = useCallback(() => {
    if (completed.current) {return}
    completed.current = true
    markAtumWelcomeSeen()
    onCompleteRef.current()
  }, [])

  useLayoutEffect(() => {
    const chat = document.querySelector<HTMLElement>('[data-atum-chat]')?.getBoundingClientRect()

    if (!chat) {return}
    setChatRect(chat)
  }, [])

  useLayoutEffect(() => {
    if (!chatRect || reduced) {return}

    const mark = markRef.current?.getBoundingClientRect()
    const target = document.querySelector<HTMLElement>('[data-atum-assistant-avatar]')?.getBoundingClientRect()

    if (mark && target && mark.width > 0 && target.width > 0) {
      setTransit(calculateAtumWelcomeTransit(mark, target))
    }
  }, [chatRect, reduced])

  useEffect(() => {
    const skip = () => setHandoff(true)
    const storyTimer = window.setTimeout(finish, reduced ? HANDOFF_MS : STORY_MS)

    window.addEventListener('keydown', skip)
    window.addEventListener('click', skip)

    return () => {
      window.clearTimeout(storyTimer)
      window.removeEventListener('keydown', skip)
      window.removeEventListener('click', skip)
    }
  }, [finish, reduced])

  useEffect(() => {
    if (!handoff) {return}
    const finishTimer = window.setTimeout(finish, HANDOFF_MS)

    return () => window.clearTimeout(finishTimer)
  }, [finish, handoff])

  return (
    <main
      aria-describedby="atum-welcome-skip"
      className="atum-welcome absolute inset-0 z-50 overflow-hidden atum-window-ground text-(--atum-ink)"
      data-handoff={handoff ? 'true' : 'false'}
      data-reduced={reduced ? 'true' : 'false'}
      data-slot="atum-welcome-storyboard"
      data-transit-target={transit ? 'true' : 'false'}
      inert
    >
      <span className="sr-only" id="atum-welcome-skip" role="status">
        {t.atum.welcome.skipHint}
      </span>
      <section
        className={cn('atum-welcome-final absolute atum-window-ground', handoff && 'atum-welcome-handoff')}
        style={chatRect ? {
          '--atum-welcome-chat-height': chatRect.height,
          '--atum-welcome-chat-left': chatRect.left,
          '--atum-welcome-chat-top': chatRect.top,
          '--atum-welcome-chat-width': chatRect.width
        } as React.CSSProperties : undefined}
      >
        <div
          className="atum-welcome-composition absolute flex flex-col items-center text-center"
        >
          <div
            className="atum-welcome-mark"
            ref={markRef}
            style={transit ? {
              '--atum-welcome-mark-scale': transit.scale,
              '--atum-welcome-mark-x': transit.x,
              '--atum-welcome-mark-y': transit.y
            } as React.CSSProperties : undefined}
          >
            <BrandMark className="size-14 rounded-[var(--atum-r-sidebar)]" />
          </div>
          <h1 className="atum-welcome-name mt-3.5 font-[Outfit,'Helvetica_Neue',sans-serif] text-[1.75rem] leading-none font-medium tracking-[-0.025em]">Atum</h1>
          <p className="atum-welcome-promise mt-1.5 text-(length:--atum-t-control) text-(--atum-ink-muted)">
            {t.atum.welcome.promise}
          </p>
          <div aria-label={t.atum.welcome.castLabel} className="atum-welcome-cast mt-5 flex gap-2.5">
            {CAST.map(([src, name], index) => (
              <img
                alt={name}
                className="size-[1.875rem] rounded-[var(--atum-r-tab)] object-cover"
                key={name}
                src={src}
                style={{ '--atum-welcome-index': index } as React.CSSProperties}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
