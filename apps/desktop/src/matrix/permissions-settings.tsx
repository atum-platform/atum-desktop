import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { type Locale, useI18n } from '@/i18n'

import {
  type MatrixPermission,
  type MatrixPermissionsBridge,
  type MatrixPermissionsSnapshot,
  type MatrixPermissionStatus
} from '../../shared/matrix-permissions'

import { SettingsRow, SettingsSection, SettingsStatus } from './settings-row'

/** Most asked-for first. */
const permissionKeys: readonly MatrixPermission[] = [
  'screen',
  'accessibility',
  'microphone',
  'automation',
  'files',
  'fullDisk',
  'location'
]

interface PermissionCopy {
  title: string
  allowed: string
  allow: string
  restricted: string
  footnote: string
  unavailable: string
  unsupported: string
  statusFailed: string
  retry: string
  openFailed: string
  names: Record<MatrixPermission, string>
  /** One line each: what the access lets Atum do, in the person's words. */
  purposes: Record<MatrixPermission, string>
}

interface MatrixPermissionsSettingsProps {
  active: boolean
  bridge?: MatrixPermissionsBridge
}

const copy: Record<Locale, PermissionCopy> = {
  en: {
    title: 'Mac permissions',
    allowed: 'Allowed',
    allow: 'Allow…',
    restricted: 'Restricted by macOS',
    footnote: 'Changes may need Atum to restart.',
    unavailable: 'This version of Atum can’t show these. Check System Settings › Privacy & Security.',
    unsupported: 'These are available on a Mac.',
    statusFailed: 'Couldn’t check these right now.',
    retry: 'Try again',
    openFailed: 'Couldn’t open System Settings. Open System Settings › Privacy & Security.',
    names: {
      accessibility: 'Accessibility',
      screen: 'Screen recording',
      microphone: 'Microphone',
      automation: 'Automation',
      files: 'Files and folders',
      fullDisk: 'Messages and Safari',
      location: 'Location'
    },
    purposes: {
      screen: 'Lets Atum see your screen when you ask.',
      accessibility: 'Lets Atum click and type for you when you ask.',
      microphone: 'Lets you talk to Atum.',
      automation: 'Lets Atum work in your other apps.',
      files: 'Lets Atum open the files and folders you choose.',
      fullDisk: 'Lets Atum read Messages and Safari history after you switch those sources on.',
      location: 'Lets Atum use precise location only when your request needs it.'
    }
  },
  vi: {
    title: 'Quyền trên Mac',
    allowed: 'Đã cho phép',
    allow: 'Cho phép…',
    restricted: 'Bị macOS hạn chế',
    footnote: 'Có thể cần mở lại Atum để áp dụng.',
    unavailable: 'Phiên bản Atum này chưa hiện được các quyền. Hãy xem Cài đặt hệ thống › Quyền riêng tư & Bảo mật.',
    unsupported: 'Các quyền này chỉ có trên máy Mac.',
    statusFailed: 'Chưa kiểm tra được các quyền lúc này.',
    retry: 'Thử lại',
    openFailed: 'Không mở được Cài đặt hệ thống. Hãy mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật.',
    names: {
      accessibility: 'Trợ năng',
      screen: 'Ghi màn hình',
      microphone: 'Micrô',
      automation: 'Tự động hóa',
      files: 'Tệp và thư mục',
      fullDisk: 'Tin nhắn và Safari',
      location: 'Vị trí'
    },
    purposes: {
      screen: 'Cho phép Atum xem màn hình khi bạn yêu cầu.',
      accessibility: 'Cho phép Atum nhấp và gõ giúp bạn khi bạn yêu cầu.',
      microphone: 'Cho phép bạn nói chuyện với Atum.',
      automation: 'Cho phép Atum làm việc trong các ứng dụng khác của bạn.',
      files: 'Cho phép Atum mở các tệp và thư mục bạn chọn.',
      fullDisk: 'Cho phép Atum đọc Tin nhắn và lịch sử Safari sau khi bạn bật các nguồn đó.',
      location: 'Cho phép Atum dùng vị trí chính xác chỉ khi yêu cầu của bạn cần.'
    }
  },
  ja: {
    title: 'Mac のアクセス許可',
    allowed: '許可済み',
    allow: '許可…',
    restricted: 'macOS により制限',
    footnote: '変更を反映するには Atum の再起動が必要な場合があります。',
    unavailable: 'このバージョンの Atum では表示できません。システム設定 › プライバシーとセキュリティで確認してください。',
    unsupported: 'これらは Mac で利用できます。',
    statusFailed: 'いまは確認できませんでした。',
    retry: 'もう一度試す',
    openFailed: 'システム設定を開けませんでした。システム設定 › プライバシーとセキュリティを開いてください。',
    names: {
      accessibility: 'アクセシビリティ',
      screen: '画面収録',
      microphone: 'マイク',
      automation: 'オートメーション',
      files: 'ファイルとフォルダ',
      fullDisk: 'メッセージと Safari',
      location: '位置情報'
    },
    purposes: {
      screen: '頼んだときに Atum が画面を見られるようにします。',
      accessibility: '頼んだときに Atum がクリックや入力を代わりに行えるようにします。',
      microphone: 'Atum と話せるようにします。',
      automation: 'Atum がほかのアプリで作業できるようにします。',
      files: '選んだファイルやフォルダを Atum が開けるようにします。',
      fullDisk: '各ソースをオンにした後、Atum がメッセージと Safari の履歴を読めるようにします。',
      location: '依頼に必要な場合だけ、Atum が正確な位置情報を使えるようにします。'
    }
  },
  zh: {
    title: 'Mac 权限',
    allowed: '已允许',
    allow: '允许…',
    restricted: '受 macOS 限制',
    footnote: '更改后可能需要重新打开 Atum。',
    unavailable: '此版本的 Atum 无法显示这些权限。请在系统设置 › 隐私与安全性中查看。',
    unsupported: '这些权限仅在 Mac 上可用。',
    statusFailed: '暂时无法检查这些权限。',
    retry: '重试',
    openFailed: '无法打开系统设置。请打开系统设置 › 隐私与安全性。',
    names: {
      accessibility: '辅助功能',
      screen: '屏幕录制',
      microphone: '麦克风',
      automation: '自动化',
      files: '文件与文件夹',
      fullDisk: '信息与 Safari',
      location: '位置'
    },
    purposes: {
      screen: '让 Atum 在你需要时查看屏幕。',
      accessibility: '让 Atum 在你需要时替你点击和输入。',
      microphone: '让你可以和 Atum 说话。',
      automation: '让 Atum 在你的其他应用中工作。',
      files: '让 Atum 打开你选择的文件和文件夹。',
      fullDisk: '在你开启相应来源后，让 Atum 读取信息与 Safari 历史记录。',
      location: '仅在你的请求需要时，让 Atum 使用精确位置。'
    }
  },
  'zh-hant': {
    title: 'Mac 權限',
    allowed: '已允許',
    allow: '允許…',
    restricted: '受 macOS 限制',
    footnote: '變更後可能需要重新開啟 Atum。',
    unavailable: '此版本的 Atum 無法顯示這些權限。請在系統設定 › 隱私權與安全性中查看。',
    unsupported: '這些權限只在 Mac 上可用。',
    statusFailed: '暫時無法檢查這些權限。',
    retry: '再試一次',
    openFailed: '無法開啟系統設定。請開啟系統設定 › 隱私權與安全性。',
    names: {
      accessibility: '輔助使用',
      screen: '螢幕錄製',
      microphone: '麥克風',
      automation: '自動化',
      files: '檔案與檔案夾',
      fullDisk: '訊息與 Safari',
      location: '位置'
    },
    purposes: {
      screen: '讓 Atum 在你需要時查看螢幕。',
      accessibility: '讓 Atum 在你需要時替你點按和輸入。',
      microphone: '讓你可以和 Atum 說話。',
      automation: '讓 Atum 在你的其他應用程式中工作。',
      files: '讓 Atum 開啟你選擇的檔案和檔案夾。',
      fullDisk: '在你開啟相應來源後，讓 Atum 讀取訊息與 Safari 瀏覽記錄。',
      location: '僅在你的要求需要時，讓 Atum 使用精確位置。'
    }
  }
}

