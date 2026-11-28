import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { FirstRunConnections, type FirstRunPresentation } from '@/app/connections/first-run-connections'
import { type FirstRunStage, firstRunStage, useFirstRunGreetingPhase } from '@/app/connections/first-run-controller'
import { firstRunConnectionsCopy } from '@/app/connections/first-run-copy'
import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { matrixFirstRunCopy } from '../../shared/matrix-first-run-copy'

import { MatrixLaunchNotice, matrixLaunchNoticeKind } from './launch-notice'
import { MATRIX_MARKDOWN_HOST } from './markdown-host'
import { primaryAgent } from './room-agent'

// Where the conversational first run belongs is one rule for the window and for main (which uses
// it to know that the person's first words answer the welcome): shared/matrix-first-run-place.ts.
export { matrixFirstRunPlace } from '../../shared/matrix-first-run-place'

const BUBBLE =
  'max-w-[32.5rem] rounded-[var(--ak-r-xl)] bg-(--ak-fill-quiet) px-(--ak-s3) py-(--ak-s2) text-pretty text-start text-(length:--atum-t-chat) leading-(--atum-lh-chat) text-(--atum-ink)'

function actualAssistantName(snapshot: MatrixSnapshot, fallback?: string): string {
  return primaryAgent(snapshot)?.name?.trim() || fallback?.trim() || 'Atum'
}

function TypingBubble({ label }: { label: string }) {
  return (
    <p aria-label={label} className={`${BUBBLE} flex items-center gap-1 py-(--ak-s3)`} data-matrix-first-run-greeting="pending" role="status">
      {[0, 1, 2].map(dot => (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-(--atum-ink-muted)"
          key={dot}
          style={{ animationDelay: `${dot * 160}ms` }}
        />
      ))}
    </p>
  )
}

/**
 * Pure: how the welcome card draws the Connections list. Hidden while the welcome is written (Atum already connects what needs
 * no prompt, so the welcome can name it); under the assistant's own ask, the one action row; with no welcome at all, or after a
 * skip, the full list (a bare Sure would answer nothing).
 */
export function firstRunPresentation(stage: FirstRunStage, skipped: boolean): FirstRunPresentation {
  if (!stage.connections) {
    return 'hidden'
  }

  return stage.greeting === 'generated' && !skipped ? 'ask' : 'list'
}

/**
 * The assistant's first real chat presentation (storyboard docs/mockups/new-user-flow/, frames 05–08i): its own welcome, which
 * asks in its own words, then one action row (Sure, Not now, Choose what to connect). The first-run controller
 * (first-run-controller.ts) sequences it:
 * - while the welcome is written: a typing bubble;
 * - no welcome after the wait: the request goes once more, with "Taking a little longer…" under the bubble;
 * - still nothing: one quiet line and Try again. No ready-made greeting ever stands in (owner rule: no canned agent text);
 * - the list is mounted hidden from the start, so Atum connects what needs no prompt before the welcome arrives;
 * - the action row follows the welcome; with no welcome (the quiet line) the full list shows, so nobody is stuck.
 *
 * The welcome invites the person to rename the assistant; they answer in the chat and it renames itself
 * (electron/matrix/first-run-naming.ts). After a skip the welcome stays with the same list under it.
 */
