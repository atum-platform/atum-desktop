import { useState } from 'react'

import { NoticeBand } from '@/components/ui/error-state'
import { type Locale, useI18n } from '@/i18n'

import type { MatrixRecoveredResult } from '../../shared/matrix'

const copies: Record<Locale, { checking: string; unknown: string; found: string; unverified: string; error: string }> = {
  en: {
    checking: 'Looking for the earlier answer…',
    unknown: 'No earlier answer found. Nothing was run again.',
    found: 'Found the earlier answer.',
    unverified: 'Saved answer (not verified on this Mac).',
    error: 'Couldn’t look for the earlier answer. Try again.'
  },
  vi: {
    checking: 'Đang tìm câu trả lời trước đó…',
    unknown: 'Không tìm thấy câu trả lời. Không có gì chạy lại.',
    found: 'Đã tìm thấy câu trả lời trước đó.',
    unverified: 'Câu trả lời đã lưu (chưa xác minh trên máy này).',
    error: 'Chưa tìm được câu trả lời trước đó. Thử lại nhé.'
  },
  ja: {
    checking: '以前の回答を探しています…',
    unknown: '以前の回答は見つかりませんでした。何も再実行していません。',
    found: '以前の回答が見つかりました。',
    unverified: '保存された回答（このMacでは未確認）。',
    error: '以前の回答を探せませんでした。もう一度お試しください。'
  },
  zh: {
    checking: '正在查找之前的回答…',
    unknown: '未找到之前的回答。没有重新运行任何内容。',
    found: '已找到之前的回答。',
    unverified: '已保存的回答（未在这台 Mac 上验证）。',
    error: '无法查找之前的回答，请重试。'
  },
  'zh-hant': {
    checking: '正在尋找先前的回答…',
    unknown: '找不到先前的回答。沒有重新執行任何內容。',
    found: '已找到先前的回答。',
    unverified: '已儲存的回答（未在這台 Mac 上驗證）。',
    error: '無法尋找先前的回答，請再試一次。'
  }
}

/** Owned by the message, not the transient action popover. */
export function useResultRecovery(roomId: string | undefined, eventId: string) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<MatrixRecoveredResult | null>(null)
  const [error, setError] = useState(false)

  const recover = () => {
    if (!roomId || pending) {
      return
    }

    setPending(true)
    setError(false)
    setResult(null)
    void window.atumMatrix
      .recoverHermes(roomId, eventId)
      .then(setResult)
      .catch(() => setError(true))
      .finally(() => setPending(false))
  }

  return { pending, result, error, recover }
}

type Recovery = ReturnType<typeof useResultRecovery>

export function ResultRecoveryOutcome({ recovery: { pending, error, result } }: { recovery: Recovery }) {
  const { locale } = useI18n()
  const copy = copies[locale]

  return pending ? (
    <p className="text-xs text-(--atum-ink-muted)" role="status">
      {copy.checking}
    </p>
  ) : error || result ? (
    <div className="grid max-w-full gap-1 text-sm" data-matrix-recovery role="status">
      {error ? (
        <NoticeBand tone="failure">{copy.error}</NoticeBand>
      ) : result?.state === 'unverified' ? (
        <NoticeBand tone="notice">{copy.unverified}</NoticeBand>
      ) : (
        <p className="text-xs text-(--atum-ink-muted)">{result?.state === 'published' ? copy.found : copy.unknown}</p>
      )}
      {result && result.state !== 'unknown' && <p className="whitespace-pre-wrap">{result.body}</p>}
    </div>
  ) : null
}
