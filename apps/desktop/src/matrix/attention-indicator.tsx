import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { type Locale, useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixLocalDay } from '../../shared/matrix-device-trust'
import type { MatrixApprovalView } from '../../shared/matrix-security'

import { type MatrixAttentionItem, matrixAttentionItems, useMatrixAttentionNow } from './agent-attention'
import { type AttentionCopy, useAttentionCopy } from './attention-copy'
import { matrixDeviceLastSeen } from './device-last-seen'
import { runMatrixReadinessAction } from './launch-actions'
import { useLaunchCopy } from './launch-copy'
import { MatrixNewSignInDetail, matrixNewSignInLabel } from './new-sign-in-notice'
import { MatrixOwnerDeviceRepairNotice } from './owner-device-repair-notice'
import { matrixSecurityCopy } from './security-copy'

/** "Not now" on a device to verify: until tomorrow, on this Mac only (device ID → that day). */
const DEVICE_PUT_OFF_KEY = 'io.atum.attention.devicePutOff'

function devicesPutOff(ownerId: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${DEVICE_PUT_OFF_KEY}:${ownerId}`) ?? '{}')

    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : {}
  } catch {
    return {}
  }
}

/** Items that say more before they act: a sign-in that replaces this Mac's device, a sign-in on
 * another device, or one of the person's devices to verify. */
const DETAILED = new Set<MatrixAttentionItem['kind']>([
  'device_damaged',
  'new_sign_in',
  'device_unverified'
])

function itemKey(item: MatrixAttentionItem): string {
  return item.principal
    ? `${item.kind}:${item.principal}`
    : item.device
      ? `${item.kind}:${item.device.deviceId}`
      : item.newSignIn
        ? `${item.kind}:${item.newSignIn.deviceId}`
        : item.kind
}

function itemLabel(
  item: MatrixAttentionItem,
  copy: AttentionCopy,
  agentName: (principal: string) => string,
  locale: Locale
) {
  if (item.kind === 'new_sign_in') {
    return item.newSignIn ? matrixNewSignInLabel(item.newSignIn, locale) : ''
  }

  return item.kind === 'agent'
    ? copy.agent(agentName(item.principal ?? ''))
    : item.kind === 'plan_sign_in'
      ? copy.planSignIn(agentName(item.principal ?? ''))
      : item.kind === 'device_unverified'
        ? copy.device(item.device?.name)
        : copy.items[item.kind]
}

function Dot({ tone }: { tone: MatrixAttentionItem['tone'] }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', tone === 'danger' ? 'bg-(--atum-danger)' : 'bg-(--atum-warn)')}
    />
  )
}

/** A detailed item, in place: its sentence and the one or two actions that help. */
function Detail({
  headed,
  item,
  onOpen,
  onPutOff,
  snapshot
}: {
  /** Under its own label in a list of several: the label is not said twice. */
  headed?: boolean
  item: MatrixAttentionItem
  /** Opens the place the item's action lives (the devices list, for a device to verify). */
  onOpen(item: MatrixAttentionItem): void
  onPutOff(deviceId: string): void
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = useAttentionCopy()
  const words = useLaunchCopy()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const bridge = window.atumMatrix

  if (item.kind === 'new_sign_in' && item.newSignIn) {
    return (
      <MatrixNewSignInDetail
        headed={headed}
        locale={locale}
        onDismiss={deviceId => bridge.dismissNewSignIn(deviceId)}
        onSignOut={deviceId => bridge.endDeviceSession(deviceId)}
        view={item.newSignIn}
      />
    )
  }

  // The person's own device that assistants refuse until it is verified: why, then Verify (the
  // devices list, at that device) or Not now (until tomorrow, if it still isn't verified).
  if (item.kind === 'device_unverified' && item.device) {
    const device = item.device

    return (
      <div className="flex flex-col gap-2 p-1.5 text-(length:--atum-t-ui)" data-matrix-attention-detail={item.kind}>
        <p className="text-(--atum-ink-muted)">{copy.deviceHelp}</p>
        <p className="text-(--atum-ink-muted)">
          {matrixSecurityCopy(locale).seen(matrixDeviceLastSeen(device.lastSeenAt, locale))}
        </p>
        <p className="text-(--atum-ink-muted)">{copy.deviceCompareHelp}</p>
        {failed && <p role="alert">{copy.deviceManageFailed}</p>}
        <span className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => onOpen(item)} size="sm" variant="secondary">
            {copy.deviceVerify}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true)
              setFailed(false)
              void Promise.resolve()
                .then(() => bridge.endDeviceSession(device.deviceId))
                .catch(() => setFailed(true))
                .finally(() => setPending(false))
            }}
            size="sm"
            variant="text"
          >
            {copy.deviceNotMe}
          </Button>
          <Button onClick={() => onPutOff(device.deviceId)} size="sm" variant="text">
            {copy.notNow}
          </Button>
        </span>
      </div>
    )
  }

  if (item.kind === 'device_damaged') {
    return (
      <div className="flex flex-col gap-2 p-1.5 text-(length:--atum-t-ui)" data-matrix-attention-detail={item.kind}>
        {snapshot.deviceDamaged || snapshot.ownerDeviceRepair ? (
          <MatrixOwnerDeviceRepairNotice snapshot={snapshot} />
        ) : (
          <>
            <p>
              <span className="font-medium text-(--atum-ink)">{words.deviceDamagedTitle}</span>{' '}
              <span className="text-(--atum-ink-muted)">{words.deviceDamagedHelp}</span>
            </p>
            <span>
              <Button
                disabled={pending}
                onClick={() => {
                  setPending(true)
                  void runMatrixReadinessAction('sign_in_again', snapshot)
                    .catch(() => {})
                    .finally(() => setPending(false))
                }}
                size="sm"
                variant="secondary"
              >
                {words.signInAgain}
              </Button>
            </span>
          </>
        )}
      </div>
    )
  }

  return null
}

/**
 * The one place the window asks the person to act (agent-attention.ts). The bell is gone
 * (owner, 2026-11-24): what only it could act on (another device asking for approval, a sign-in
 * elsewhere, this Mac's damaged device, the room an assistant's listening stopped in) lives at the
 * top of the account face on the rail, which wears a red dot while an item waits. Each row acts
 * from where it is. It never takes focus by itself; a new item is said once to assistive tech.
 */
interface SectionProps {
  agentName(principal: string): string
  /** Opens the place an item's action lives (all but the detailed ones). */
  onOpen(item: MatrixAttentionItem): void
  /** The section's own action is done: the account face closes. */
  onDone?(): void
  snapshot: MatrixSnapshot
}

export function MatrixAttentionSection(props: SectionProps) {
  // Account changes reset the window's dismissal state as well as its persisted scope.
  return <AttentionSection key={props.snapshot.identity?.userId ?? ''} {...props} />
}

/** What waits for the person right now, for the account face's red dot and label. */
export function useMatrixAttentionSummary(snapshot: MatrixSnapshot, agentName: (principal: string) => string) {
  const { locale } = useI18n()
  const copy = useAttentionCopy()
  const now = useMatrixAttentionNow(snapshot)
  const items = snapshot.identity ? matrixAttentionItems(snapshot, now) : []
  const single = items.length === 1 ? items[0]! : undefined

  return {
    count: items.length,
    /** The face's marker, as the bell had it: the one item's kind, or `count` for several. */
    marker: items.length ? (single ? single.kind : 'count') : undefined,
    label: items.length
      ? `${copy.a11yPrefix} ${single ? itemLabel(single, copy, agentName, locale) : copy.count(items.length)}`
      : undefined
  }
}

/** The polite announcement of a new item, kept mounted while the account face is closed. */
export function MatrixAttentionAnnouncer({
  agentName,
  snapshot
}: Pick<SectionProps, 'agentName' | 'snapshot'>) {
  const { locale } = useI18n()
  const copy = useAttentionCopy()
  const now = useMatrixAttentionNow(snapshot)
  const items = snapshot.identity ? matrixAttentionItems(snapshot, now) : []
  const keys = items.map(itemKey).join('|')
  const seen = useRef<Set<string> | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // A new item is announced once, politely; the account face is not a live region itself.
  useEffect(() => {
    const current = new Set(keys ? keys.split('|') : [])
    const previous = seen.current
    seen.current = current

    if (!previous) {
      return
    }

    const added = items.find(item => !previous.has(itemKey(item)))

    if (added) {
      setAnnouncement(`${copy.a11yPrefix} ${itemLabel(added, copy, agentName, locale)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is the items' identity.
  }, [keys])

  return (
    <span aria-live="polite" className="sr-only" data-matrix-attention-live>
      {announcement}
    </span>
  )
}

