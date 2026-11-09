import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { type Locale, useI18n } from '@/i18n'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

import type { MatrixLoginStartupBridge, MatrixLoginStartupStatus } from '../../shared/matrix-login-startup'

const copy: Record<
  Locale,
  {
    label: string
    help: string
    approval: string
    development: string
    unavailable: string
    failed: string
    refresh: string
    openSettings: string
    announced: string
    gotIt: string
  }
> = {
  en: {
    label: 'Open Atum when you log in',
    help: 'So Atum can follow up on things while you work',
    approval:
      'macOS approval is required in System Settings › General › Login Items. Atum will not start at login yet.',
    development: 'Available in the installed Mac app, not a development preview.',
    unavailable: 'Could not read the login setting on this Mac.',
    failed: 'Atum could not change the login setting. Check macOS Login Items, then try again.',
    refresh: 'Check again',
    openSettings: 'Open Login Items',
    announced: 'Atum now opens when you log in to this Mac. You can turn this off in Settings.',
    gotIt: 'OK'
  },
  vi: {
    label: 'Mở Atum khi bạn đăng nhập',
    help: 'Để Atum có thể tiếp tục công việc trong khi bạn làm việc',
    approval:
      'Cần cho phép trong Cài đặt hệ thống của macOS › Cài đặt chung › Mục đăng nhập. Atum chưa tự mở khi đăng nhập.',
    development: 'Có trong ứng dụng Mac đã cài đặt, không có ở bản xem trước phát triển.',
    unavailable: 'Chưa đọc được thiết lập đăng nhập trên máy Mac này.',
    failed: 'Atum chưa thay đổi được thiết lập đăng nhập. Hãy kiểm tra Mục đăng nhập của macOS rồi thử lại.',
    refresh: 'Kiểm tra lại',
    openSettings: 'Mở Mục đăng nhập',
    announced: 'Giờ Atum sẽ tự mở khi bạn đăng nhập vào máy Mac này. Bạn có thể tắt trong Cài đặt.',
    gotIt: 'Đã hiểu'
  },
  ja: {
    label: 'ログイン時に Atum を開く',
    help: '作業中も Atum が続きを進められるようにします',
    approval: 'システム設定 › 一般 › ログイン項目で macOS の承認が必要です。まだログイン時には起動しません。',
    development: 'インストール済みの Mac アプリで利用できます。開発プレビューでは利用できません。',
    unavailable: 'この Mac のログイン設定を読み取れませんでした。',
    failed: 'Atum はログイン設定を変更できませんでした。macOS のログイン項目を確認してから、もう一度お試しください。',
    refresh: '再確認',
    openSettings: 'ログイン項目を開く',
    announced: 'この Mac にログインすると Atum が開くようになりました。設定でオフにできます。',
    gotIt: 'OK'
  },
  zh: {
    label: '登录时打开 Atum',
    help: '让 Atum 在你工作时继续跟进',
    approval: '需要在系统设置 › 通用 › 登录项中获得 macOS 批准。Atum 尚不会在登录时启动。',
    development: '仅在已安装的 Mac 应用中可用，开发预览版不支持。',
    unavailable: '无法读取此 Mac 的登录设置。',
    failed: 'Atum 无法更改登录设置。请检查 macOS 登录项后重试。',
    refresh: '重新检查',
    openSettings: '打开登录项',
    announced: '现在登录这台 Mac 时会打开 Atum。你可以在设置中关闭。',
    gotIt: '好'
  },
  'zh-hant': {
    label: '登入時開啟 Atum',
    help: '讓 Atum 在你工作時繼續跟進',
    approval: '需要在系統設定 › 一般 › 登入項目中取得 macOS 核准。Atum 尚不會在登入時啟動。',
    development: '僅在已安裝的 Mac 應用程式中可用，開發預覽版不支援。',
    unavailable: '無法讀取此 Mac 的登入設定。',
    failed: 'Atum 無法更改登入設定。請檢查 macOS 登入項目後再試一次。',
    refresh: '重新檢查',
    openSettings: '開啟登入項目',
    announced: '現在登入這台 Mac 時會開啟 Atum。你可以在設定中關閉。',
    gotIt: '好'
  }
}

