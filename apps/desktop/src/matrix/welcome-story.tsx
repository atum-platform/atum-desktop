import { useEffect, useRef, useState } from 'react'

import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useI18n } from '@/i18n'
import { useAppViewOverlayHold } from '@/store/use-app-view-overlay'

import { EclipseCanvas } from './launch-eclipse/eclipse-canvas'
import { launchEclipseSupported } from './launch-eclipse/renderer'
import { REDUCED_STORY, STORY, storyFacts } from './launch-eclipse/story'

const PLAYED_KEY = 'io.atum.welcome.played'
/** The whole story (the approved first-launch board), ending as dawn gives way to sign-in. */
const STORY_MS = 11_300
const REDUCED_MS = 4_100
const SKIP_MS = 450
/** Skip is offered once the story has begun (the spec's 1.5 s); Escape works throughout. */
const SKIP_AFTER_MS = 1_500
const REDUCED_SKIP_AFTER_MS = 600
/** The mark lands on the sign-in screen's own mark as the night lifts. */
const LAND_AT_MS = 9_350
const LAND_MS = 1_100
/** Where the brand mark's circles sit (atum-mark.svg, 64 units): the sun is 57 across. */
const TILE_SUN = 57 / 64
/** The hero's sun is 35.556% of the hero (the launch hero's geometry, the brand's ratios). */
const HERO_SUN = 0.35556

/** The voice that says the first word (one take, drawn once). */
const WAVE =
  'M0 16 C 20 16 24 15 30 16.4 S 44 17.9 50 17.4 S 60 12.7 66 18.9 S 76 12.6 82 12.7 S 92 21 96 12.6 S 104 13.3 110 25.8 S 118 8.6 124 9.6 S 130 26.9 136 17.8 S 142 4 148 19.5 S 154 26 160 8.5 S 166 10.2 172 25 S 180 12.3 186 10.1 S 194 22.4 200 15.2 S 208 13.5 216 19.4 S 228 14.2 236 17.6 S 250 15.5 260 16.4 S 272 15.8 280 16.1'

/** The spoken line appears word by word (by phrase where a language has no spaces). */
function phrases(line: string) {
  return line.split(/(?<=[\s、，。,])/u).filter(Boolean)
}

/** Whether this install has already seen the story. Unreadable storage counts as seen. */
export function welcomePlayed(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage) {
  try {
    return storage?.getItem(PLAYED_KEY) === '1'
  } catch {
    return true
  }
}

export function markWelcomePlayed(storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(PLAYED_KEY, '1')
  } catch {
    // A story seen twice is harmless.
  }
}

/**
 * The first launch, once per install, before sign-in: out of Nun a spark, the atom, the
 * eclipse, the first word as a diamond ring, then "Speak, and it becomes." The mark then
 * lands on the sign-in screen's own mark while the night lifts around it. Skip appears after 1.5 s (Escape skips too). With reduced motion the
 * mark and the line cross-fade instead. Only opacity and transform animate, apart from
 * the orbits being drawn once.
 */
export function MatrixWelcomeStory({ onDone }: { onDone(): void }) {
  // The live eclipse where the window can draw it; the CSS story elsewhere (and in tests).
  const [eclipse] = useState(launchEclipseSupported)

  return eclipse ? <EclipseWelcomeStory onDone={onDone} /> : <CssWelcomeStory onDone={onDone} />
}

/**
 * The story drawn by the launch eclipse (launch-eclipse/story.ts has the script): the same
 * engine, shader and landing as every launch after it, so the first launch and the daily one
 * are one piece of motion. The words keep their type and their voice line.
 */
