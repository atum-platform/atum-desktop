import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { RefreshCw, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixIdentity } from '../../shared/matrix'
import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionContext,
  MatrixGoogleConnectionError,
  MatrixGoogleConnectionResult,
  MatrixGoogleConnectionSource,
  MatrixGoogleConnectionStatus
} from '../../shared/matrix-google-connections'
import {
  type MatrixGoogleAssistantAccess,
  matrixGoogleConnectOffered,
  matrixGoogleToolsUsable
} from '../../shared/matrix-google-tools'

import { SettingsRow, SettingsSection } from './settings-row'

interface GoogleConnectionsCopy {
  title: string
  help: string
  refresh: string
  refreshing: string
  unavailable: string
  accountConnected: string
  /** The Google account Atum is connected to (one short line; the email is the pinned account). */
  accountConnectedAs: (email: string) => string
  /** Another Google account tried to connect and was refused (one short line, no extra screen). */
  accountMismatch: string
  loadFailed: string
  actionFailed: string
  reconnect: string
  connect: string
  addAccount: string
  connecting: string
  account: (index: number) => string
  disconnect: string
  disconnectTitle: string
  disconnectDescription: string
  disconnectConfirm: string
  disconnecting: string
  notShared: (services: string) => string
  allow: string
  /** Until Google finishes reviewing Atum, people see its unverified-app screen. */
  disclosureWarning: string
  dismiss: string
  /** The assistant line (MatrixSnapshot.googleAssistant). */
  assistant: {
    ready: string
    connect: string
    route: string
    ownModel: string
    pausedRoute: string
    pausedOwnModel: string
  }
  sources: Record<MatrixGoogleConnectionSource['kind'], string>
}

