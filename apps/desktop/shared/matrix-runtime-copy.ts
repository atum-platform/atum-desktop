import type { MatrixRuntimeConfirmation } from './matrix-runtime-settings'

const words = {
  en: {
    title: 'Change this agent’s settings?',
    apply: 'Apply',
    cancel: 'Cancel',
    local: 'On this Mac',
    model: 'Model for new sessions',
    memory: 'Memory provider',
    builtin: 'Built-in memory',
    help: 'Changing the provider does not delete existing memories or restart a running conversation.'
  },
  vi: {
    title: 'Thay đổi cài đặt trợ lý này?',
    apply: 'Áp dụng',
    cancel: 'Hủy',
    local: 'Trên máy Mac này',
    model: 'Mô hình cho phiên mới',
    memory: 'Nhà cung cấp bộ nhớ',
    builtin: 'Bộ nhớ tích hợp',
    help: 'Đổi nhà cung cấp không xóa bộ nhớ hiện có và không khởi động lại cuộc trò chuyện đang chạy.'
  },
  ja: {
    title: 'このエージェントの設定を変更しますか？',
    apply: '適用',
    cancel: 'キャンセル',
    local: 'この Mac',
    model: '新しいセッションのモデル',
    memory: 'メモリプロバイダー',
    builtin: '内蔵メモリ',
    help: '変更しても既存の記憶は削除されず、実行中の会話は再起動されません。'
  },
  zh: {
    title: '更改此智能体的设置？',
    apply: '应用',
    cancel: '取消',
    local: '此 Mac',
    model: '新会话的模型',
    memory: '记忆服务',
    builtin: '内置记忆',
    help: '更改服务不会删除现有记忆，也不会重启正在运行的对话。'
  },
  'zh-hant': {
    title: '變更此智慧代理的設定？',
    apply: '套用',
    cancel: '取消',
    local: '此 Mac',
    model: '新會話的模型',
    memory: '記憶服務',
    builtin: '內建記憶',
    help: '變更服務不會刪除現有記憶，也不會重新啟動正在執行的對話。'
  }
}

export function matrixRuntimeConfirmationCopy(locale: string, agent: string, request: MatrixRuntimeConfirmation) {
  const c = words[locale as keyof typeof words] ?? words.en
  const detail =
    request.kind === 'expensive-model'
      ? `${c.model}: ${request.provider} / ${request.model}\n\n${request.message}`
      : `${c.memory}: ${request.provider || c.builtin}\n\n${c.help}`
  return { title: c.title, apply: c.apply, cancel: c.cancel, detail: `${agent} · ${c.local}\n\n${detail}` }
}
