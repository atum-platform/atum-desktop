import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { FirstRunConnections } from '@/app/connections/first-run-connections'
import { firstRunConnectionsCopy } from '@/app/connections/first-run-copy'
import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { matrixFirstRunCopy, matrixFirstRunName } from '../../shared/matrix-first-run-copy'

import { MatrixFirstRunConnectCard } from './first-run-connect-card'
import { accountUsesAtumFree, MatrixGoogleConnectNudge } from './google-connection-settings'
import { MatrixLaunchNotice, matrixLaunchNoticeKind } from './launch-notice'
import { MATRIX_MARKDOWN_HOST } from './markdown-host'
import { matrixPersonName } from './person-name'
import { primaryAgent } from './room-agent'

// Where the conversational first run belongs is one rule for the window and for main (which uses
// it to know that the person's first words answer the welcome): shared/matrix-first-run-place.ts.
export { matrixFirstRunPlace } from '../../shared/matrix-first-run-place'

/** The person's profile name, unless it is only their Matrix handle. */
function greetingName(snapshot: MatrixSnapshot): string | undefined {
  const userId = snapshot.identity?.userId ?? ''
  const name = matrixFirstRunName(matrixPersonName(snapshot.ownProfile?.displayName, userId))
  const local = /^@([^:]+):/u.exec(userId)?.[1]

  return name && name !== local ? name : undefined
}

const BUBBLE =
  'max-w-[32.5rem] rounded-[var(--ak-r-xl)] bg-(--ak-fill-quiet) px-(--ak-s3) py-(--ak-s2) text-pretty text-start text-(length:--atum-t-chat) leading-(--atum-lh-chat) text-(--atum-ink)'

function actualAssistantName(snapshot: MatrixSnapshot, fallback?: string): string {
  return primaryAgent(snapshot)?.name?.trim() || fallback?.trim() || 'Atum'
}

/**
 * The assistant's first real chat presentation: its welcome, then the inline connector card. The welcome ends
 * by inviting the person to keep the assistant's name or give it one they like; there is no form
 * for that. The person answers in the chat like any message and the assistant renames itself
 * (electron/matrix/first-run-naming.ts), so this card writes nothing and posts nothing.
 *
 * The welcome is the assistant's own (owner 2026-11-27, no canned agent text): `greeting` is its answer to the hidden opening
 * intent (first-run-greeting.ts), shown here with the Connections block under it; `greetingPending` shows a quiet typing bubble
 * while it is being written. Without either (the intent could not go out), the earlier written welcome stays as before.
 *
 * Where the assistant answers does not matter: a cloud-placed primary gets the same welcome.
 * After skip, `skipped` keeps the greeting but replaces the card with the small Google chip. There
 * is no Mac or folder preflight here; macOS asks only when a real folder read needs it.
 */
export function MatrixFirstRunCard({
  assistantName: fallbackName,
  greeting,
  greetingPending = false,
  roomId,
  skipped = false,
  snapshot
}: {
  assistantName?: string
  /** The assistant's generated welcome (markdown). */
  greeting?: string
  greetingPending?: boolean
  roomId?: string
  skipped?: boolean
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixFirstRunCopy(locale)
  const primary = primaryAgent(snapshot)
  const name = actualAssistantName(snapshot, fallbackName)

  return (
    <div
      className="flex w-full max-w-[40rem] items-start gap-(--ak-s3) [align-self:safe_center] px-4 py-6"
      data-matrix-first-run={skipped ? 'skipped' : snapshot.firstRun ?? 'open'}
    >
      <AtumAssistantAvatar
        brand={Boolean(primary?.isDefault)}
        className="size-10 shrink-0 rounded-full text-lg"
        id={primary?.principal ?? 'atum-first-run'}
        name={name}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-(--ak-s3)">
        {greeting ? (
          <div
            className={`${BUBBLE} min-w-0`}
            data-matrix-first-run-greeting="generated"
          >
            <MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={greeting} />
          </div>
        ) : greetingPending ? (
          <p aria-label={firstRunConnectionsCopy(locale).greetingWriting(name)} className={`${BUBBLE} flex items-center gap-1 py-(--ak-s3)`} data-matrix-first-run-greeting="pending" role="status">
            {[0, 1, 2].map(dot => (
              <span
                aria-hidden
                className="size-1.5 animate-pulse rounded-full bg-(--atum-ink-muted)"
                key={dot}
                style={{ animationDelay: `${dot * 160}ms` }}
              />
            ))}
          </p>
        ) : (
          <>
            <p className={BUBBLE}>{copy.greeting(greetingName(snapshot), name)}</p>
            <p className={BUBBLE}>{copy.intro}</p>
          </>
        )}
        {/* The first step on the agent: this Mac's connections, Ready or Connect (owner 2026-11-27). UI chrome, not a message. */}
        <FirstRunConnections className="max-w-[32.5rem]" />
        {skipped ? (
          <MatrixGoogleConnectNudge
            access={snapshot.googleAssistant}
            placement="greeting"
            scope={snapshot.identity?.userId}
            usesAtumFree={accountUsesAtumFree(snapshot.agents)}
          />
        ) : (
          <MatrixFirstRunConnectCard roomId={roomId} snapshot={snapshot} />
        )}
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
      <MatrixFirstRunCard assistantName={name} snapshot={snapshot} />
      {(kind === 'starting' || kind === 'blocked') && (
        <MatrixLaunchNotice fail={fail} name={name} snapshot={snapshot} variant="line" />
      )}
    </div>
  )
}
