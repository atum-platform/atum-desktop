import type { MatrixAuxiliaryConfirmation, MatrixAuxiliaryTask } from './matrix-auxiliary-settings'
interface AuxiliaryCopy {
  title: string
  help: string
  automatic: string
  choose: string
  refresh: string
  loadError: string
  saveError: string
  applied: string
  cancelled: string
  confirm: string
  apply: string
  cancel: string
  cost: string
  tasks: Record<MatrixAuxiliaryTask, string>
}
export const matrixAuxiliaryCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', AuxiliaryCopy> = {
  en: {
    title: 'Supporting models',
    help: 'Choose a model for each supporting task. Automatic follows your main model. Changes apply to new supporting calls; current chats keep running.',
    automatic: 'Automatic',
    choose: 'Choose model',
    refresh: 'Refresh',
    loadError: 'Could not load supporting models. Try again.',
    saveError: 'Could not verify this change. Refresh before trying again.',
    applied: 'Supporting model updated.',
    cancelled: 'Change cancelled.',
    confirm: 'Change this supporting model?',
    apply: 'Apply',
    cancel: 'Cancel',
    cost: 'This model may have additional cost. Apply it?',
    tasks: {
      vision: 'Vision',
      web_extract: 'Web extraction',
      compression: 'Context compression',
      skills_hub: 'Skill search',
      approval: 'Approval checks',
      mcp: 'MCP tasks',
      title_generation: 'Chat titles',
      pet_hatch: 'Pet creation',
      triage_specifier: 'Task triage',
      kanban_decomposer: 'Task breakdown',
      profile_describer: 'Agent descriptions',
      curator: 'Memory curation'
    }
  },
  vi: {
    title: 'Mô hình hỗ trợ',
    help: 'Chọn mô hình cho từng tác vụ hỗ trợ. Tự động dùng mô hình chính. Thay đổi áp dụng cho các lần gọi hỗ trợ mới; cuộc trò chuyện hiện tại vẫn tiếp tục.',
    automatic: 'Tự động',
    choose: 'Chọn mô hình',
    refresh: 'Làm mới',
    loadError: 'Không thể tải mô hình hỗ trợ. Hãy thử lại.',
    saveError: 'Không thể xác minh thay đổi. Hãy làm mới trước khi thử lại.',
    applied: 'Đã cập nhật mô hình hỗ trợ.',
    cancelled: 'Đã hủy thay đổi.',
    confirm: 'Đổi mô hình hỗ trợ này?',
    apply: 'Áp dụng',
    cancel: 'Hủy',
    cost: 'Mô hình này có thể tốn thêm chi phí. Áp dụng?',
    tasks: {
      vision: 'Thị giác',
      web_extract: 'Trích xuất trang web',
      compression: 'Nén ngữ cảnh',
      skills_hub: 'Tìm kỹ năng',
      approval: 'Kiểm tra phê duyệt',
      mcp: 'Tác vụ MCP',
      title_generation: 'Tiêu đề trò chuyện',
      pet_hatch: 'Tạo thú cưng',
      triage_specifier: 'Phân loại tác vụ',
      kanban_decomposer: 'Chia nhỏ tác vụ',
      profile_describer: 'Mô tả trợ lý',
      curator: 'Sắp xếp bộ nhớ'
    }
  },
  ja: {
    title: '補助モデル',
    help: '補助タスクごとにモデルを選びます。自動はメインモデルを使います。変更は新しい補助呼び出しに適用され、現在の会話は継続します。',
    automatic: '自動',
    choose: 'モデルを選択',
    refresh: '更新',
    loadError: '補助モデルを読み込めませんでした。再試行してください。',
    saveError: '変更を確認できませんでした。更新してから再試行してください。',
    applied: '補助モデルを更新しました。',
    cancelled: '変更をキャンセルしました。',
    confirm: 'この補助モデルを変更しますか？',
    apply: '適用',
    cancel: 'キャンセル',
    cost: 'このモデルには追加料金がかかる場合があります。適用しますか？',
    tasks: {
      vision: '画像認識',
      web_extract: 'ウェブ抽出',
      compression: 'コンテキスト圧縮',
      skills_hub: 'スキル検索',
      approval: '承認チェック',
      mcp: 'MCPタスク',
      title_generation: '会話のタイトル',
      pet_hatch: 'ペット作成',
      triage_specifier: 'タスク分類',
      kanban_decomposer: 'タスク分解',
      profile_describer: 'エージェントの説明',
      curator: 'メモリ整理'
    }
  },
  zh: {
    title: '辅助模型',
    help: '为每项辅助任务选择模型。自动会使用主模型。更改应用于新的辅助调用，当前对话继续运行。',
    automatic: '自动',
    choose: '选择模型',
    refresh: '刷新',
    loadError: '无法加载辅助模型。请重试。',
    saveError: '无法验证更改。请刷新后重试。',
    applied: '已更新辅助模型。',
    cancelled: '已取消更改。',
    confirm: '更改此辅助模型？',
    apply: '应用',
    cancel: '取消',
    cost: '此模型可能产生额外费用。是否应用？',
    tasks: {
      vision: '视觉',
      web_extract: '网页提取',
      compression: '上下文压缩',
      skills_hub: '技能搜索',
      approval: '审批检查',
      mcp: 'MCP任务',
      title_generation: '对话标题',
      pet_hatch: '创建宠物',
      triage_specifier: '任务分类',
      kanban_decomposer: '任务分解',
      profile_describer: '智能体描述',
      curator: '记忆整理'
    }
  },
  'zh-hant': {
    title: '輔助模型',
    help: '為每項輔助任務選擇模型。自動會使用主模型。變更套用於新的輔助呼叫，目前對話繼續執行。',
    automatic: '自動',
    choose: '選擇模型',
    refresh: '重新整理',
    loadError: '無法載入輔助模型。請重試。',
    saveError: '無法驗證變更。請重新整理後再試。',
    applied: '已更新輔助模型。',
    cancelled: '已取消變更。',
    confirm: '變更此輔助模型？',
    apply: '套用',
    cancel: '取消',
    cost: '此模型可能產生額外費用。是否套用？',
    tasks: {
      vision: '視覺',
      web_extract: '網頁擷取',
      compression: '上下文壓縮',
      skills_hub: '技能搜尋',
      approval: '核准檢查',
      mcp: 'MCP任務',
      title_generation: '對話標題',
      pet_hatch: '建立寵物',
      triage_specifier: '任務分類',
      kanban_decomposer: '任務拆解',
      profile_describer: '智慧代理描述',
      curator: '記憶整理'
    }
  }
}
export function matrixAuxiliaryConfirmationCopy(locale: string, agent: string, request: MatrixAuxiliaryConfirmation) {
  const c = matrixAuxiliaryCopy[locale as keyof typeof matrixAuxiliaryCopy] ?? matrixAuxiliaryCopy.en
  return {
    title: request.kind === 'expensive-model' ? c.cost : c.confirm,
    apply: c.apply,
    cancel: c.cancel,
    detail: `${agent}\n${c.tasks[request.task]}: ${request.provider === 'auto' ? c.automatic : `${request.provider} / ${request.model}`}\n\n${c.help}`
  }
}