function AttentionSection({ agentName, onDone, onOpen, snapshot }: SectionProps) {
  const { locale } = useI18n()
  const copy = useAttentionCopy()
  const now = useMatrixAttentionNow(snapshot)
  const ownerId = snapshot.identity?.userId ?? ''
  const [putOff, setPutOff] = useState(() => devicesPutOff(ownerId))

  const items = matrixAttentionItems(snapshot, now)

  if (!items.length) {
    return null
  }

  // Today's put-offs only: an older one has nothing left to hold back.
  const putDeviceOff = (deviceId: string) => {
    const today = matrixLocalDay(Date.now())

    const next = {
      ...Object.fromEntries(Object.entries(putOff).filter(([, day]) => day === today)),
      [deviceId]: today
    }

    try {
      window.localStorage.setItem(`${DEVICE_PUT_OFF_KEY}:${ownerId}`, JSON.stringify(next))
    } catch {
      // Storage off: put off for this window only.
    }

    setPutOff(next)
    onDone?.()
  }

  const openItem = (item: MatrixAttentionItem) => {
    onDone?.()
    onOpen(item)
  }

  return (
    // Plain buttons inside a menu: Tab moves between them, so the menu's own keys stop here.
    <section
      aria-label={copy.notifications}
      className="mx-1 mb-1 rounded-lg bg-(--atum-sunk) p-1"
      data-matrix-attention-list
      onKeyDown={event => {
        if (event.key !== 'Escape') {
          event.stopPropagation()
        }
      }}
    >
      <ul className="flex flex-col gap-0.5">
        {items.map(item => (
          <li data-matrix-attention-row={item.kind} key={itemKey(item)}>
            {DETAILED.has(item.kind) ? (
              <div className="flex flex-col">
                <span className="flex items-center gap-2 px-1.5 pt-1.5 text-(length:--atum-t-ui) font-medium">
                  <Dot tone={item.tone} />
                  {itemLabel(item, copy, agentName, locale)}
                </span>
                <Detail headed item={item} onOpen={openItem} onPutOff={putDeviceOff} snapshot={snapshot} />
              </div>
            ) : (
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-(length:--atum-t-ui) hover:bg-(--atum-hover) focus-visible:bg-(--atum-hover)"
                data-matrix-attention-item={item.kind}
                onClick={() => openItem(item)}
                type="button"
              >
                <Dot tone={item.tone} />
                <span className="min-w-0 flex-1 truncate">{itemLabel(item, copy, agentName, locale)}</span>
                <ChevronRight aria-hidden className="size-3.5 text-(--atum-ink-faint)" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

const LIVE_APPROVAL = new Set(['asked', 'waiting', 'compare', 'unlocking'])
/** A live request remains in the indicator after this; it no longer interrupts on focus. */
const AUTO_OPEN_MS = 5 * 60_000

/**
 * Whether another device's request to be approved shows its sheet (owner decision D1): always
 * from the indicator; by itself when this window comes to the front during the first five minutes
 * of a live state. A request that ends unseen is cleared, never left behind.
 */
export function useMatrixApprovalSheet(approval: MatrixApprovalView | undefined): {
  open: boolean
  show(): void
} {
  const asking = approval?.role === 'approve'
  const live = asking && LIVE_APPROVAL.has(approval.state)
  const [shown, setShown] = useState(false)

  // A new request starts its own sheet.
  useEffect(() => {
    if (!asking) {
      setShown(false)
    }
  }, [asking])

  useEffect(() => {
    if (!live || shown) {
      return
    }

    const fresh = () => Date.now() - (approval?.since ?? 0) < AUTO_OPEN_MS

    const tryOpen = () => {
      if (fresh() && document.hasFocus()) {
        setShown(true)
      }
    }

    tryOpen()
    window.addEventListener('focus', tryOpen)

    return () => window.removeEventListener('focus', tryOpen)
  }, [live, shown, approval?.since])

  // Ended before the person looked (timed out, cancelled elsewhere): nothing left to say.
  useEffect(() => {
    if (asking && !live && !shown) {
      void window.atumMatrix?.approval?.dismiss().catch(() => {})
    }
  }, [asking, live, shown])

  return { open: Boolean(asking && shown), show: () => setShown(true) }
}
