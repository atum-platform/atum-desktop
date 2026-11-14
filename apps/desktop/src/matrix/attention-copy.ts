import { type Locale, useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixAgentAttention, type MatrixAttentionKind } from './agent-attention'

/**
 * The title bar's indicator and the quiet words around it (agent-attention.ts). Short, plain,
 * the action itself; never the protocol's or the runtime's names.
 */
export interface AttentionCopy {
  /** The title bar's bell, and its popover's heading. */
  notifications: string
  /** The bell's popover while nothing needs the person. */
  nothing: string
  /** More than one item: how many. */
  count: (n: number) => string
  items: Record<Exclude<MatrixAttentionKind, 'agent' | 'plan_sign_in' | 'device_unverified' | 'new_sign_in'>, string>
  /** One agent needs the person (its chat says what). */
  agent: (name: string) => string
  /** One agent answers with the person's ChatGPT plan, whose sign-in has ended. */
  planSignIn: (name: string) => string
  /** One of the person's own devices isn't verified, by its own name when it has one. */
  device: (name?: string) => string
  /** Why it matters, in one sentence. */
  deviceHelp: string
  /** Opens the devices list at that device, where Verify is. */
  deviceVerify: string
  deviceNotMe: string
  deviceManageFailed: string
  deviceCompareHelp: string
  /** Puts the reminder off until tomorrow. */
  notNow: string
  /** Before the label, for assistive tech: the indicator is a request, not a status. */
  a11yPrefix: string
  snooze: string
  /** A verification the person did, after it ends. */
  verified: string
  close: string
  /** The message box while its assistant cannot answer yet. */
  composerStarting: (name: string) => string
  composerUnlock: (name: string) => string
  composerSignIn: string
  composerProtons: string
}