const copy: Record<Locale, GoogleConnectionsCopy> = {
  en: {
    title: 'Google',
    help: 'Connections are saved on this Mac.',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    unavailable: 'Google connections are not available in this build.',
    accountConnected: 'Connected to your Atum account',
    accountConnectedAs: (email) => `Connected as ${email}`,
    accountMismatch: 'This Google account isn’t the one connected to Atum.',
    loadFailed: 'Couldn’t check Google connections. Try Refresh.',
    actionFailed: 'Couldn’t update this Google connection. Try again.',
    reconnect: 'This connection needs to be connected again.',
    connect: 'Connect Google',
    addAccount: 'Add another Google account',
    connecting: 'Waiting for Google…',
    account: index => `Google account ${index}`,
    disconnect: 'Disconnect',
    disconnectTitle: 'Disconnect this Google account?',
    disconnectDescription: 'Atum stops using its Gmail, Calendar and Drive on this Mac.',
    disconnectConfirm: 'Disconnect',
    disconnecting: 'Disconnecting…',
    notShared: services => `Not shared: ${services}`,
    allow: 'Allow',
    disclosureWarning: 'If Google warns you, choose Advanced → Continue.',
    dismiss: 'Dismiss',
    assistant: {
      ready: 'Your assistant uses shared Google data with approval.',
      connect: 'Connect Google for calendar, email and files.',
      route: 'Google works when Atum’s Google AI is ready.',
      ownModel: 'Google needs Atum’s AI, not your current model.',
      pausedRoute: 'Waiting for Atum’s Google AI.',
      pausedOwnModel: 'Switch to Atum’s AI to use Google.'
    },
    sources: { email: 'Gmail', calendar: 'Calendar', drive: 'Google Drive' }
  },
  vi: {
    title: 'Google',
    help: 'Các kết nối được lưu trên máy Mac này.',
    refresh: 'Làm mới',
    refreshing: 'Đang làm mới…',
    unavailable: 'Bản Atum này chưa có kết nối Google.',
    accountConnected: 'Đã kết nối với tài khoản Atum',
    accountConnectedAs: (email) => `Đã kết nối với ${email}`,
    accountMismatch: 'Đây không phải tài khoản Google đã kết nối với Atum.',
    loadFailed: 'Không kiểm tra được kết nối Google. Hãy thử Làm mới.',
    actionFailed: 'Không cập nhật được kết nối Google này. Hãy thử lại.',
    reconnect: 'Kết nối này cần được kết nối lại.',
    connect: 'Kết nối Google',
    addAccount: 'Thêm tài khoản Google khác',
    connecting: 'Đang chờ Google…',
    account: index => `Tài khoản Google ${index}`,
    disconnect: 'Ngắt kết nối',
    disconnectTitle: 'Ngắt kết nối tài khoản Google này?',
    disconnectDescription: 'Atum ngừng dùng Gmail, Lịch và Drive của tài khoản này trên máy Mac này.',
    disconnectConfirm: 'Ngắt kết nối',
    disconnecting: 'Đang ngắt kết nối…',
    notShared: services => `Chưa chia sẻ: ${services}`,
    allow: 'Cho phép',
    disclosureWarning: 'Nếu Google cảnh báo, chọn Nâng cao → Tiếp tục.',
    dismiss: 'Đóng',
    assistant: {
      ready: 'Trợ lý dùng dữ liệu Google khi bạn đồng ý.',
      connect: 'Kết nối Google cho lịch, email và tệp.',
      route: 'Google hoạt động khi AI Google của Atum sẵn sàng.',
      ownModel: 'Google cần AI của Atum, không dùng mô hình hiện tại.',
      pausedRoute: 'Đang chờ AI Google của Atum.',
      pausedOwnModel: 'Chuyển sang AI của Atum để dùng Google.'
    },
    sources: { email: 'Gmail', calendar: 'Lịch', drive: 'Google Drive' }
  },
  zh: {
    title: 'Google',
    help: '连接保存在这台 Mac 上。',
    refresh: '刷新',
    refreshing: '正在刷新…',
    unavailable: '此版本尚未提供 Google 连接。',
    accountConnected: '已连接到你的 Atum 帐号',
    accountConnectedAs: (email) => `已连接为 ${email}`,
    accountMismatch: '这不是已连接到 Atum 的 Google 帐号。',
    loadFailed: '无法检查 Google 连接。请尝试刷新。',
    actionFailed: '无法更新此 Google 连接。请重试。',
    reconnect: '此连接需要重新连接。',
    connect: '连接 Google',
    addAccount: '添加另一个 Google 账号',
    connecting: '正在等待 Google…',
    account: index => `Google 账号 ${index}`,
    disconnect: '断开连接',
    disconnectTitle: '断开此 Google 账号？',
    disconnectDescription: 'Atum 将不再在这台 Mac 上使用此账号的 Gmail、日历和 Drive。',
    disconnectConfirm: '断开连接',
    disconnecting: '正在断开…',
    notShared: services => `未共享：${services}`,
    allow: '允许',
    disclosureWarning: '如果 Google 发出警告，请选择“高级”→“继续”。',
    dismiss: '关闭',
    assistant: {
      ready: '助手经你同意后使用 Google 数据。',
      connect: '连接 Google 日历、邮件和文件。',
      route: 'Atum 的 Google AI 就绪后即可使用。',
      ownModel: 'Google 需要 Atum AI，不支持当前模型。',
      pausedRoute: '正在等待 Atum 的 Google AI。',
      pausedOwnModel: '切换到 Atum AI 以使用 Google。'
    },
    sources: { email: 'Gmail', calendar: '日历', drive: 'Google Drive' }
  },
  'zh-hant': {
    title: 'Google',
    help: '連線會儲存在這台 Mac 上。',
    refresh: '重新整理',
    refreshing: '正在重新整理…',
    unavailable: '此版本尚未提供 Google 連線。',
    accountConnected: '已連接至你的 Atum 帳號',
    accountConnectedAs: (email) => `已連接為 ${email}`,
    accountMismatch: '這不是已連接到 Atum 的 Google 帳號。',
    loadFailed: '無法檢查 Google 連線。請嘗試重新整理。',
    actionFailed: '無法更新此 Google 連線。請再試一次。',
    reconnect: '此連線需要重新連線。',
    connect: '連接 Google',
    addAccount: '新增另一個 Google 帳號',
    connecting: '正在等待 Google…',
    account: index => `Google 帳號 ${index}`,
    disconnect: '中斷連線',
    disconnectTitle: '要中斷此 Google 帳號嗎？',
    disconnectDescription: 'Atum 將不再在這台 Mac 上使用此帳號的 Gmail、日曆和 Drive。',
    disconnectConfirm: '中斷連線',
    disconnecting: '正在中斷連線…',
    notShared: services => `未分享：${services}`,
    allow: '允許',
    disclosureWarning: '如果 Google 顯示警告，請選擇「進階」→「繼續」。',
    dismiss: '關閉',
    assistant: {
      ready: '助理經你同意後使用 Google 資料。',
      connect: '連接 Google 日曆、郵件和檔案。',
      route: 'Atum 的 Google AI 就緒後即可使用。',
      ownModel: 'Google 需要 Atum AI，不支援目前模型。',
      pausedRoute: '正在等待 Atum 的 Google AI。',
      pausedOwnModel: '切換到 Atum AI 以使用 Google。'
    },
    sources: { email: 'Gmail', calendar: '日曆', drive: 'Google Drive' }
  },
  ja: {
    title: 'Google',
    help: '接続はこの Mac に保存されます。',
    refresh: '更新',
    refreshing: '更新中…',
    unavailable: 'このビルドでは Google 接続を利用できません。',
    accountConnected: 'Atum アカウントに接続済み',
    accountConnectedAs: (email) => `${email} として接続済み`,
    accountMismatch: 'この Google アカウントは Atum に接続されているものではありません。',
    loadFailed: 'Google 接続を確認できませんでした。更新してください。',
    actionFailed: 'この Google 接続を更新できませんでした。もう一度試してください。',
    reconnect: 'この接続は再接続が必要です。',
    connect: 'Google に接続',
    addAccount: '別の Google アカウントを追加',
    connecting: 'Google を待っています…',
    account: index => `Google アカウント ${index}`,
    disconnect: '切断',
    disconnectTitle: 'この Google アカウントを切断しますか？',
    disconnectDescription: 'この Mac で Atum がこのアカウントの Gmail、カレンダー、Drive を使わなくなります。',
    disconnectConfirm: '切断',
    disconnecting: '切断中…',
    notShared: services => `共有していません：${services}`,
    allow: '許可',
    disclosureWarning: 'Google の警告が出たら、「詳細」→「続行」を選んでください。',
    dismiss: '閉じる',
    assistant: {
      ready: '承認した Google データをアシスタントが使います。',
      connect: 'Google の予定、メール、ファイルに接続します。',
      route: 'Atum の Google AI の準備を待っています。',
      ownModel: 'Google には Atum AI が必要です。',
      pausedRoute: 'Atum の Google AI を待っています。',
      pausedOwnModel: 'Google を使うには Atum AI に切り替えます。'
    },
    sources: { email: 'Gmail', calendar: 'カレンダー', drive: 'Google Drive' }
  }
}

