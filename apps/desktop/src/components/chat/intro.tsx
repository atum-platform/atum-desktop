import { useStore } from '@nanostores/react'
import { type CSSProperties, useState } from 'react'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { BrandMark } from '@/components/brand-mark'
import { useI18n } from '@/i18n'
import { capitalize, normalize } from '@/lib/text'
import { $atumShellEnabled } from '@/store/atum-shell'
import { openWorkbenchSingleton } from '@/store/workbench-tabs'

import introCopyJsonl from './intro-copy.jsonl?raw'

type IntroCopy = {
  headline: string
  body: string
}

type IntroCopyRecord = IntroCopy & {
  personality: string
}

export type IntroProps = {
  personality?: string
  seed?: number
}

const NEUTRAL_PERSONALITIES = new Set(['', 'default', 'none', 'neutral'])

const FALLBACK_COPY: IntroCopy[] = [
  {
    headline: 'What are we moving today?',
    body: "Send a bug, branch, plan, or rough idea. I'll inspect the repo and turn it into the next concrete step."
  },
  {
    headline: "What's on your mind?",
    body: "Bring the code, question, or stuck part. I'll read the room before making changes."
  },
  {
    headline: 'What should Atum look at?',
    body: "Send the task, failing path, or half-formed plan. I'll help turn it into action."
  },
  {
    headline: 'Where should we start?',
    body: "Bring the problem, goal, or file. I'll inspect first and keep the next step concrete."
  },
  {
    headline: 'What needs attention?',
    body: "Send the context you have. I'll help sort it into a plan or a fix."
  }
]

function normalizeKey(value?: string): string {
  return normalize(value)
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

function isIntroCopyRecord(value: unknown): value is IntroCopyRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    typeof record.personality === 'string' &&
    typeof record.headline === 'string' &&
    typeof record.body === 'string' &&
    Boolean(record.personality.trim()) &&
    Boolean(record.headline.trim()) &&
    Boolean(record.body.trim())
  )
}

function parseIntroCopy(raw: string): Record<string, IntroCopy[]> {
  const byPersonality: Record<string, IntroCopy[]> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    try {
      const parsed: unknown = JSON.parse(trimmed)

      if (!isIntroCopyRecord(parsed)) {
        continue
      }

      const key = normalizeKey(parsed.personality)
      byPersonality[key] ??= []
      byPersonality[key].push({
        headline: parsed.headline.trim(),
        body: parsed.body.trim()
      })
    } catch {
      // Bad generated copy should not break the whole desktop app.
    }
  }

  return byPersonality
}

const INTRO_COPY_BY_PERSONALITY = parseIntroCopy(introCopyJsonl)

function neutralCopy(): IntroCopy[] {
  return INTRO_COPY_BY_PERSONALITY.none || INTRO_COPY_BY_PERSONALITY.default || FALLBACK_COPY
}

function fallbackCopyForPersonality(personalityKey: string): IntroCopy[] {
  if (NEUTRAL_PERSONALITIES.has(personalityKey)) {
    return neutralCopy()
  }

  const label = titleize(personalityKey)

  return [
    {
      headline: `${label} mode is on. What should we work on?`,
      body: "Send the task, file, or rough idea. I'll use your configured voice and keep the work grounded in this repo."
    },
    {
      headline: `What does ${label} Hermes need to see?`,
      body: "Bring the context or the stuck part. I'll adapt to your configured personality."
    },
    {
      headline: `${label} mode is ready.`,
      body: "Send the problem, file, or idea. I'll follow the personality you've configured."
    },
    {
      headline: `What should ${label} Hermes tackle?`,
      body: "Drop the task here. I'll keep the work grounded in the repo."
    },
    {
      headline: 'Where should we begin?',
      body: `Give me the context and I'll answer in ${label} mode.`
    }
  ]
}

function pickCopy(copies: IntroCopy[], seed = 0): IntroCopy {
  return copies[Math.abs(seed) % copies.length] || FALLBACK_COPY[0]
}

function resolveCopy(personality?: string, seed?: number): IntroCopy {
  const personalityKey = normalizeKey(personality)

  const copies = NEUTRAL_PERSONALITIES.has(personalityKey)
    ? INTRO_COPY_BY_PERSONALITY[personalityKey] || neutralCopy()
    : INTRO_COPY_BY_PERSONALITY[personalityKey] || fallbackCopyForPersonality(personalityKey)

  return pickCopy(copies, seed)
}

export function atumManagedReadyAction(chips: { today: string }) {
  return { label: chips.today, run: () => requestComposerInsert(chips.today) }
}

export function Intro({ personality, seed }: IntroProps) {
  const { t } = useI18n()
  const atumShell = useStore($atumShellEnabled)
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100000))
  const copy = resolveCopy(personality, mountSeed + (seed ?? 0))
  const wordmark = t.intro.heading || 'ATUM'
  const body = t.intro.body || copy.body

  // The Atum product shell gets its own branded empty state: brand mark,
  // headline, body, and starter chips that drop a real prompt into the
  // composer. No Nous/Hermes art, no portrait, no fit-text wordmark.
  if (atumShell) {
    // A background eligibility read must never hide the employee or starter
    // actions. The task dispatch checks funding and access authoritatively.
    const readyAction = atumManagedReadyAction(t.atum.empty.chips)

    // Mock 1d "chat trống": no large mark. Title 22/600, body 14 muted, the
    // composer pill below (the composer itself), then three suggestion pills
    // 7×14 sunk 13 muted — two drop a prompt in, one opens the Files tab.
    const pills = [
      readyAction,
      { label: t.atum.empty.chips.summarize, run: () => requestComposerInsert(t.atum.empty.chips.summarize) },
      { label: t.atum.empty.chips.openFile, run: () => openWorkbenchSingleton('files') }
    ]

    return (
      <div
        className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center sm:px-6 lg:px-8"
        data-atum-empty
        data-slot="aui_intro"
      >
        <div className="flex w-full max-w-[38.75rem] min-w-0 flex-col items-center">
          <p className="m-0 text-[1.375rem] font-semibold tracking-[-0.02em] text-(--atum-ink)">{wordmark}</p>
          <p className="mt-1.5 max-w-[34rem] text-[0.875rem] leading-[1.5] text-(--atum-ink-muted)">{body}</p>
          <div className="mt-[calc(var(--composer-measured-height,3.5rem)+0.875rem)] flex flex-wrap justify-center gap-2" data-atum-empty-chips>
            {pills.map(pill => (
              <button
                className="pointer-events-auto rounded-full bg-(--atum-sunk) px-3.5 py-[7px] text-(length:--atum-t-control) text-(--atum-ink-muted) transition-colors hover:bg-(--atum-hover) hover:text-(--atum-ink)"
                key={pill.label}
                onClick={() => void pill.run()}
                type="button"
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <div className="flex w-full min-w-0 flex-col items-center">
        <BrandMark className="mb-4 size-12" />
        <p
          className="fit-text mx-auto mb-2 w-[calc(100%-1rem)] font-semibold leading-[1.05] tracking-[0.06em] text-(--ui-text-secondary)"
          style={{ '--fit-min': '2.25rem' } as CSSProperties}
        >
          <span>
            <span>{wordmark}</span>
          </span>
        </p>

        <p className="m-0 text-center leading-normal tracking-tight">{body}</p>
      </div>
    </div>
  )
}