export function MatrixFirstRunCard({
  assistantName: fallbackName,
  greeting,
  greetingPending = false,
  resendGreeting,
  roomId,
  skipped = false,
  snapshot,
  waiting
}: {
  assistantName?: string
  /** The assistant's generated welcome (markdown). */
  greeting?: string
  /** The welcome request went out and no answer has arrived yet. */
  greetingPending?: boolean
  /** Sends the welcome request once more (the route the composer uses for this room). */
  resendGreeting?: () => Promise<unknown>
  roomId?: string
  skipped?: boolean
  snapshot: MatrixSnapshot
  /** Count the wait even without a request out (before the chat exists). Defaults to `greetingPending`. */
  waiting?: boolean
}) {
  const { locale } = useI18n()
  const copy = firstRunConnectionsCopy(locale)
  const primary = primaryAgent(snapshot)
  const name = actualAssistantName(snapshot, fallbackName)
  const { phase, tryAgain } = useFirstRunGreetingPhase({ resend: resendGreeting, waiting: !greeting && (waiting ?? greetingPending) })
  const stage = firstRunStage({ greeting: Boolean(greeting), phase })

  return (
    <div
      className="flex w-full max-w-[40rem] items-start gap-(--ak-s3) [align-self:safe_center] px-4 py-6"
      data-matrix-first-run={skipped ? 'skipped' : snapshot.firstRun ?? 'open'}
      data-matrix-first-run-stage={stage.greeting}
    >
      <AtumAssistantAvatar
        brand={Boolean(primary?.isDefault)}
        className="size-10 shrink-0 rounded-full text-lg"
        id={primary?.principal ?? 'atum-first-run'}
        name={name}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-(--ak-s3)">
        {stage.greeting === 'generated' ? (
          <div className={`${BUBBLE} min-w-0`} data-matrix-first-run-greeting="generated">
            <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={greeting!} />
          </div>
        ) : stage.greeting === 'quiet' ? (
          <p className="flex items-center gap-(--ak-s2) text-[0.875rem] text-(--atum-ink-muted)" data-matrix-first-run-greeting="quiet" role="status">
            {copy.greetingQuiet(name)}
            {resendGreeting && (
              <button className="ak-btn ak-btn--sm h-6 px-2.5 text-[0.75rem]" data-matrix-first-run-retry onClick={tryAgain} type="button">
                {copy.tryAgain}
              </button>
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <TypingBubble label={copy.greetingWriting(name)} />
            {stage.greeting === 'retrying' && (
              <span className="px-1 text-[0.75rem] text-(--atum-ink-muted)" data-matrix-first-run-greeting="retrying">
                {copy.greetingRetrying}
              </span>
            )}
          </div>
        )}
        <FirstRunConnections
          assistantName={name}
          className="max-w-[32.5rem]"
          googleAssistant={snapshot.googleAssistant}
          // The welcome's own list admits first learning (a skipped welcome already said Not now).
          learningOffered={!skipped}
          presentation={firstRunPresentation(stage, skipped)}
          roomId={roomId}
          trackOpen
        />
      </div>
    </div>
  )
}

/** Just-in-time recovery after macOS refuses a protected folder (also reads 0.20.19's blocked state). */
export function MatrixFolderAccessRecovery({
  bridge = window.atumMatrix,
  snapshot
}: {
  bridge?: Pick<MatrixUiBridge, 'permissions'>
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixFirstRunCopy(locale).folderAccess

  if (snapshot.firstRun !== 'blocked' || !bridge.permissions) {
    return null
  }

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-[47rem] items-center gap-2 px-4 text-[0.8125rem] text-(--atum-ink-muted)"
      data-matrix-folder-access-recovery
    >
      <span role="status">{copy.denied}</span>
      <Button
        onClick={() => void bridge.permissions?.openSettings('files').catch(() => {})}
        size="inline"
        variant="textStrong"
      >
        {copy.openSettings}
      </Button>
    </div>
  )
}

/** The same first message before a chat exists, with the real readiness line beneath it. */
export function MatrixFirstRunPanel({
  fail,
  name,
  snapshot
}: {
  fail?: () => void
  name: string
  snapshot: MatrixSnapshot
}) {
  const kind = matrixLaunchNoticeKind(snapshot.readiness)

  return (
    <div className="m-auto flex w-full max-w-[36rem] flex-col items-center px-2 py-8" data-matrix-first-run-panel>
      <MatrixFirstRunCard assistantName={name} snapshot={snapshot} waiting />
      {(kind === 'starting' || kind === 'blocked') && (
        <MatrixLaunchNotice fail={fail} name={name} snapshot={snapshot} variant="line" />
      )}
    </div>
  )
}