function EclipseWelcomeStory({ onDone }: { onDone(): void }) {
  useAppViewOverlayHold()
  const { t } = useI18n()
  const shell = t.matrixShell
  const reduce = useReducedMotion()
  const [skipped, setSkipped] = useState(false)
  const [skipOffered, setSkipOffered] = useState(false)
  const [landing, setLanding] = useState(false)
  const [start] = useState(() => performance.now())

  useEffect(() => {
    const id = window.setTimeout(() => setSkipOffered(true), reduce ? REDUCED_SKIP_AFTER_MS : SKIP_AFTER_MS)

    return () => window.clearTimeout(id)
  }, [reduce])

  useEffect(() => {
    const id = window.setTimeout(onDone, skipped ? SKIP_MS : (reduce ? REDUCED_STORY.done : STORY.done) * 1000)

    return () => window.clearTimeout(id)
  }, [onDone, reduce, skipped])

  // The night lifts as the mark sets off for the sign-in screen's mark.
  useEffect(() => {
    if (reduce || skipped) {
      return
    }

    const id = window.setTimeout(() => setLanding(true), STORY.leave * 1000)

    return () => window.clearTimeout(id)
  }, [reduce, skipped])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSkipped(true)
      }
    }

    window.addEventListener('keydown', escape)

    return () => window.removeEventListener('keydown', escape)
  }, [])

  // A skip fades the eclipse with the story (styles.css), wherever it is in its motion.
  useEffect(() => {
    const root = window.document.documentElement

    if (skipped) {
      root.dataset.atumStorySkipped = ''
    }

    return () => {
      delete root.dataset.atumStorySkipped
    }
  }, [skipped])

  const words = reduce ? REDUCED_STORY : STORY

  return (
    <div className="dark">
      <div
        className="atum-shell atum-story fixed inset-0 z-[1300]"
        data-eclipse
        data-landing={landing || undefined}
        data-reduced={reduce || undefined}
        data-skipped={skipped || undefined}
        data-slot="matrix-welcome"
      >
        <div aria-hidden className="atum-launch-nun" />
        <div aria-hidden className="atum-story-scene">
          <EclipseCanvas
            className="atum-launch-hero atum-story-hero"
            direction="totality"
            facts={() => storyFacts((performance.now() - start) / 1000, reduce)}
            fallback={null}
            landOn="[data-matrix-auth-mark]"
            layer={1301}
          />
          <div className="atum-story-words">
            {!reduce && (
              <svg className="atum-story-wave" style={{ animationDelay: `${STORY.wave * 1000}ms` }} viewBox="0 0 280 32">
                <path d={WAVE} />
              </svg>
            )}
            <p className="atum-story-line">
              {phrases(shell.welcomeLine).map((phrase, index) => (
                <span
                  key={`${index}:${phrase}`}
                  style={reduce ? undefined : { animationDelay: `${(STORY.line + index * STORY.linePhrase) * 1000}ms` }}
                >
                  {phrase}
                </span>
              ))}
            </p>
            <p className="atum-story-sub" style={reduce ? undefined : { animationDelay: `${words.sub * 1000}ms` }}>
              {shell.welcomeSub}
            </p>
          </div>
        </div>
        <p className="sr-only">
          {shell.welcomeLine} {shell.welcomeSub}
        </p>
        {skipOffered && (
          <button className="atum-story-skip" onClick={() => setSkipped(true)} type="button">
            {shell.welcomeSkip}
          </button>
        )}
      </div>
    </div>
  )
}