export function matrixGoogleDisclosureWarning(locale: Locale): string {
  return copy[locale].disclosureWarning
}

/** Session-scoped: switching chats must not resurrect a chip the person dismissed. */
const dismissedNudgeScopes = new Set<string>()

export function resetMatrixGoogleNudgeDismissals(): void {
  dismissedNudgeScopes.clear()
}

type ViewState = 'error' | 'idle' | 'loading' | 'ready' | 'unavailable'
type PendingAction = 'connect:google' | `disconnect:${string}` | `source:${string}` | null

interface MatrixGoogleConnectionSettingsProps {
  identity: MatrixIdentity
  active: boolean
  bridge?: MatrixGoogleConnectionBridge
  /** Whether the default assistant can use Google (MatrixSnapshot.googleAssistant). */
  assistant?: MatrixGoogleAssistantAccess
}

type Service = 'gmail' | 'calendar' | 'drive'

const SERVICE_KIND: Record<Service, MatrixGoogleConnectionSource['kind']> = {
  gmail: 'email',
  calendar: 'calendar',
  drive: 'drive'
}

/** The account's address: its Gmail or Drive source, else its primary calendar. */
function accountLabel(sources: MatrixGoogleConnectionSource[]): string | undefined {
  return (
    sources.find(source => source.kind !== 'calendar')?.label ||
    sources.find(source => source.kind === 'calendar' && source.primary)?.label ||
    undefined
  )
}

/** The assistant line for the snapshot's state; none when the snapshot says nothing. */
function assistantLine(text: GoogleConnectionsCopy, assistant: MatrixGoogleAssistantAccess | undefined): string | null {
  switch (assistant?.state) {
    case 'ready':
      return text.assistant.ready

    case 'connect':
      return text.assistant.connect

    case 'paused':
      return assistant.reason === 'own_model' ? text.assistant.pausedOwnModel : text.assistant.pausedRoute

    case 'unavailable':
      return assistant.reason === 'own_model'
        ? text.assistant.ownModel
        : assistant.reason === 'route'
          ? text.assistant.route
          : null

    default:
      return null
  }
}