function statusFor(snapshot: MatrixPermissionsSnapshot, permission: MatrixPermission): MatrixPermissionStatus {
  const value = snapshot.permissions?.[permission]

  return value === 'granted' ||
    value === 'not-granted' ||
    value === 'not-determined' ||
    value === 'denied' ||
    value === 'restricted' ||
    value === 'manual-check'
    ? value
    : 'unknown'
}

/**
 * Mac permissions as one quiet list: each access, one line on what it lets Atum do, and on
 * the right either "✓ Allowed" or "Allow…", which opens the matching System Settings pane
 * (it never requests or claims a grant itself). The list checks again by itself when the
 * window comes back into focus, as after a visit to System Settings.
 */
export function MatrixPermissionsSettings({
  active,
  bridge = window.atumMatrix?.permissions
}: MatrixPermissionsSettingsProps) {
  const { locale } = useI18n()
  const text = copy[locale]
  const [snapshot, setSnapshot] = useState<MatrixPermissionsSnapshot | null>(null)
  const [state, setState] = useState<'error' | 'idle' | 'loading' | 'ready' | 'unavailable' | 'unsupported'>('idle')
  const [opening, setOpening] = useState<MatrixPermission | null>(null)
  const [openFailed, setOpenFailed] = useState(false)
  const request = useRef(0)
  const lifetime = useRef(0)
  const mounted = useRef(false)
  const openingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!active || !bridge) {
      return
    }

    const started = ++request.current
    const currentLifetime = lifetime.current
    // A re-check keeps the list on screen; only the first read has nothing to show yet.
    setState(previous => (previous === 'ready' ? previous : 'loading'))
    setOpenFailed(false)

    try {
      const next = await bridge.status()

      if (request.current !== started || lifetime.current !== currentLifetime || !mounted.current || !active) {
        return
      }

      setSnapshot(next)
      setState(next.platform === 'macos' ? 'ready' : 'unsupported')
    } catch {
      if (request.current === started && lifetime.current === currentLifetime && mounted.current && active) {
        setSnapshot(null)
        setState('error')
      }
    }
  }, [active, bridge])

  useEffect(() => {
    lifetime.current++
    request.current++
    mounted.current = active
    setSnapshot(null)
    setOpening(null)
    openingRef.current = false
    setOpenFailed(false)

    if (!active) {
      setState('idle')

      return
    }

    if (!bridge) {
      setState('unavailable')

      return
    }

    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const stopWatching = bridge.watch?.(next => {
      if (mounted.current && active) {
        setSnapshot(next)
        setState(next.platform === 'macos' ? 'ready' : 'unsupported')
      }
    })

    return () => {
      mounted.current = false

      window.removeEventListener('focus', onFocus)
      stopWatching?.()
    }
  }, [active, bridge, refresh])

  const open = useCallback(
    async (permission: MatrixPermission) => {
      if (!active || !bridge || openingRef.current) {
        return
      }

      const currentLifetime = lifetime.current
      openingRef.current = true
      setOpening(permission)
      setOpenFailed(false)

      try {
        await bridge.openSettings(permission)
      } catch {
        if (lifetime.current === currentLifetime && mounted.current && active) {
          setOpenFailed(true)
        }
      } finally {
        if (lifetime.current === currentLifetime && mounted.current && active) {
          openingRef.current = false
          setOpening(null)
        }
      }
    },
    [active, bridge]
  )

  if (!active) {
    return null
  }

  const unavailable = state === 'unavailable' ? text.unavailable : state === 'unsupported' ? text.unsupported : null
  const rows = state === 'ready' && snapshot !== null

  return (
    <SettingsSection
      data-matrix-permissions-settings
      foot={
        openFailed ? (
          <span role="status">{text.openFailed}</span>
        ) : rows ? (
          text.footnote
        ) : undefined
      }
      group={{ 'data-matrix-permissions-list': '' }}
      title={text.title}
    >
      {unavailable && <SettingsRow className="atum-settings-row-quiet" role="status" title={unavailable} />}
      {state === 'error' && (
        <SettingsRow
          className="atum-settings-row-quiet"
          control={
            <Button onClick={() => void refresh()} size="sm" variant="secondary">
              {text.retry}
            </Button>
          }
          role="status"
          title={text.statusFailed}
        />
      )}
      {(state === 'loading' || state === 'idle') && <div aria-hidden className="atum-settings-row" />}
      {rows &&
        permissionKeys.map(permission => {
          const status = statusFor(snapshot, permission)

          return (
            <SettingsRow
              control={
                status === 'granted' ? (
                  <SettingsStatus data-matrix-permission-status="granted" done role="status">
                    {text.allowed}
                  </SettingsStatus>
                ) : status === 'restricted' ? (
                  <SettingsStatus data-matrix-permission-status="restricted" role="status">
                    {text.restricted}
                  </SettingsStatus>
                ) : (
                  <Button
                    aria-label={`${text.allow.replace('…', '')} ${text.names[permission]}`}
                    data-matrix-permission-status={status}
                    disabled={opening !== null}
                    onClick={() => void open(permission)}
                    size="sm"
                    variant="secondary"
                  >
                    {text.allow}
                  </Button>
                )
              }
              data-matrix-permission={permission}
              help={text.purposes[permission]}
              key={permission}
              title={text.names[permission]}
            />
          )
        })}
    </SettingsSection>
  )
}
