import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { World } from '@/lib/icons'

import type { MatrixWebPreviewOffer } from '../../shared/matrix-workbench-preview'

const copy = {
  en: {
    open: 'View page',
    from: 'A page your assistant made',
    dismiss: 'Dismiss',
    full: 'Close a side panel tab to open this page.',
    failed: 'This page is no longer available. Ask your assistant for a new one.'
  },
  vi: {
    open: 'Xem trang',
    from: 'Trang do trợ lý tạo',
    dismiss: 'Bỏ qua',
    full: 'Đóng bớt một thẻ trong bảng làm việc để mở trang này.',
    failed: 'Trang này không còn nữa. Hãy nhờ trợ lý tạo lại.'
  },
  zh: {
    open: '查看页面',
    from: '助手制作的页面',
    dismiss: '忽略',
    full: '请关闭一个侧边面板标签页以打开此页面。',
    failed: '此页面已不可用。请让助手重新制作。'
  },
  'zh-hant': {
    open: '查看頁面',
    from: '助理製作的頁面',
    dismiss: '略過',
    full: '請關閉一個側邊面板分頁以開啟此頁面。',
    failed: '此頁面已無法使用。請讓助理重新製作。'
  },
  ja: {
    open: 'ページを見る',
    from: 'アシスタントが作ったページ',
    dismiss: '閉じる',
    full: 'このページを開くには、サイドパネルのタブを閉じてください。',
    failed: 'このページは利用できなくなりました。アシスタントに作り直してもらってください。'
  }
}

const LOCAL_HOSTNAME = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)(?::\d+)?$/i

/** A developer's localhost means nothing to the person; a public site name does. */
export function webPreviewPlace(hostname: string): string | null {
  return hostname && !LOCAL_HOSTNAME.test(hostname.trim()) ? hostname : null
}

interface Props {
  offer?: MatrixWebPreviewOffer
  roomId: string | null
  scope: string
  full?: boolean
  onOpened(value: { id: string; url: string; scope: string }): void
}

/** An incoming offer never opens a tab or moves focus. Only the click does. */
export function MatrixWebPreviewOfferCard({ offer, roomId, scope, full = false, onOpened }: Props) {
  const { locale } = useI18n()
  const c = copy[locale] ?? copy.en
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expiry, setExpiry] = useState(0)
  const latest = useRef(scope)
  const generation = useRef(0)

  // Fence during render: an effect leaves a gap for an already resolved receipt
  // after room selection. Abandoned renders can only retire authority early.
  if (latest.current !== scope) {
    generation.current += 1
  }

  latest.current = scope
  const latestOffer = useRef(offer?.id)

  if (offer) {
    latestOffer.current = offer.id
  }

  const alive = useRef(true)
  const offerId = offer?.id
  const expiresAt = offer?.expiresAt
  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    setFailed(false)
    setPending(false)
    setExpiry(0)

    if (!offerId || expiresAt === undefined) {
      return
    }

    const timer = setTimeout(() => setExpiry(expiresAt), Math.max(0, expiresAt - Date.now()))

    return () => clearTimeout(timer)
  }, [offerId, expiresAt, scope])

  const act = async (kind: 'openWebPreview' | 'dismissWebPreview') => {
    if (!offer || !roomId || pending || (kind === 'openWebPreview' && full)) {
      return
    }

    const expected = scope
    const expectedGeneration = generation.current
    setPending(true)
    setFailed(false)

    try {
      const result = await window.atumMatrix.command({ kind, roomId, id: offer.id })

      if (
        !alive.current ||
        latest.current !== expected ||
        generation.current !== expectedGeneration ||
        latestOffer.current !== offer.id
      ) {
        return
      }

      if (kind === 'openWebPreview') {
        const value = result as { id?: unknown; url?: unknown } | null

        if (value?.id !== offer.id || typeof value.url !== 'string') {
          throw new Error('preview unavailable')
        }

        onOpened({ id: offer.id, url: value.url, scope: expected })
      }
    } catch {
      if (
        alive.current &&
        latest.current === expected &&
        generation.current === expectedGeneration &&
        latestOffer.current === offer.id
      ) {
        setFailed(true)
      }
    } finally {
      if (
        alive.current &&
        latest.current === expected &&
        generation.current === expectedGeneration &&
        latestOffer.current === offer.id
      ) {
        setPending(false)
      }
    }
  }

  if (failed) {
    return (
      <NoticeBand role="status" tone="notice">
        {c.failed}
      </NoticeBand>
    )
  }

  if (!offer || !roomId || offer.expiresAt <= Math.max(Date.now(), expiry)) {
    return null
  }

  const place = webPreviewPlace(offer.hostname)

  // An offer, not an alarm: a quiet card with the page's name and one real button.
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-3 rounded-(--atum-r-card) bg-(--atum-card) px-3 py-2.5 shadow-(--atum-glass-edge)"
      data-matrix-web-preview-offer
      role="status"
    >
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[0.5rem] bg-(--atum-sunk) text-(--atum-ink-soft)">
        <World className="size-4" strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-(length:--atum-t-control) font-medium text-(--atum-ink)">{offer.label}</span>
        <span className="block truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">
          {full ? c.full : (place ?? c.from)}
        </span>
      </span>
      <Button
        aria-label={`${c.open} · ${offer.label}`}
        disabled={pending || full}
        onClick={() => void act('openWebPreview')}
        size="sm"
      >
        {c.open}
      </Button>
      <Button disabled={pending} onClick={() => void act('dismissWebPreview')} size="sm" variant="ghost">
        {c.dismiss}
      </Button>
    </div>
  )
}