/**
 * The direct Google action and the only preparation people need for Google's unverified-app
 * screen. There is no consent card before Google's own consent screen.
 */
export function MatrixGoogleDisclosure({
  busy = false,
  className,
  label,
  onContinue
}: {
  busy?: boolean
  className?: string
  label?: string
  onContinue: () => void
}) {
  const { locale } = useI18n()
  const text = copy[locale]

  return (
    <div className={cn('flex flex-col items-start gap-1.5', className)} data-matrix-google-disclosure>
      <Button aria-busy={busy || undefined} disabled={busy} onClick={onContinue} size="sm">
        {busy ? text.connecting : (label ?? text.connect)}
      </Button>
      <p className="atum-settings-row-help" data-matrix-google-warning>
        {text.disclosureWarning}
      </p>
    </div>
  )
}

/**
 * The same compact Google chip for first run and a conversation-time offer. One click starts
 * Google's own consent flow. The unverified-app hint is a tooltip, never another line to read.
 */
export function MatrixGoogleConnectNudge({
  access,
  bridge = defaultBridge(),
  context,
  placement = 'conversation',
  scope = 'default'
}: {
  access: MatrixGoogleAssistantAccess | undefined
  bridge?: MatrixGoogleConnectionBridge
  context?: MatrixGoogleConnectionContext
  placement?: 'conversation' | 'greeting'
  scope?: string
}) {
  const { locale } = useI18n()
  const text = copy[locale]
  const live = useRef(true)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(() => dismissedNudgeScopes.has(scope))

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    setDismissed(dismissedNudgeScopes.has(scope))
  }, [scope])

  const dismiss = () => {
    dismissedNudgeScopes.add(scope)
    setDismissed(true)
  }

  if (!bridge || dismissed || !matrixGoogleConnectOffered(access)) {
    return null
  }

  const connect = () => {
    setPending(true)
    setFailed(false)
    const request = context ? bridge.connect('google', context) : bridge.connect('google')

    void request
      .then(result => {
        if (!live.current) {
          return
        }

        if (result.status?.sources.some(source => source.state === 'connected' && source.enabled)) {
          dismiss()
        } else if (result.error === 'cancelled' || result.error === 'denied') {
          dismiss()
        } else if (result.error) {
          setFailed(true)
        }
      })
      .catch(() => live.current && setFailed(true))
      .finally(() => live.current && setPending(false))
  }

  return (
    <div
      className={
        placement === 'greeting' ? 'mt-4 flex w-full flex-col items-start' : 'mx-auto mb-2 w-full max-w-[47rem] px-4'
      }
      data-matrix-google-nudge
      data-placement={placement}
    >
      <div className="inline-flex h-8 items-center overflow-hidden rounded-full border border-(--atum-line) text-(length:--atum-t-control) text-(--atum-ink-soft)">
        <Tip label={text.disclosureWarning}>
          <button
            aria-busy={pending || undefined}
            className="h-full px-3.5 transition-colors duration-150 hover:bg-(--atum-hover) hover:text-(--atum-ink) focus-visible:bg-(--atum-hover) focus-visible:text-(--atum-ink) disabled:pointer-events-none disabled:opacity-50"
            disabled={pending}
            onClick={connect}
            type="button"
          >
            {pending ? text.connecting : text.connect}
          </button>
        </Tip>
        <Tip label={text.dismiss}>
          <button
            aria-label={text.dismiss}
            className="grid h-full w-7 place-items-center border-s border-(--atum-line) transition-colors duration-150 hover:bg-(--atum-hover) hover:text-(--atum-ink) focus-visible:bg-(--atum-hover) focus-visible:text-(--atum-ink) disabled:pointer-events-none disabled:opacity-50"
            disabled={pending}
            onClick={dismiss}
            type="button"
          >
            <X aria-hidden className="size-3" />
          </button>
        </Tip>
      </div>
      {failed && (
        <NoticeBand className="mt-2" role="status" tone="failure">
          {text.actionFailed}
        </NoticeBand>
      )}
    </div>
  )
}

function defaultBridge(): MatrixGoogleConnectionBridge | undefined {
  return (
    window.atumMatrix as (typeof window.atumMatrix & { googleConnections?: MatrixGoogleConnectionBridge }) | undefined
  )?.googleConnections
}

