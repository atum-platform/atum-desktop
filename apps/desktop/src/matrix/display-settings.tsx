import { useEffect, useRef, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { type Locale, useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import {
  type MatrixDisplayPreferenceChange,
  matrixDisplayPreferenceChange,
  type MatrixTextSize
} from '../../shared/matrix-display-preferences'

import { SettingsRow } from './settings-row'

const notices: Record<
  Locale,
  { failed: string; waiting: string; readonly: string; unavailable: string; retry: string }
> = {
  en: {
    failed: 'Could not save this setting. Try again.',
    waiting: 'Waiting for your setting to sync.',
    readonly: 'This setting needs a newer Atum version.',
    unavailable: 'Can’t load these settings right now.',
    retry: 'Try again'
  },
  vi: {
    failed: 'Chưa lưu được thiết lập. Hãy thử lại.',
    waiting: 'Đang chờ đồng bộ thiết lập của bạn.',
    readonly: 'Thiết lập này cần phiên bản Atum mới hơn.',
    unavailable: 'Chưa tải được các cài đặt này.',
    retry: 'Thử lại'
  },
  ja: {
    failed: '設定を保存できませんでした。もう一度お試しください。',
    waiting: '設定の同期を待っています。',
    readonly: 'この設定には新しい Atum が必要です。',
    unavailable: 'いまはこれらの設定を読み込めません。',
    retry: 'もう一度試す'
  },
  zh: {
    failed: '无法保存此设置，请重试。',
    waiting: '正在等待设置同步。',
    readonly: '此设置需要更新版本的 Atum。',
    unavailable: '暂时无法加载这些设置。',
    retry: '重试'
  },
  'zh-hant': {
    failed: '無法儲存此設定，請重試。',
    waiting: '正在等待設定同步。',
    readonly: '此設定需要更新版本的 Atum。',
    unavailable: '暫時無法載入這些設定。',
    retry: '再試一次'
  }
}

/** Three sizes, three words: a segmented choice rather than a slider for three stops. */
const textSizes: Record<Locale, Record<MatrixTextSize, string>> = {
  en: { 90: 'Small', 100: 'Default', 110: 'Large' },
  vi: { 90: 'Nhỏ', 100: 'Mặc định', 110: 'Lớn' },
  ja: { 90: '小', 100: '標準', 110: '大' },
  zh: { 90: '小', 100: '默认', 110: '大' },
  'zh-hant': { 90: '小', 100: '預設', 110: '大' }
}

/**
 * The account's display settings have not arrived (or the account is not connected yet):
 * one plain line and a way to try again, never controls that look on but do nothing.
 */
function SettingsUnavailable() {
  const { locale } = useI18n()
  const copy = notices[locale]

  return (
    <SettingsRow
      className="atum-settings-row-quiet"
      control={
        <Button onClick={() => void window.atumMatrix.retry().catch(() => {})} size="sm" variant="secondary">
          {copy.retry}
        </Button>
      }
      data-matrix-settings-unavailable
      role="status"
      title={copy.unavailable}
    />
  )
}

interface Pending {
  change: MatrixDisplayPreferenceChange
  acknowledged: boolean
}

/** Mounted for one identity: a late save must never paint the next account. */
export function useMatrixDisplaySetting(snapshot: MatrixSnapshot, field: MatrixDisplayPreferenceChange['field']) {
  const identity = snapshot.identity
  const { locale } = useI18n()
  const copy = notices[locale]
  const projection = snapshot.displayPreferences?.[field]
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<'failed' | 'waiting' | null>(null)
  const generation = useRef(0)
  const writing = useRef(false)

  useEffect(() => {
    const mounted = ++generation.current

    return () => {
      generation.current = mounted + 1
    }
  }, [])
  useEffect(() => {
    if (!pending?.acknowledged) {
      return
    }

    if (projection?.value === pending.change.value) {
      setPending(null)
      setNotice(null)

      return
    }

    const timer = setTimeout(() => {
      setPending(null)
      setNotice('waiting')
    }, 10_000)

    return () => clearTimeout(timer)
  }, [pending, projection?.value])

  const change = async (value: unknown) => {
    if (!identity || writing.current || pending || !projection?.writable || snapshot.state !== 'ready') {
      return false
    }

    let next: MatrixDisplayPreferenceChange

    try {
      next = matrixDisplayPreferenceChange(field, value)
    } catch {
      setNotice('failed')

      return false
    }

    if (next.value === projection.value) {
      return false
    }

    writing.current = true
    const started = generation.current
    setNotice(null)
    setPending({ change: next, acknowledged: false })

    try {
      await window.atumMatrix.command({ kind: 'displayPreference', identity, ...next })

      if (generation.current === started) {
        setPending({ change: next, acknowledged: true })

        return true
      }
    } catch {
      if (generation.current === started) {
        setPending(null)
        setNotice('failed')
      }
    } finally {
      writing.current = false
    }

    return false
  }

  const disabled = snapshot.state !== 'ready' || !projection?.writable || Boolean(pending)
  const readonly = snapshot.state === 'ready' && projection && !projection.writable

  return { change, copy, disabled, notice, readonly }
}

function DisplaySetting({ snapshot, field }: { snapshot: MatrixSnapshot; field: 'appearance' | 'textSize' }) {
  const { locale, t } = useI18n()
  const { change, copy, disabled, notice, readonly } = useMatrixDisplaySetting(snapshot, field)
  const label = t.atum.settings[field === 'appearance' ? 'appearance' : 'textSize']

  return (
    <div className="atum-settings-item">
      <SettingsRow
        control={
          field === 'appearance' ? (
            <AtumSegmented
              disabled={disabled}
              label={t.atum.settings.appearance}
              onChange={value => void change(value)}
              options={(['system', 'light', 'dark'] as const).map(id => ({
                id,
                label: t.settings.modeOptions[id].label
              }))}
              value={snapshot.displayPreferences?.appearance.value ?? 'system'}
            />
          ) : (
            <AtumSegmented
              disabled={disabled}
              label={t.atum.settings.textSize}
              onChange={value => void change(Number(value))}
              options={([90, 100, 110] as const).map(size => ({ id: String(size), label: textSizes[locale][size] }))}
              value={String(snapshot.displayPreferences?.textSize.value ?? 100)}
            />
          )
        }
        title={label}
      />
      {(notice || readonly) && (
        <NoticeBand role="status" tone="notice">
          {notice ? copy[notice] : copy.readonly}
        </NoticeBand>
      )}
    </div>
  )
}

type SwitchField = 'notifications' | 'sound'

const switchLabels: Record<Locale, Record<SwitchField, string>> = {
  en: {
    notifications: 'Notifications',
    sound: 'Sounds'
  },
  vi: {
    notifications: 'Thông báo',
    sound: 'Âm thanh'
  },
  ja: {
    notifications: '通知',
    sound: 'サウンド'
  },
  zh: { notifications: '通知', sound: '声音' },
  'zh-hant': { notifications: '通知', sound: '聲音' }
}

const switchHelp: Record<Locale, Partial<Record<SwitchField, string>>> = {
  en: { notifications: 'Messages, and when Atum finishes something or needs you' },
  vi: { notifications: 'Tin nhắn, và khi Atum hoàn tất việc gì đó hoặc cần bạn' },
  ja: { notifications: 'メッセージと、Atum が作業を終えたときやあなたを必要とするとき' },
  zh: { notifications: '消息，以及 Atum 完成任务或需要你时' },
  'zh-hant': { notifications: '訊息，以及 Atum 完成工作或需要你時' }
}

/** Notifications, sound and the composer's model choice start on (lineup, 2026-10-17). */
const SWITCH_DEFAULT: Record<SwitchField, boolean> = { notifications: true, sound: true }

function SwitchSetting({ snapshot, field }: { snapshot: MatrixSnapshot; field: SwitchField }) {
  const { locale } = useI18n()
  const label = switchLabels[locale][field]
  const { change, copy, disabled, notice, readonly } = useMatrixDisplaySetting(snapshot, field)

  return (
    <div className="atum-settings-item">
      <SettingsRow
        control={
          <Switch
            aria-label={label}
            checked={snapshot.displayPreferences?.[field]?.value ?? SWITCH_DEFAULT[field]}
            disabled={disabled}
            onCheckedChange={value => void change(value)}
          />
        }
        help={switchHelp[locale][field]}
        title={label}
      />
      {(notice || readonly) && (
        <NoticeBand role="status" tone="notice">
          {notice ? copy[notice] : copy.readonly}
        </NoticeBand>
      )}
    </div>
  )
}

/** Settings › General › Notifications: two switches, rows of the section's card. */
export function MatrixNotificationSettings({ snapshot }: { snapshot: MatrixSnapshot }) {
  if (!snapshot.identity) {
    return null
  }

  if (!snapshot.displayPreferences?.notifications) {
    return <SettingsUnavailable />
  }

  return (
    <>
      {(['notifications', 'sound'] as const).map(field => (
        <SwitchSetting
          field={field}
          key={`${snapshot.identity!.userId}:${snapshot.identity!.deviceId}:${field}`}
          snapshot={snapshot}
        />
      ))}
    </>
  )
}

/** Settings › General › Look: appearance and text size. */
export function MatrixDisplaySettings({ snapshot }: { snapshot: MatrixSnapshot }) {
  if (!snapshot.identity) {
    return null
  }

  if (!snapshot.displayPreferences) {
    return <SettingsUnavailable />
  }

  const scope = `${snapshot.identity.userId}:${snapshot.identity.deviceId}`

  return (
    <>
      {(['appearance', 'textSize'] as const).map(field => (
        <DisplaySetting field={field} key={`${scope}:${field}`} snapshot={snapshot} />
      ))}
    </>
  )
}
