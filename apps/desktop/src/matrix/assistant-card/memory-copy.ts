import { type Locale, useI18n } from '@/i18n'

import type { AgentMemoryCoverage, AgentMemorySourceKind } from '../../../shared/agent-memory'

/** An assistant's memory, on its card. Short, plain words; no IDs, codes or system names. */
export interface AgentMemoryCopy {
  row: string
  on: string
  off: string
  remembers: string
  onHelp(name: string): string
  offHelp(name: string): string
  changeFailed: string
  partial: string
  offline: string
  retry: string
  loading: string
  empty: string
  more: string
  forgetAll: string
  forgetAllConfirm(source: string): string
  forget: string
  correct: string
  cancel: string
  save: string
  actions: string
  open: string
  openFailed: string
  forgetting: string
  forgetFailed: string
  correcting: string
  correctFailed: string
  changedElsewhere: string
  /** Forgotten, still being cleared: no longer used in answers. */
  hidden: string
  cleaned: string
  backupUntil(date: string): string
  forgotten: string
  forgottenFact(source: string): string
  forgottenSource(source: string): string
  coverage: Record<Exclude<AgentMemoryCoverage, 'complete'>, string>
  sourceKinds: Record<AgentMemorySourceKind, string>
}

const en: AgentMemoryCopy = {
  row: 'Memory',
  on: 'On',
  off: 'Off',
  remembers: 'Remembers',
  onHelp: name => `${name} learns from your chats.`,
  offHelp: name => `Paused. ${name} won't learn or use memories.`,
  changeFailed: "Couldn't change this. Try again.",
  partial: 'Some chats can’t be read yet, so this list may be incomplete.',
  offline: 'Can’t reach memory right now.',
  retry: 'Retry',
  loading: 'Loading…',
  empty: 'Nothing remembered yet.',
  more: 'Showing the most recent.',
  forgetAll: 'Forget all',
  forgetAllConfirm: source => `Forget everything from ${source}?`,
  forget: 'Forget',
  correct: 'Correct',
  cancel: 'Cancel',
  save: 'Save',
  actions: 'More',
  open: 'Open',
  openFailed: 'This can’t be opened now.',
  forgetting: 'Forgetting…',
  forgetFailed: 'Couldn’t forget yet.',
  correcting: 'Saving correction…',
  correctFailed: 'Couldn’t save yet.',
  changedElsewhere: 'This changed on another device.',
  hidden: 'No longer used · clearing copies',
  cleaned: 'Cleared',
  backupUntil: date => `Backups clear by ${date}`,
  forgotten: 'Forgotten',
  forgottenFact: source => `A memory from ${source}`,
  forgottenSource: source => `Everything from ${source}`,
  coverage: { catching_up: 'Catching up', partial: 'Partly read', unavailable: 'Can’t read now' },
  sourceKinds: {
    assistant_chat: 'your chat',
    human_dm: 'a chat',
    human_group: 'a group',
    app_exchange: 'an app',
    drive_file: 'a file',
    owner_statement: 'you'
  }
}

const vi: AgentMemoryCopy = {
  row: 'Trí nhớ',
  on: 'Bật',
  off: 'Tắt',
  remembers: 'Ghi nhớ',
  onHelp: name => `${name} học từ các cuộc trò chuyện của bạn.`,
  offHelp: name => `Đã tạm dừng. ${name} không học và không dùng trí nhớ.`,
  changeFailed: 'Chưa đổi được. Thử lại nhé.',
  partial: 'Một số cuộc trò chuyện chưa đọc được, nên danh sách có thể chưa đủ.',
  offline: 'Chưa kết nối được tới trí nhớ.',
  retry: 'Thử lại',
  loading: 'Đang tải…',
  empty: 'Chưa ghi nhớ gì.',
  more: 'Đang hiện những điều gần nhất.',
  forgetAll: 'Quên hết',
  forgetAllConfirm: source => `Quên mọi điều từ ${source}?`,
  forget: 'Quên',
  correct: 'Sửa',
  cancel: 'Huỷ',
  save: 'Lưu',
  actions: 'Thêm',
  open: 'Mở',
  openFailed: 'Hiện chưa mở được.',
  forgetting: 'Đang quên…',
  forgetFailed: 'Chưa quên được.',
  correcting: 'Đang lưu chỗ sửa…',
  correctFailed: 'Chưa lưu được.',
  changedElsewhere: 'Mục này vừa đổi trên thiết bị khác.',
  hidden: 'Không còn dùng · đang xoá bản sao',
  cleaned: 'Đã xoá',
  backupUntil: date => `Bản sao lưu hết hạn trước ${date}`,
  forgotten: 'Đã quên',
  forgottenFact: source => `Một điều từ ${source}`,
  forgottenSource: source => `Mọi điều từ ${source}`,
  coverage: { catching_up: 'Đang đọc tiếp', partial: 'Mới đọc một phần', unavailable: 'Chưa đọc được' },
  sourceKinds: {
    assistant_chat: 'cuộc trò chuyện của bạn',
    human_dm: 'một cuộc trò chuyện',
    human_group: 'một nhóm',
    app_exchange: 'một ứng dụng',
    drive_file: 'một tệp',
    owner_statement: 'bạn'
  }
}