function groupsFor(
  status: MatrixGoogleConnectionStatus
): Array<{ groupId: string; sources: MatrixGoogleConnectionSource[] }> {
  const groups = new Map<string, MatrixGoogleConnectionSource[]>()

  for (const source of status.sources) {
    const entries = groups.get(source.groupId) ?? []
    entries.push(source)
    groups.set(source.groupId, entries)
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupId, sources]) => ({
      groupId,
      // Gmail, then Calendar, then Drive, the order the consent names them.
      sources: [...sources].sort(
        (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.id.localeCompare(right.id)
      )
    }))
}

const KIND_ORDER: Record<MatrixGoogleConnectionSource['kind'], number> = { email: 0, calendar: 1, drive: 2 }

function resultError(result: MatrixGoogleConnectionResult): MatrixGoogleConnectionError | null {
  return result.error ?? null
}

/**
 * Per-Matrix-identity Google connection controls. The component never receives
 * credentials or account paths; it only renders the bridge's safe source list.
 */
export function MatrixGoogleConnectionSettings({
  identity,
  active,
  bridge = defaultBridge(),
  assistant
}: MatrixGoogleConnectionSettingsProps) {
  const { locale } = useI18n()
  const text = copy[locale]
  const identityKey = `${identity.userId}\u0000${identity.deviceId}`
  const [status, setStatus] = useState<MatrixGoogleConnectionStatus | null>(null)
  const [state, setState] = useState<ViewState>('idle')
  const [pending, setPending] = useState<PendingAction>(null)
  const [error, setError] = useState<MatrixGoogleConnectionError | null>(null)
  const [disconnectGroup, setDisconnectGroup] = useState<string | null>(null)
  const lifetime = useRef(0)
  const request = useRef(0)
  const mounted = useRef(false)
  // A failed action is not new connection truth. Keep the last successful
  // projection for this identity so a transient bridge failure cannot erase
  // controls the user needs to recover or revoke access.
  const lastGoodStatus = useRef<MatrixGoogleConnectionStatus | null>(null)

  const accepts = useCallback(
    (started: number, currentLifetime: number) =>
      mounted.current && active && request.current === started && lifetime.current === currentLifetime,
    [active]
  )

  const retainLastGoodStatus = useCallback((nextError: MatrixGoogleConnectionError) => {
    const retained = lastGoodStatus.current
    setError(nextError)

    if (retained) {
      setStatus(retained)
      setState(retained.available ? 'ready' : 'unavailable')

      return false
    }

    setStatus(null)
    setState(nextError === 'unavailable' ? 'unavailable' : 'error')

    return false
  }, [])

  const apply = useCallback(
    (result: MatrixGoogleConnectionResult, started: number, currentLifetime: number) => {
      if (!accepts(started, currentLifetime)) {
        return false
      }

      const nextError = resultError(result)

      if (!result.status) {
        return retainLastGoodStatus(nextError ?? 'network')
      }

      lastGoodStatus.current = result.status
      setStatus(result.status)
      setState(result.status.available ? 'ready' : 'unavailable')
      setError(null)

      return true
    },
    [accepts, retainLastGoodStatus]
  )

  const refresh = useCallback(async () => {
    if (!active || !bridge) {
      return
    }

    const started = ++request.current
    const currentLifetime = lifetime.current
    setState('loading')
    setError(null)

    try {
      apply(await bridge.status(), started, currentLifetime)
    } catch {
      if (accepts(started, currentLifetime)) {
        retainLastGoodStatus('network')
      }
    }
  }, [accepts, active, apply, bridge, retainLastGoodStatus])

  useEffect(() => {
    lifetime.current++
    request.current++
    mounted.current = active
    setStatus(null)
    lastGoodStatus.current = null
    setPending(null)
    setError(null)
    setDisconnectGroup(null)

    if (!active) {
      setState('idle')

      return
    }

    if (!bridge) {
      setState('unavailable')

      return
    }

    void refresh()
    const effectRequest = request.current

    return () => {
      mounted.current = false
      request.current = Math.max(request.current, effectRequest + 1)
    }
  }, [active, bridge, identityKey, refresh])

  // Platform OAuth finishes in the browser; returning to Atum reconciles the account projection.
  useEffect(() => {
    if (!active || !status?.accountState) {
      return
    }

    const focus = () => void refresh()
    window.addEventListener('focus', focus)

    return () => window.removeEventListener('focus', focus)
  }, [active, refresh, status?.accountState])

  // One consent for Gmail, Calendar and Drive; the person may untick any of them, and
  // whatever they allow is used as it is: the pane only offers the rest quietly.
  const connect = useCallback(async () => {
    if (!active || !bridge || pending !== null) {
      return
    }

    const action: PendingAction = 'connect:google'
    const started = ++request.current
    const currentLifetime = lifetime.current
    setPending(action)
    setError(null)

    try {
      apply(await bridge.connect('google'), started, currentLifetime)
    } catch {
      if (accepts(started, currentLifetime)) {
        retainLastGoodStatus('network')
      }
    } finally {
      if (accepts(started, currentLifetime)) {
        setPending(null)
      }
    }
  }, [accepts, active, apply, bridge, pending, retainLastGoodStatus])

  const setSourceEnabled = useCallback(
    async (source: MatrixGoogleConnectionSource) => {
      if (!active || !bridge || pending !== null) {
        return
      }

      const started = ++request.current
      const currentLifetime = lifetime.current
      const action: PendingAction = `source:${source.id}`
      const nextEnabled = !source.enabled
      setPending(action)
      setError(null)
      setStatus(current =>
        current
          ? {
              ...current,
              sources: current.sources.map(item => (item.id === source.id ? { ...item, enabled: nextEnabled } : item))
            }
          : current
      )

      try {
        apply(await bridge.setSourcePreferences([{ id: source.id, enabled: nextEnabled }]), started, currentLifetime)
      } catch {
        if (accepts(started, currentLifetime)) {
          retainLastGoodStatus('network')
        }
      } finally {
        if (accepts(started, currentLifetime)) {
          setPending(null)
        }
      }
    },
    [accepts, active, apply, bridge, pending, retainLastGoodStatus]
  )

  const disconnect = useCallback(async () => {
    if (!active || !bridge || !disconnectGroup || pending !== null) {
      return
    }

    const groupId = disconnectGroup
    const started = ++request.current
    const currentLifetime = lifetime.current
    const action: PendingAction = `disconnect:${groupId}`
    let completed = false
    let applied = false
    setPending(action)
    setError(null)

    try {
      const succeeded = apply(await bridge.disconnect(groupId), started, currentLifetime)
      applied = true

      if (!succeeded && accepts(started, currentLifetime)) {
        throw new Error(text.actionFailed)
      }

      completed = succeeded
    } catch {
      if (!applied && accepts(started, currentLifetime)) {
        retainLastGoodStatus('network')
      }

      // ConfirmDialog renders thrown messages. IPC implementation details are
      // neither actionable nor localized, so expose only the panel's copy.
      throw new Error(text.actionFailed)
    } finally {
      if (accepts(started, currentLifetime)) {
        setPending(null)

        if (completed) {
          setDisconnectGroup(null)
        }
      }
    }
  }, [accepts, active, apply, bridge, disconnectGroup, pending, retainLastGoodStatus, text.actionFailed])

  const groups = useMemo(() => (status ? groupsFor(status) : []), [status])
  const degraded = Boolean(status?.degraded || status?.sources.some(source => source.state === 'reconnect'))
  const loading = state === 'loading'
  const line = assistantLine(text, assistant)
  // Connecting is offered only when the assistant could use it (or the snapshot is silent):
  // connecting for an assistant that can't use Google would be a dead end.
  const offerConnect = !assistant || matrixGoogleConnectOffered(assistant) || matrixGoogleToolsUsable(assistant)

  // Google is always discoverable in Account. An unavailable build or an assistant that
  // cannot use it says why in place instead of silently removing the integration.
  if (!active) {
    return null
  }

  return (
    <>
      <SettingsSection
        action={
          // A read that failed offers Refresh in its own row; with nothing connected,
          // Connect Google is the one action.
          bridge &&
          state !== 'error' &&
          (groups.length > 0 || (status?.accountState && (status.accountState !== 'disconnected' || error)) || loading) && (
            <Tip label={loading ? text.refreshing : text.refresh}>
              <button
                aria-label={loading ? text.refreshing : text.refresh}
                className="atum-icon-btn size-6"
                data-icon-only
                disabled={loading || pending !== null}
                onClick={() => void refresh()}
                type="button"
              >
                <RefreshCw aria-hidden className={cn('size-3.5', loading && 'animate-spin')} />
              </button>
            </Tip>
          )
        }
        data-matrix-google-connections
        foot={
          error && state !== 'error' ? (
            <span role="status">{text.actionFailed}</span>
          ) : status?.accountNotice === 'google_account_mismatch' ? (
            <span role="status">{text.accountMismatch}</span>
          ) : undefined
        }
        help={offerConnect && groups.length > 0 ? (line ?? undefined) : undefined}
        tip={text.help}
        title={text.title}
      >
        {state === 'ready' && status ? (
          status.accountState === 'ready' || status.accountState === 'attention' ? (
            <SettingsRow
              className="atum-settings-row-quiet"
              role="status"
              title={
                status.accountState === 'ready'
                  ? status.accountEmail
                    ? text.accountConnectedAs(status.accountEmail)
                    : text.accountConnected
                  : text.reconnect
              }
            />
          ) : error && status.accountState ? (
            <SettingsRow className="atum-settings-row-quiet" role="status" title={text.loadFailed} />
          ) : (status.accountState === 'disconnected' || offerConnect) ? (
            <MatrixGoogleDisclosure
              busy={pending !== null}
              className="px-3.5 py-3"
              label={groups.length ? text.addAccount : text.connect}
              onContinue={() => void connect()}
            />
          ) : (
            // The assistant can't use Google now: say why, offer nothing.
            <SettingsRow className="atum-settings-row-quiet" role="status" title={line ?? text.help} />
          )
        ) : (
          <SettingsRow
            className="atum-settings-row-quiet"
            control={
              state === 'error' &&
              bridge && (
                <Button onClick={() => void refresh()} size="sm" variant="secondary">
                  {text.refresh}
                </Button>
              )
            }
            role="status"
            title={state === 'error' ? text.loadFailed : state === 'unavailable' ? text.unavailable : text.refreshing}
          />
        )}
      </SettingsSection>
      {state === 'ready' &&
        status &&
        groups.map(({ groupId, sources }, index) => {
          const name = accountLabel(sources) ?? text.account(index + 1)
          const reconnect = sources.some(source => source.state === 'reconnect')

          const missing = (Object.keys(SERVICE_KIND) as Service[]).filter(
            service => !sources.some(source => source.kind === SERVICE_KIND[service])
          )

          // One card per Google account: the account and Disconnect, then what it shares.
          return (
            <div
              className="atum-settings-group"
              data-matrix-google-group={groupId}
              data-testid="matrix-google-group"
              key={groupId}
            >
              <SettingsRow
                control={
                  <Button
                    disabled={pending !== null}
                    onClick={() => setDisconnectGroup(groupId)}
                    size="sm"
                    variant="text"
                  >
                    {text.disconnect}
                  </Button>
                }
                help={reconnect ? <span data-tone="warn">{text.reconnect}</span> : undefined}
                title={<span className="truncate font-medium">{name}</span>}
              />
              {sources.map(source => {
                const kind = text.sources[source.kind]
                // Gmail, Drive and the main calendar are the account itself (named above);
                // any other calendar shows its own name under the word Calendar.
                const ownName =
                  source.kind === 'calendar' && source.label && source.label !== name ? source.label : undefined

                return (
                  <SettingsRow
                    as="label"
                    control={
                      <Switch
                        aria-label={`${kind}: ${source.label || kind}`}
                        checked={source.enabled}
                        disabled={pending !== null}
                        onCheckedChange={() => void setSourceEnabled(source)}
                      />
                    }
                    help={ownName}
                    key={source.id}
                    title={kind}
                  />
                )
              })}
              {missing.length > 0 && offerConnect && (
                <SettingsRow
                  className="atum-settings-row-quiet"
                  control={
                    <Button disabled={pending !== null} onClick={() => void connect()} size="sm" variant="text">
                      {text.allow}
                    </Button>
                  }
                  data-matrix-google-missing
                  title={text.notShared(missing.map(service => text.sources[SERVICE_KIND[service]]).join(', '))}
                />
              )}
            </div>
          )
        })}
      {degraded && state === 'ready' && !groups.length && (
        <p className="atum-settings-section-foot" role="status">
          {text.reconnect}
        </p>
      )}
      <ConfirmDialog
        busyLabel={text.disconnecting}
        confirmLabel={text.disconnectConfirm}
        description={text.disconnectDescription}
        destructive
        onClose={() => setDisconnectGroup(null)}
        onConfirm={disconnect}
        open={disconnectGroup !== null}
        title={text.disconnectTitle}
      />
    </>
  )
}