const copies: Record<Locale, AttentionCopy> = {
  en: {
    notifications: 'Notifications',
    nothing: 'Nothing needs you right now',
    count: n => `${n} things need you`,
    items: {
      approval: 'Confirm new device',
      device_damaged: 'Sign in again on this Mac',
      disk_critical: 'Mac is out of space',
      recovery: 'Unlock this Mac',
      sign_in: 'Sign in again',
      protons: 'Out of Protons',
      runtime: 'Update Atum',
      connect: 'Connect your Atum account',
      disk_low: 'Mac almost full'
    },
    agent: name => `${name} needs you`,
    planSignIn: name => `${name}: connect ChatGPT`,
    device: name => (name ? `Your ${name} isn’t verified yet` : 'One of your devices isn’t verified yet'),
    deviceHelp: 'Your assistants won’t answer messages sent from it until you verify it.',
    deviceVerify: 'Verify',
    deviceNotMe: 'Not me',
    deviceManageFailed: 'Couldn’t open the sign-out page. Try again.',
    deviceCompareHelp: 'Continue only if this device shows the same symbols as this Mac.',
    notNow: 'Not now',
    a11yPrefix: 'Needs you:',
    snooze: 'Remind me later',
    verified: 'Verified',
    close: 'Close',
    composerStarting: name => `${name} is starting… You can type ahead.`,
    composerUnlock: name => `Unlock this Mac to chat with ${name}.`,
    composerSignIn: 'Sign in again to continue.',
    composerProtons: 'Top up Protons to continue.'
  },
  vi: {
    notifications: 'Thông báo',
    nothing: 'Hiện không có gì cần bạn',
    count: n => `${n} việc cần bạn`,
    items: {
      approval: 'Xác nhận máy mới',
      device_damaged: 'Đăng nhập lại trên Mac này',
      disk_critical: 'Mac gần hết dung lượng',
      recovery: 'Mở khóa Mac này',
      sign_in: 'Đăng nhập lại',
      protons: 'Hết Proton',
      runtime: 'Cập nhật Atum',
      connect: 'Kết nối tài khoản Atum',
      disk_low: 'Mac sắp đầy'
    },
    agent: name => `${name} cần bạn`,
    planSignIn: name => `${name}: kết nối ChatGPT`,
    device: name => (name ? `${name} của bạn chưa được xác minh` : 'Một thiết bị của bạn chưa được xác minh'),
    deviceHelp: 'Trợ lý sẽ chưa trả lời tin nhắn gửi từ thiết bị này cho đến khi bạn xác minh nó.',
    deviceVerify: 'Xác minh',
    deviceNotMe: 'Không phải tôi',
    deviceManageFailed: 'Chưa mở được trang đăng xuất thiết bị. Hãy thử lại.',
    deviceCompareHelp: 'Chỉ tiếp tục nếu thiết bị này hiển thị các ký hiệu giống hệt trên Mac này.',
    notNow: 'Để sau',
    a11yPrefix: 'Cần bạn:',
    snooze: 'Nhắc lại sau',
    verified: 'Đã xác minh',
    close: 'Đóng',
    composerStarting: name => `${name} đang khởi động… Bạn có thể soạn trước.`,
    composerUnlock: name => `Mở khóa Mac này để trò chuyện với ${name}.`,
    composerSignIn: 'Đăng nhập lại để tiếp tục.',
    composerProtons: 'Nạp Proton để tiếp tục.'
  },
  ja: {
    notifications: '通知',
    nothing: 'いま対応が必要なものはありません',
    count: n => `${n} 件の対応が必要です`,
    items: {
      approval: '新しいデバイスを確認',
      device_damaged: 'この Mac でもう一度サインイン',
      disk_critical: 'Mac の空き容量がありません',
      recovery: 'この Mac のロックを解除',
      sign_in: 'もう一度サインイン',
      protons: 'Proton が不足しています',
      runtime: 'Atum をアップデート',
      connect: 'Atum アカウントに接続',
      disk_low: 'Mac の空き容量が少なくなっています'
    },
    agent: name => `${name} の対応が必要です`,
    planSignIn: name => `${name}: ChatGPT に接続`,
    device: name => (name ? `${name} はまだ検証されていません` : 'まだ検証されていない端末があります'),
    deviceHelp: '検証するまで、アシスタントはこの端末から送られたメッセージに応答しません。',
    deviceVerify: '検証',
    deviceNotMe: '心当たりがない',
    deviceManageFailed: 'ログアウトのページを開けませんでした。もう一度お試しください。',
    deviceCompareHelp: 'この端末に、この Mac と同じ記号が表示されている場合にのみ続行してください。',
    notNow: '今はしない',
    a11yPrefix: '対応が必要:',
    snooze: 'あとで通知',
    verified: '確認済み',
    close: '閉じる',
    composerStarting: name => `${name} を起動しています… 先に入力できます。`,
    composerUnlock: name => `${name} とチャットするには、この Mac のロックを解除してください。`,
    composerSignIn: '続けるには、もう一度サインインしてください。',
    composerProtons: '続けるには、Proton をチャージしてください。'
  },
  zh: {
    notifications: '通知',
    nothing: '目前没有需要你处理的事项',
    count: n => `${n} 项需要你处理`,
    items: {
      approval: '确认新设备',
      device_damaged: '在这台 Mac 上重新登录',
      disk_critical: 'Mac 空间不足',
      recovery: '解锁这台 Mac',
      sign_in: '重新登录',
      protons: 'Proton 已用完',
      runtime: '更新 Atum',
      connect: '连接你的 Atum 账户',
      disk_low: 'Mac 空间快满了'
    },
    agent: name => `${name} 需要你处理`,
    planSignIn: name => `${name}：连接 ChatGPT`,
    device: name => (name ? `你的 ${name} 尚未验证` : '你有一台设备尚未验证'),
    deviceHelp: '在你验证之前，助手不会回复从这台设备发送的消息。',
    deviceVerify: '验证',
    deviceNotMe: '不是我',
    deviceManageFailed: '无法打开退出登录页面。请重试。',
    deviceCompareHelp: '仅当这台设备显示的符号与这台 Mac 完全相同时才继续。',
    notNow: '暂不',
    a11yPrefix: '需要你处理：',
    snooze: '稍后提醒',
    verified: '已验证',
    close: '关闭',
    composerStarting: name => `${name} 正在启动… 你可以先输入。`,
    composerUnlock: name => `解锁这台 Mac 后即可与 ${name} 聊天。`,
    composerSignIn: '重新登录以继续。',
    composerProtons: '充值 Proton 以继续。'
  },
  'zh-hant': {
    notifications: '通知',
    nothing: '目前沒有需要你處理的事項',
    count: n => `${n} 項需要你處理`,
    items: {
      approval: '確認新裝置',
      device_damaged: '在這台 Mac 上重新登入',
      disk_critical: 'Mac 空間不足',
      recovery: '解鎖這台 Mac',
      sign_in: '重新登入',
      protons: 'Proton 已用完',
      runtime: '更新 Atum',
      connect: '連接你的 Atum 帳號',
      disk_low: 'Mac 空間快滿了'
    },
    agent: name => `${name} 需要你處理`,
    planSignIn: name => `${name}：連接 ChatGPT`,
    device: name => (name ? `你的 ${name} 尚未驗證` : '你有一台裝置尚未驗證'),
    deviceHelp: '在你驗證之前，助理不會回覆從這台裝置傳送的訊息。',
    deviceVerify: '驗證',
    deviceNotMe: '不是我',
    deviceManageFailed: '無法開啟登出頁面。請重試。',
    deviceCompareHelp: '僅當這台裝置顯示的符號與這台 Mac 完全相同時才繼續。',
    notNow: '暫不',
    a11yPrefix: '需要你處理：',
    snooze: '稍後提醒',
    verified: '已驗證',
    close: '關閉',
    composerStarting: name => `${name} 正在啟動… 你可以先輸入。`,
    composerUnlock: name => `解鎖這台 Mac 後即可與 ${name} 聊天。`,
    composerSignIn: '重新登入以繼續。',
    composerProtons: '儲值 Proton 以繼續。'
  }
}

export function matrixAttentionCopy(locale: Locale): AttentionCopy {
  return copies[locale]
}

export function useAttentionCopy(): AttentionCopy {
  return matrixAttentionCopy(useI18n().locale)
}

/**
 * The message box's words while its assistant cannot answer yet: starting, or waiting on a cause
 * the indicator holds (this Mac's unlock, a sign-in, Protons, an update, a connection). Its chat
 * stays free of a band.
 */
export function matrixComposerHint(
  snapshot: Pick<MatrixSnapshot, 'readiness' | 'assistantSetup'>,
  name: string,
  copy: AttentionCopy,
  now = Date.now()
): string | undefined {
  if (snapshot.readiness?.phase === 'starting') {
    return copy.composerStarting(name)
  }

  const waits = matrixAgentAttention(
    { readiness: snapshot.readiness, setup: snapshot.assistantSetup, listening: undefined },
    now
  ).waitsOn

  // Any other shared cause by the indicator's own words: its chat has no card for it.
  return waits === 'recovery'
    ? copy.composerUnlock(name)
    : waits === 'sign_in'
      ? copy.composerSignIn
      : waits === 'protons'
        ? copy.composerProtons
        : waits &&
            waits !== 'agent' &&
            waits !== 'plan_sign_in' &&
            waits !== 'device_unverified' &&
            waits !== 'new_sign_in'
          ? copy.items[waits]
          : undefined
}