/** The first-launch story in CSS, where the window cannot draw the live eclipse. */
function CssWelcomeStory({ onDone }: { onDone(): void }) {
  // It covers the window: any native view steps aside.
  useAppViewOverlayHold()
  const { t } = useI18n()
  const shell = t.matrixShell
  const reduce = useReducedMotion()
  const [skipped, setSkipped] = useState(false)
  const [skipOffered, setSkipOffered] = useState(false)
  const [landing, setLanding] = useState(false)
  const hero = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = window.setTimeout(() => setSkipOffered(true), reduce ? REDUCED_SKIP_AFTER_MS : SKIP_AFTER_MS)

    return () => window.clearTimeout(id)
  }, [reduce])

  useEffect(() => {
    const id = window.setTimeout(onDone, skipped ? SKIP_MS : reduce ? REDUCED_MS : STORY_MS)

    return () => window.clearTimeout(id)
  }, [onDone, reduce, skipped])

  // The landing: the mark flies to the sign-in screen's mark and becomes it. Measured
  // when it starts, since the screen below is laid out by then; without a target (or
  // with reduced motion) the story simply fades.
  useEffect(() => {
    if (reduce || skipped) {
      return
    }

    const id = window.setTimeout(() => {
      const node = hero.current
      const mark = document.querySelector<HTMLElement>('[data-matrix-auth-mark]')

      if (!node || !mark) {
        return
      }

      const from = node.getBoundingClientRect()
      const to = mark.getBoundingClientRect()

      if (!from.width || !to.width) {
        return
      }

      const scale = (to.width * TILE_SUN) / (from.width * HERO_SUN)
      const dx = to.left + to.width / 2 - (from.left + from.width / 2)
      const dy = to.top + to.height / 2 - (from.top + from.height / 2)
      const radius = Number.parseFloat(getComputedStyle(mark).borderTopLeftRadius) || 0

      node.style.setProperty('--atum-story-tile', `${to.width / scale}px`)
      node.style.setProperty('--atum-story-tile-radius', `${radius / scale}px`)
      setLanding(true)
      node.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }], {
        duration: LAND_MS,
        easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
        fill: 'forwards'
      })

      // The light around the mark gathers in as it flies: the brand's mark carries none.
      for (const part of node.querySelectorAll<HTMLElement>(
        '.atum-launch-corona, .atum-launch-rays, .atum-launch-glow, .atum-story-flash'
      )) {
        part.animate([{ opacity: 0 }], { duration: 520, easing: 'ease-out', fill: 'forwards' })
      }
    }, LAND_AT_MS)

    return () => window.clearTimeout(id)
  }, [reduce, skipped])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSkipped(true)
      }
    }

    window.addEventListener('keydown', escape)

    return () => window.removeEventListener('keydown', escape)
  }, [])

  return (
    <div className="dark">
      <div
        className="atum-shell atum-story fixed inset-0 z-[1300]"
        data-landing={landing || undefined}
        data-reduced={reduce || undefined}
        data-skipped={skipped || undefined}
        data-slot="matrix-welcome"
      >
        <div aria-hidden className="atum-launch-nun" />
        <div aria-hidden className="atum-story-dusk" />
        <div aria-hidden className="atum-story-scene">
          <div className="atum-launch-hero atum-story-hero" ref={hero}>
            {/* The brand mark's tile, drawn in as the mark lands on it. */}
            <div className="atum-story-tile" />
            <div className="atum-story-sparkglow" />
            <div className="atum-launch-corona" />
            <div className="atum-launch-rays">
              <i />
            </div>
            <div className="atum-launch-sun" />
            <div className="atum-launch-moon" />
            <svg className="atum-launch-orbits atum-story-orbits" viewBox="0 0 540 540">
              <ellipse cx="270" cy="270" pathLength={1} rx="262" ry="78" />
              <ellipse cx="270" cy="270" pathLength={1} rx="262" ry="78" transform="rotate(60 270 270)" />
              <ellipse cx="270" cy="270" pathLength={1} rx="262" ry="78" transform="rotate(-60 270 270)" />
            </svg>
            <div className="atum-story-electrons">
              {([0, 1, 2] as const).map(ring => (
                <div className="atum-launch-track" data-ring={ring} key={ring}>
                  {(['lead', 'trail', 'tail'] as const).map(part => (
                    <div className="atum-launch-x" data-part={part} key={part}>
                      <div className="atum-launch-y">
                        <i className="atum-launch-electron" />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="atum-launch-glow">
              <div className="atum-launch-ripple" />
              <div className="atum-launch-ripple" data-late />
              <div className="atum-launch-ripple" data-last />
              <div className="atum-launch-flare">
                <b />
                <b data-vertical />
              </div>
            </div>
            <div className="atum-launch-bead" />
            {/* The first word's flash: one exposure the whole mark answers to. */}
            <div className="atum-story-flash" />
          </div>
          <div className="atum-story-words">
            <svg className="atum-story-wave" viewBox="0 0 280 32">
              <path d={WAVE} />
            </svg>
            <p className="atum-story-line">
              {phrases(shell.welcomeLine).map((phrase, index) => (
                <span key={`${index}:${phrase}`} style={{ animationDelay: `${6200 + index * 320}ms` }}>
                  {phrase}
                </span>
              ))}
            </p>
            <p className="atum-story-sub">{shell.welcomeSub}</p>
          </div>
        </div>
        <p className="sr-only">
          {shell.welcomeLine} {shell.welcomeSub}
        </p>
        {/* Not in the page until offered: never a focusable control nobody can see. */}
        {skipOffered && (
          <button className="atum-story-skip" onClick={() => setSkipped(true)} type="button">
            {shell.welcomeSkip}
          </button>
        )}
      </div>
    </div>
  )
}