/** OS state belongs to this device, not the current account or portable settings. */
export function MatrixLoginStartupSettings({
  bridge = window.atumLoginStartup
}: {
  bridge?: MatrixLoginStartupBridge
}) {
  const { locale } = useI18n()
  const words = copy[locale]
  const descriptionId = useId()
  const detailId = useId()
  const [status, setStatus] = useState<MatrixLoginStartupStatus | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [reading, setReading] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const writing = useRef(false)

  const refresh = useCallback(async () => {
    if (writing.current) {
      return
    }

    const token = ++generation.current
    setReading(true)

    try {
      const next = bridge ? await bridge.status() : { state: 'unavailable' as const, reason: 'unsupported' as const }

      if (mounted.current && generation.current === token) {
        setStatus(next)
        setFailed(false)
      }
    } catch {
      if (mounted.current && generation.current === token) {
        setStatus(previous => previous ?? { state: 'unavailable', reason: 'os_error' })
        setFailed(true)
      }
    } finally {
      if (mounted.current && generation.current === token) {
        setReading(false)
      }
    }
  }, [bridge])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const focus = () => void refresh()
    window.addEventListener('focus', focus)

    return () => {
      mounted.current = false
      generation.current += 1
      window.removeEventListener('focus', focus)
    }
  }, [refresh])

  const change = async (enabled: boolean) => {
    if (!bridge || writing.current || !status || status.state === 'unavailable') {
      return
    }

    writing.current = true
    const token = ++generation.current
    setReading(false)
    setPending(enabled)
    setFailed(false)

    try {
      const next = await bridge.setEnabled(enabled)

      if (mounted.current && generation.current === token) {
        setStatus(next)
        setFailed(!loginStartupChangeMatches(next, enabled))
      }
    } catch {
      let actual: MatrixLoginStartupStatus

      try {
        actual = await bridge.status()
      } catch {
        actual = { state: 'unavailable', reason: 'os_error' }
      }

      if (mounted.current && generation.current === token) {
        setStatus(actual)
        setFailed(!loginStartupChangeMatches(actual, enabled))
      }
    } finally {
      writing.current = false

      if (mounted.current && generation.current === token) {
        setPending(null)
      }
    }
  }

  const registered = status?.state === 'enabled' || status?.state === 'requires_approval'
  const unavailable = status?.state === 'unavailable'

  const detail =
    status?.state === 'requires_approval'
      ? words.approval
      : unavailable
        ? status.reason === 'development'
          ? words.development
          : words.unavailable
        : words.help

  const checkAgain = (unavailable || failed || status?.state === 'requires_approval') && bridge

  // macOS has the last word only on a real Mac login item: an approval, or a change it refused.
  // The pane to send them to exists only on macOS 13+ (the reading says so; macOS 12 has none).
  const openLoginItems =
    status?.state !== 'unavailable' &&
    status?.loginItemsPane === true &&
    (status.state === 'requires_approval' || failed) &&
    bridge

  // One row of the section's card: what it does for this Mac, what macOS still needs (if
  // anything), and the switch — with "Check again" beside it when macOS has the last word.
  return (
    <div className="atum-settings-item" data-matrix-login-startup>
      <div aria-busy={pending !== null || reading} className="atum-settings-row">
        <span className="atum-settings-row-text">
          <span className="atum-settings-row-title">{words.label}</span>
          {/* One visible line: what it does, or — when macOS has the last word — what is left
              to do, with "Check again" right after it. The purpose stays for screen readers. */}
          <span className={detail !== words.help ? 'sr-only' : 'atum-settings-row-help'} id={descriptionId}>
            {words.help}
          </span>
          {detail !== words.help && (
            <span
              className="atum-settings-row-help"
              data-tone={status?.state === 'requires_approval' ? 'warn' : undefined}
              id={detailId}
            >
              {detail}
            </span>
          )}
          {checkAgain && (
            <span className="atum-settings-row-help">
              <Button
                disabled={reading || pending !== null}
                onClick={() => void refresh()}
                size="inline"
                variant="textStrong"
              >
                {words.refresh}
              </Button>
              {openLoginItems && (
                <>
                  <span aria-hidden="true">{' · '}</span>
                  <Button
                    onClick={() => void bridge.openSettings().catch(() => setFailed(true))}
                    size="inline"
                    variant="textStrong"
                  >
                    {words.openSettings}
                  </Button>
                </>
              )}
            </span>
          )}
        </span>
        <span className="atum-settings-row-control">
          <Switch
            aria-describedby={detail !== words.help ? `${descriptionId} ${detailId}` : descriptionId}
            aria-label={words.label}
            checked={pending ?? registered}
            disabled={!bridge || !status || unavailable || pending !== null}
            onCheckedChange={enabled => void change(enabled)}
          />
        </span>
      </div>
      {failed && (
        <NoticeBand role="status" tone="notice">
          {words.failed}
        </NoticeBand>
      )}
    </div>
  )
}

function loginStartupChangeMatches(status: MatrixLoginStartupStatus, enabled: boolean): boolean {
  return enabled ? status.state === 'enabled' || status.state === 'requires_approval' : status.state === 'disabled'
}

/**
 * The one line after Atum turned open at login on by itself (on by default, once per Mac;
 * electron/matrix/login-startup.ts applyDefault): what it did and where to turn it off, until
 * the person acknowledges it. Shown over whatever the window shows, on the first launch after
 * install or upgrade; never again once acknowledged or if the person turned it off meanwhile.
 */
export function MatrixLoginStartupMention({ bridge = window.atumLoginStartup }: { bridge?: MatrixLoginStartupBridge }) {
  const { locale } = useI18n()
  const words = copy[locale]
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let live = true

    void bridge?.status().then(
      next => {
        if (live && next.state === 'enabled' && next.announce) {
          setShown(true)
        }
      },
      () => {}
    )

    return () => {
      live = false
    }
  }, [bridge])

  if (!shown || !bridge) {
    return null
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
      data-matrix-login-startup-mention
    >
      <AppViewOverlayHold />
      <NoticeBand className="pointer-events-auto max-w-md" role="status" tone="notice">
        <span>
          {words.announced}{' '}
          <Button
            onClick={() => {
              setShown(false)
              void bridge.acknowledge().catch(() => {})
            }}
            size="inline"
            variant="textStrong"
          >
            {words.gotIt}
          </Button>
        </span>
      </NoticeBand>
    </div>
  )
}
