import type { MatrixToolSetting, MatrixToolSettingsConfirmation, MatrixTerminalBackend } from './matrix-tool-settings'
interface ToolSettingsCopy {
  title: string
  help: string
  apply: string
  allow: string
  cancel: string
  refresh: string
  unknown: string
  configured: string
  updated: string
  cancelled: string
  failed: string
  backend: string
  dimension: string
  mode: string
  backendEffect: string
  dimensionEffect: string
  modeEffect: string
  ready: string
  needsSetup: string
  unavailable: string
  confirm: string
  local: string
  modes: Record<'som' | 'vision' | 'ax', string>
}
export const matrixToolSettingsCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', ToolSettingsCopy> = {
  en: {
    title: 'Terminal & computer use',
    help: 'Save settings for this agent. Existing work keeps running.',
    apply: 'Apply',
    allow: 'Allow',
    cancel: 'Cancel',
    refresh: 'Refresh',
    unknown: 'Unknown',
    configured: 'Configured',
    updated: 'Tool setting saved.',
    cancelled: 'Change cancelled.',
    failed: 'Could not verify tool settings. Wait for active work to finish, refresh and try again.',
    backend: 'Terminal backend',
    dimension: 'Screenshot longest edge',
    mode: 'Follow-up capture',
    backendEffect:
      'Applies the next time this agent’s runtime starts. Environment overrides can take precedence. This does not switch a running shell or container.',
    dimensionEffect: '0 disables the size cap. This editor accepts 0–4096 pixels. Applies to the next driver session.',
    modeEffect: 'Applies to the next follow-up capture.',
    ready: 'Ready',
    needsSetup: 'Needs setup',
    unavailable: 'Unavailable',
    confirm: 'Allow this tool setting change?',
    local: 'Local',
    modes: {
      som: 'Screenshot with labels',
      vision: 'Screenshot',
      ax: 'Accessibility tree'
    }
  },
  vi: {
    title: 'Terminal và thao tác máy tính',
    help: 'Lưu cài đặt cho trợ lý này. Công việc hiện tại vẫn tiếp tục.',
    apply: 'Áp dụng',
    allow: 'Cho phép',
    cancel: 'Hủy',
    refresh: 'Làm mới',
    unknown: 'Chưa rõ',
    configured: 'Đã cấu hình',
    updated: 'Đã lưu cài đặt công cụ.',
    cancelled: 'Đã hủy thay đổi.',
    failed: 'Không thể xác minh cài đặt công cụ. Đợi công việc hiện tại kết thúc, làm mới và thử lại.',
    backend: 'Môi trường terminal',
    dimension: 'Cạnh dài nhất của ảnh chụp',
    mode: 'Ảnh sau thao tác',
    backendEffect:
      'Áp dụng khi môi trường của trợ lý khởi động lại. Biến môi trường có thể được ưu tiên. Không chuyển shell hoặc container đang chạy.',
    dimensionEffect:
      '0 bỏ giới hạn kích thước. Trình chỉnh sửa chấp nhận 0–4096 pixel. Áp dụng cho phiên driver tiếp theo.',
    modeEffect: 'Áp dụng cho lần chụp sau thao tác tiếp theo.',
    ready: 'Sẵn sàng',
    needsSetup: 'Cần thiết lập',
    unavailable: 'Chưa khả dụng',
    confirm: 'Cho phép thay đổi cài đặt công cụ này?',
    local: 'Cục bộ',
    modes: {
      som: 'Ảnh chụp có nhãn',
      vision: 'Ảnh chụp',
      ax: 'Cây trợ năng'
    }
  },
  ja: {
    title: 'ターミナルとコンピューター操作',
    help: 'このアシスタントの設定を保存します。実行中の作業は続行します。',
    apply: '適用',
    allow: '許可',
    cancel: 'キャンセル',
    refresh: '更新',
    unknown: '不明',
    configured: '設定済み',
    updated: 'ツール設定を保存しました。',
    cancelled: '変更をキャンセルしました。',
    failed: 'ツール設定を確認できませんでした。実行中の作業が終わってから更新して再試行してください。',
    backend: 'ターミナル環境',
    dimension: 'スクリーンショットの最長辺',
    mode: '操作後のキャプチャ',
    backendEffect:
      '次にアシスタントのランタイムが起動した時に適用されます。環境変数が優先される場合があります。実行中のシェルやコンテナは切り替わりません。',
    dimensionEffect:
      '0でサイズ制限を解除します。0〜4096ピクセルを設定できます。次のドライバーセッションに適用されます。',
    modeEffect: '次の操作後キャプチャに適用されます。',
    ready: '準備完了',
    needsSetup: '設定が必要',
    unavailable: '利用不可',
    confirm: 'このツール設定の変更を許可しますか？',
    local: 'ローカル',
    modes: {
      som: 'ラベル付きスクリーンショット',
      vision: 'スクリーンショット',
      ax: 'アクセシビリティツリー'
    }
  },
  zh: {
    title: '终端与电脑操作',
    help: '保存此助手的设置。当前任务继续运行。',
    apply: '应用',
    allow: '允许',
    cancel: '取消',
    refresh: '刷新',
    unknown: '未知',
    configured: '已配置',
    updated: '已保存工具设置。',
    cancelled: '已取消更改。',
    failed: '无法验证工具设置。请等当前任务结束后刷新并重试。',
    backend: '终端环境',
    dimension: '截图最长边',
    mode: '操作后捕获',
    backendEffect: '下次助手运行环境启动时生效。环境变量可能优先。不会切换正在运行的 shell 或容器。',
    dimensionEffect: '0取消尺寸限制。此编辑器支持0–4096像素。下次驱动会话生效。',
    modeEffect: '下次操作后捕获时生效。',
    ready: '就绪',
    needsSetup: '需要设置',
    unavailable: '不可用',
    confirm: '允许更改此工具设置？',
    local: '本地',
    modes: {
      som: '带标签的截图',
      vision: '截图',
      ax: '辅助功能树'
    }
  },
  'zh-hant': {
    title: '終端機與電腦操作',
    help: '儲存此助理的設定。目前工作繼續執行。',
    apply: '套用',
    allow: '允許',
    cancel: '取消',
    refresh: '重新整理',
    unknown: '未知',
    configured: '已設定',
    updated: '已儲存工具設定。',
    cancelled: '已取消變更。',
    failed: '無法驗證工具設定。請等目前工作結束後重新整理並重試。',
    backend: '終端機環境',
    dimension: '截圖最長邊',
    mode: '操作後擷取',
    backendEffect: '下次助理執行環境啟動時生效。環境變數可能優先。不會切換正在執行的 shell 或容器。',
    dimensionEffect: '0取消尺寸限制。此編輯器支援0–4096像素。下次驅動程式工作階段生效。',
    modeEffect: '下次操作後擷取時生效。',
    ready: '就緒',
    needsSetup: '需要設定',
    unavailable: '無法使用',
    confirm: '允許變更此工具設定？',
    local: '本機',
    modes: {
      som: '含標籤的截圖',
      vision: '截圖',
      ax: '輔助使用樹'
    }
  }
}
export function matrixTerminalBackendLabel(locale: string, id: MatrixTerminalBackend): string {
  const copy = matrixToolSettingsCopy[locale as keyof typeof matrixToolSettingsCopy] ?? matrixToolSettingsCopy.en
  return {
    local: copy.local,
    docker: 'Docker',
    singularity: 'Singularity / Apptainer',
    ssh: 'SSH',
    modal: 'Modal',
    daytona: 'Daytona'
  }[id]
}
export function matrixToolSettingLabel(locale: string, field: MatrixToolSetting): string {
  const copy = matrixToolSettingsCopy[locale as keyof typeof matrixToolSettingsCopy] ?? matrixToolSettingsCopy.en
  return field === 'terminal.backend'
    ? copy.backend
    : field === 'computer_use.max_image_dimension'
      ? copy.dimension
      : copy.mode
}
export function matrixToolSettingsConfirmationCopy(
  locale: string,
  agent: string,
  request: MatrixToolSettingsConfirmation
) {
  const copy = matrixToolSettingsCopy[locale as keyof typeof matrixToolSettingsCopy] ?? matrixToolSettingsCopy.en
  const effect =
    request.field === 'terminal.backend'
      ? copy.backendEffect
      : request.field === 'computer_use.max_image_dimension'
        ? copy.dimensionEffect
        : copy.modeEffect
  const value =
    request.field === 'terminal.backend'
      ? matrixTerminalBackendLabel(locale, request.value as MatrixTerminalBackend)
      : request.field === 'computer_use.capture_after_mode'
        ? copy.modes[request.value as keyof typeof copy.modes]
        : String(request.value)
  return {
    title: copy.confirm,
    allow: copy.allow,
    cancel: copy.cancel,
    detail: agent + '\n' + matrixToolSettingLabel(locale, request.field) + ': ' + value + '\n\n' + effect
  }
}
