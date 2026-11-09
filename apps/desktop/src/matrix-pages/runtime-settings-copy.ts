import type { Locale } from '@/i18n'

export interface RuntimeSettingsCopy {
  title: string
  close: string
  scope: (agent: string) => string
  current: string
  provider: string
  model: string
  context: string
  unknown: string
  contextTokens: (count: number) => string
  mainModel: string
  modelDescription: string
  modelReadOnly: string
  noModels: string
  chooseModel: string
  memory: string
  memoryDescription: string
  activeMemory: string
  builtInMemory: string
  ready: string
  notReady: string
  chooseMemory: string
  pending: string
  cancelled: string
  applied: string
  requestError: string
  refreshError: string
  staleAux: string
  reload: string
}

export const runtimeSettingsCopy: Record<Locale, RuntimeSettingsCopy> = {
  en: {
    title: 'Runtime settings',
    close: 'Close runtime settings',
    scope: agent => `This Mac · ${agent}`,
    current: 'Current runtime',
    provider: 'Provider',
    model: 'Model',
    context: 'Context window',
    unknown: 'Unknown',
    contextTokens: count => `${count.toLocaleString()} tokens`,
    mainModel: 'Main model',
    modelDescription: 'Changes apply to new sessions only. They do not hot-swap a live session.',
    modelReadOnly: 'This provider’s current model cannot be changed here.',
    noModels: 'No selectable models are available for this provider.',
    chooseModel: 'Choose a model',
    memory: 'Memory provider',
    memoryDescription: 'Choose a ready memory provider for this selected agent. Existing memories are not deleted.',
    activeMemory: 'Current memory provider',
    builtInMemory: 'Built-in memory',
    ready: 'Ready',
    notReady: 'Not ready',
    chooseMemory: 'Choose a memory provider',
    pending: 'Saving this selected agent’s runtime setting…',
    cancelled: 'No runtime setting was changed.',
    applied: 'Runtime setting applied. Current values were refreshed from this Mac.',
    requestError: 'Could not update this runtime setting. Please try again.',
    refreshError:
      'The change may have completed, but current settings could not be refreshed. Reopen this page before trying again.',
    staleAux: 'Some related runtime settings may still need attention.',
    reload: 'Reload runtime settings'
  },
  vi: {
    title: 'Cài đặt runtime',
    close: 'Đóng cài đặt runtime',
    scope: agent => `Máy Mac này · ${agent}`,
    current: 'Runtime hiện tại',
    provider: 'Nhà cung cấp',
    model: 'Mô hình',
    context: 'Cửa sổ ngữ cảnh',
    unknown: 'Không rõ',
    contextTokens: count => `${count.toLocaleString()} token`,
    mainModel: 'Mô hình chính',
    modelDescription: 'Thay đổi chỉ áp dụng cho phiên mới. Phiên đang chạy không được đổi nóng.',
    modelReadOnly: 'Không thể đổi mô hình hiện tại của nhà cung cấp này ở đây.',
    noModels: 'Không có mô hình nào có thể chọn cho nhà cung cấp này.',
    chooseModel: 'Chọn mô hình',
    memory: 'Nhà cung cấp bộ nhớ',
    memoryDescription: 'Chọn nhà cung cấp bộ nhớ sẵn sàng cho agent đang chọn. Bộ nhớ hiện có không bị xóa.',
    activeMemory: 'Nhà cung cấp bộ nhớ hiện tại',
    builtInMemory: 'Bộ nhớ tích hợp',
    ready: 'Sẵn sàng',
    notReady: 'Chưa sẵn sàng',
    chooseMemory: 'Chọn nhà cung cấp bộ nhớ',
    pending: 'Đang lưu cài đặt runtime của agent đang chọn…',
    cancelled: 'Không có cài đặt runtime nào được thay đổi.',
    applied: 'Đã áp dụng cài đặt runtime. Giá trị hiện tại đã được làm mới từ máy Mac này.',
    requestError: 'Không thể cập nhật cài đặt runtime này. Vui lòng thử lại.',
    refreshError:
      'Thay đổi có thể đã hoàn tất nhưng không thể làm mới cài đặt hiện tại. Hãy mở lại trang trước khi thử lại.',
    staleAux: 'Một số cài đặt runtime liên quan có thể vẫn cần được chú ý.',
    reload: 'Tải lại cài đặt runtime'
  },
  ja: {
    title: 'ランタイム設定',
    close: 'ランタイム設定を閉じる',
    scope: agent => `この Mac · ${agent}`,
    current: '現在のランタイム',
    provider: 'プロバイダー',
    model: 'モデル',
    context: 'コンテキストウィンドウ',
    unknown: '不明',
    contextTokens: count => `${count.toLocaleString()} トークン`,
    mainModel: 'メインモデル',
    modelDescription: '変更は新しいセッションにのみ適用されます。進行中のセッションをホットスワップしません。',
    modelReadOnly: 'このプロバイダーの現在のモデルはここでは変更できません。',
    noModels: 'このプロバイダーで選択できるモデルはありません。',
    chooseModel: 'モデルを選択',
    memory: 'メモリプロバイダー',
    memoryDescription:
      '選択中のエージェント用に準備済みのメモリプロバイダーを選択します。既存のメモリは削除されません。',
    activeMemory: '現在のメモリプロバイダー',
    builtInMemory: '組み込みメモリ',
    ready: '準備完了',
    notReady: '未準備',
    chooseMemory: 'メモリプロバイダーを選択',
    pending: '選択中のエージェントのランタイム設定を保存しています…',
    cancelled: 'ランタイム設定は変更されませんでした。',
    applied: 'ランタイム設定を適用しました。この Mac から現在の値を更新しました。',
    requestError: 'このランタイム設定を更新できませんでした。もう一度お試しください。',
    refreshError:
      '変更は完了した可能性がありますが、現在の設定を更新できませんでした。再試行前にこのページを開き直してください。',
    staleAux: '関連するランタイム設定に追加の確認が必要な場合があります。',
    reload: 'ランタイム設定を再読み込み'
  },
  zh: {
    title: '运行时设置',
    close: '关闭运行时设置',
    scope: agent => `此 Mac · ${agent}`,
    current: '当前运行时',
    provider: '提供商',
    model: '模型',
    context: '上下文窗口',
    unknown: '未知',
    contextTokens: count => `${count.toLocaleString()} 个令牌`,
    mainModel: '主模型',
    modelDescription: '更改只会应用于新会话，不会热切换正在进行的会话。',
    modelReadOnly: '无法在此处更改此提供商的当前模型。',
    noModels: '此提供商没有可选模型。',
    chooseModel: '选择模型',
    memory: '记忆提供商',
    memoryDescription: '为所选代理选择已就绪的记忆提供商。现有记忆不会被删除。',
    activeMemory: '当前记忆提供商',
    builtInMemory: '内置记忆',
    ready: '已就绪',
    notReady: '未就绪',
    chooseMemory: '选择记忆提供商',
    pending: '正在保存所选代理的运行时设置…',
    cancelled: '没有运行时设置被更改。',
    applied: '已应用运行时设置。已从此 Mac 刷新当前值。',
    requestError: '无法更新此运行时设置，请重试。',
    refreshError: '更改可能已完成，但无法刷新当前设置。请重新打开此页面后再试。',
    staleAux: '部分相关运行时设置可能仍需注意。',
    reload: '重新加载运行时设置'
  },
  'zh-hant': {
    title: '執行階段設定',
    close: '關閉執行階段設定',
    scope: agent => `此 Mac · ${agent}`,
    current: '目前執行階段',
    provider: '提供者',
    model: '模型',
    context: '內容視窗',
    unknown: '未知',
    contextTokens: count => `${count.toLocaleString()} 個權杖`,
    mainModel: '主要模型',
    modelDescription: '變更只會套用至新工作階段，不會熱切換進行中的工作階段。',
    modelReadOnly: '無法在這裡變更此提供者的目前模型。',
    noModels: '此提供者沒有可選模型。',
    chooseModel: '選擇模型',
    memory: '記憶提供者',
    memoryDescription: '為所選代理選擇已就緒的記憶提供者。既有記憶不會被刪除。',
    activeMemory: '目前記憶提供者',
    builtInMemory: '內建記憶',
    ready: '已就緒',
    notReady: '未就緒',
    chooseMemory: '選擇記憶提供者',
    pending: '正在儲存所選代理的執行階段設定…',
    cancelled: '沒有執行階段設定被變更。',
    applied: '已套用執行階段設定。已從此 Mac 重新整理目前值。',
    requestError: '無法更新此執行階段設定，請再試一次。',
    refreshError: '變更可能已完成，但無法重新整理目前設定。請重新開啟此頁面後再試。',
    staleAux: '部分相關執行階段設定可能仍需注意。',
    reload: '重新載入執行階段設定'
  }
}
