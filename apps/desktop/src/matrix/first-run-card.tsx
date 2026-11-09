import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { matrixFirstRunCopy, matrixFirstRunName } from '../../shared/matrix-first-run-copy'

import { MatrixFirstRunConnectCard } from './first-run-connect-card'
import { MatrixGoogleConnectNudge } from './google-connection-settings'
import { MatrixLaunchNotice, matrixLaunchNoticeKind } from './launch-notice'
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

function actualAssistantName(snapshot: MatrixSnapshot, fallback?: string): string {
  return primaryAgent(snapshot)?.name?.trim() || fallback?.trim() || 'Atum'
}

/**
 * The assistant's first real chat presentation: its welcome, then the inline connector card. The welcome ends
 * by inviting the person to keep the assistant's name or give it one they like; there is no form
 * for that. The person answers in the chat like any message and the assistant renames itself
 * (electron/matrix/first-run-naming.ts), so this card writes nothing and posts nothing.
 *
 * Where the assistant answers does not matter: a cloud-placed primary gets the same welcome.
 * After skip, `skipped` keeps the greeting but replaces the card with the small Google chip. There
 * is no Mac or folder preflight here; macOS asks only when a real folder read needs it.
 */
export function MatrixFirstRunCard({
  assistantName: fallbackName,
  roomId,
  skipped = false,
  snapshot
}: {
  assistantName?: string
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
      className="flex w-full max-w-[40rem] items-start gap-(--ak-s3) self-center px-4 py-6"
      data-matrix-first-run={skipped ? 'skipped' : snapshot.firstRun ?? 'open'}
    >
      <AtumAssistantAvatar
        brand={Boolean(primary?.isDefault)}
        className="size-10 shrink-0 rounded-full text-lg"
        id={primary?.principal ?? 'atum-first-run'}
        name={name}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-(--ak-s3)">
        <p className="max-w-[32.5rem] rounded-[var(--ak-r-xl)] bg-(--ak-fill-quiet) px-(--ak-s3) py-(--ak-s2) text-pretty text-start text-(length:--atum-t-chat) leading-(--atum-lh-chat) text-(--atum-ink)">
          {copy.greeting(greetingName(snapshot), name)}
        </p>
        <p className="max-w-[32.5rem] rounded-[var(--ak-r-xl)] bg-(--ak-fill-quiet) px-(--ak-s3) py-(--ak-s2) text-pretty text-start text-(length:--atum-t-chat) leading-(--atum-lh-chat) text-(--atum-ink)">
          {copy.intro}
        </p>
        {skipped ? (
          <MatrixGoogleConnectNudge
            access={snapshot.googleAssistant}
            placement="greeting"
            scope={snapshot.identity?.userId}
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
