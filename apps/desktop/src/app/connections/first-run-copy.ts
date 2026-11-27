import type { Locale } from '@/i18n'

import type { FirstRunProvider } from '../../../shared/first-run-pick'

/**
 * The first chat's Connections block and Settings › Connections' automatic switch. English and Vietnamese are the owner's binding
 * copy (evidence/mockups-1127-r2/COPY.md §c, §d); Japanese and both Chinese scripts follow them line for line. Every fixed line
 * stays under 60 characters. A provider's name is the maker's product name in every language.
 */
export const FIRST_RUN_PROVIDER_NAMES: Record<FirstRunProvider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  antigravity: 'Antigravity',
  opencode: 'OpenCode'
}

export interface FirstRunConnectionsWords {
  /** The block's label column, and the Settings dialog's title. */
  header: string
  ready: string
  connect: string
  /** A free plan's sub-line under a Ready row. */
  freeLine(plan: string): string
  /** While the provider's own sign-in is open. */
  finishInBrowser: string
  /** The row's brief transition after a Connect. */
  connected: string
  autoTitle: string
  autoLine: string
  stopUsing: string
  /** The plan in use, in Settings. */
  inUse(plan: string): string
  /** The quiet bubble while the assistant writes its first greeting (screen readers). */
  greetingWriting(name: string): string
}

const en: FirstRunConnectionsWords = {
  header: 'Connections',
  ready: 'Ready',
  connect: 'Connect',
  freeLine: plan => `${plan} · used for small tasks`,
  finishInBrowser: 'Finish in your browser',
  connected: 'Connected',
  autoTitle: 'Pick the best plan automatically',
  autoLine: 'For all your assistants, chats and schedules',
  stopUsing: 'Stop using',
  inUse: plan => `${plan} · your assistants use it`,
  greetingWriting: name => `${name} is writing…`
}

const vi: FirstRunConnectionsWords = {
  header: 'Kết nối',
  ready: 'Sẵn sàng',
  connect: 'Kết nối',
  freeLine: plan => `${plan} · dùng cho việc nhỏ`,
  finishInBrowser: 'Hoàn tất trên trình duyệt',
  connected: 'Đã kết nối',
  autoTitle: 'Tự động chọn gói phù hợp nhất',
  autoLine: 'Áp dụng cho mọi trợ lý, trò chuyện và tác vụ',
  stopUsing: 'Ngừng dùng',
  inUse: plan => `${plan} · trợ lý đang sử dụng`,
  greetingWriting: name => `${name} đang viết…`
}

const ja: FirstRunConnectionsWords = {
  header: '接続',
  ready: '準備完了',
  connect: '接続',
  freeLine: plan => `${plan}・小さな作業に使用`,
  finishInBrowser: 'ブラウザで完了してください',
  connected: '接続しました',
  autoTitle: '最適なプランを自動で選ぶ',
  autoLine: 'すべてのアシスタント、チャット、スケジュールに適用',
  stopUsing: '使用をやめる',
  inUse: plan => `${plan}・アシスタントが使用中`,
  greetingWriting: name => `${name}が入力中…`
}

const zh: FirstRunConnectionsWords = {
  header: '连接',
  ready: '已就绪',
  connect: '连接',
  freeLine: plan => `${plan} · 用于小任务`,
  finishInBrowser: '请在浏览器中完成',
  connected: '已连接',
  autoTitle: '自动选择最合适的方案',
  autoLine: '适用于所有助理、聊天和定时任务',
  stopUsing: '停止使用',
  inUse: plan => `${plan} · 你的助理正在使用`,
  greetingWriting: name => `${name} 正在输入…`
}

const zhHant: FirstRunConnectionsWords = {
  header: '連線',
  ready: '已就緒',
  connect: '連線',
  freeLine: plan => `${plan} · 用於小任務`,
  finishInBrowser: '請在瀏覽器中完成',
  connected: '已連線',
  autoTitle: '自動選擇最合適的方案',
  autoLine: '適用於所有助理、聊天和排程',
  stopUsing: '停止使用',
  inUse: plan => `${plan} · 你的助理正在使用`,
  greetingWriting: name => `${name} 正在輸入…`
}

export const FIRST_RUN_CONNECTIONS_COPY: Record<Locale, FirstRunConnectionsWords> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function firstRunConnectionsCopy(locale: Locale): FirstRunConnectionsWords {
  return FIRST_RUN_CONNECTIONS_COPY[locale] ?? en
}