const ja: AgentMemoryCopy = {
  row: 'メモリー',
  on: 'オン',
  off: 'オフ',
  remembers: '覚える',
  onHelp: name => `${name}はあなたとのチャットから学びます。`,
  offHelp: name => `一時停止中。${name}は学ばず、メモリーも使いません。`,
  changeFailed: '変更できませんでした。もう一度お試しください。',
  partial: 'まだ読めないチャットがあるため、一覧は一部かもしれません。',
  offline: '今はメモリーに接続できません。',
  retry: '再試行',
  loading: '読み込み中…',
  empty: 'まだ何も覚えていません。',
  more: '最近のものを表示しています。',
  forgetAll: 'すべて忘れる',
  forgetAllConfirm: source => `${source}からの内容をすべて忘れますか？`,
  forget: '忘れる',
  correct: '修正',
  cancel: 'キャンセル',
  save: '保存',
  actions: 'その他',
  open: '開く',
  openFailed: '今は開けません。',
  forgetting: '忘れています…',
  forgetFailed: 'まだ忘れられませんでした。',
  correcting: '修正を保存中…',
  correctFailed: 'まだ保存できませんでした。',
  changedElsewhere: 'ほかのデバイスで変更されました。',
  hidden: '使われなくなりました · コピーを削除中',
  cleaned: '削除済み',
  backupUntil: date => `バックアップは${date}までに消えます`,
  forgotten: '忘れたもの',
  forgottenFact: source => `${source}からの1件`,
  forgottenSource: source => `${source}からのすべて`,
  coverage: { catching_up: '読み込み中', partial: '一部のみ', unavailable: '今は読めません' },
  sourceKinds: {
    assistant_chat: 'あなたのチャット',
    human_dm: 'チャット',
    human_group: 'グループ',
    app_exchange: 'アプリ',
    drive_file: 'ファイル',
    owner_statement: 'あなた'
  }
}

const zh: AgentMemoryCopy = {
  row: '记忆',
  on: '开',
  off: '关',
  remembers: '记住',
  onHelp: name => `${name} 会从你们的聊天中学习。`,
  offHelp: name => `已暂停。${name} 不会学习，也不会使用记忆。`,
  changeFailed: '没能更改，请再试一次。',
  partial: '有些聊天还读不到，所以列表可能不完整。',
  offline: '暂时连不上记忆。',
  retry: '重试',
  loading: '正在加载…',
  empty: '还没有记住任何内容。',
  more: '显示的是最近的内容。',
  forgetAll: '全部忘记',
  forgetAllConfirm: source => `忘记来自${source}的所有内容？`,
  forget: '忘记',
  correct: '更正',
  cancel: '取消',
  save: '保存',
  actions: '更多',
  open: '打开',
  openFailed: '现在打不开。',
  forgetting: '正在忘记…',
  forgetFailed: '还没能忘记。',
  correcting: '正在保存更正…',
  correctFailed: '还没能保存。',
  changedElsewhere: '这项刚在另一台设备上更改。',
  hidden: '不再使用 · 正在清除副本',
  cleaned: '已清除',
  backupUntil: date => `备份将在 ${date} 前清除`,
  forgotten: '已忘记',
  forgottenFact: source => `来自${source}的一条`,
  forgottenSource: source => `来自${source}的全部`,
  coverage: { catching_up: '正在补读', partial: '只读了一部分', unavailable: '现在读不到' },
  sourceKinds: {
    assistant_chat: '你的聊天',
    human_dm: '一个聊天',
    human_group: '一个群组',
    app_exchange: '一个应用',
    drive_file: '一个文件',
    owner_statement: '你'
  }
}

const zhHant: AgentMemoryCopy = {
  row: '記憶',
  on: '開',
  off: '關',
  remembers: '記住',
  onHelp: name => `${name} 會從你們的聊天中學習。`,
  offHelp: name => `已暫停。${name} 不會學習，也不會使用記憶。`,
  changeFailed: '沒能變更，請再試一次。',
  partial: '有些聊天還讀不到，所以清單可能不完整。',
  offline: '暫時連不上記憶。',
  retry: '重試',
  loading: '正在載入…',
  empty: '還沒有記住任何內容。',
  more: '顯示的是最近的內容。',
  forgetAll: '全部忘記',
  forgetAllConfirm: source => `忘記來自${source}的所有內容？`,
  forget: '忘記',
  correct: '更正',
  cancel: '取消',
  save: '儲存',
  actions: '更多',
  open: '開啟',
  openFailed: '現在打不開。',
  forgetting: '正在忘記…',
  forgetFailed: '還沒能忘記。',
  correcting: '正在儲存更正…',
  correctFailed: '還沒能儲存。',
  changedElsewhere: '這項剛在另一台裝置上變更。',
  hidden: '不再使用 · 正在清除副本',
  cleaned: '已清除',
  backupUntil: date => `備份將在 ${date} 前清除`,
  forgotten: '已忘記',
  forgottenFact: source => `來自${source}的一則`,
  forgottenSource: source => `來自${source}的全部`,
  coverage: { catching_up: '正在補讀', partial: '只讀了一部分', unavailable: '現在讀不到' },
  sourceKinds: {
    assistant_chat: '你的聊天',
    human_dm: '一個聊天',
    human_group: '一個群組',
    app_exchange: '一個應用程式',
    drive_file: '一個檔案',
    owner_statement: '你'
  }
}

export const agentMemoryCopies: Record<Locale, AgentMemoryCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function useAgentMemoryCopy(): AgentMemoryCopy {
  return agentMemoryCopies[useI18n().locale]
}
