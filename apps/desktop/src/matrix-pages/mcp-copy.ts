import type { Locale } from '@/i18n'

export interface McpSettingsCopy {
  title: string
  close: string
  scope: (agent: string) => string
  deferred: string
  privateSettings: string
  refresh: string
  error: string
  uncertain: string
  pending: string
  busy: string
  applied: string
  cancelled: string
  stoppedWatching: string
  cancelWatching: string
  transport: string
  stdio: string
  http: string
  auth: string
  none: string
  unknown: string
  oauth: string
  bearer: string
  command: string
  args: string
  env: string
  url: string
  token: string
  invalid: string
  inputOnly: string
}

export const mcpSettingsCopy: Record<Locale, McpSettingsCopy> = {
  en: {
    title: 'MCP servers',
    close: 'Close MCP servers',
    scope: agent => `This Mac · ${agent}`,
    deferred:
      'Configuration changes apply to new sessions. Reload is separate, requires confirmation and is unavailable during active work. Existing conversations are not rebuilt.',
    privateSettings: 'Saved connection settings and credentials are never shown here.',
    refresh: 'Refresh servers',
    error: 'The MCP request failed. Refresh before trying again.',
    uncertain:
      'The operation may have completed, but current settings could not be refreshed. Refresh before trying again.',
    pending: 'Waiting for the selected agent’s MCP operation…',
    busy: 'This agent is working. No MCP action was started. Try again when it finishes.',
    applied: 'MCP operation completed.',
    cancelled: 'No MCP action was started.',
    stoppedWatching: 'Stopped watching sign-in. The browser flow may still complete for the original agent.',
    cancelWatching: 'Stop watching sign-in',
    transport: 'Transport',
    stdio: 'Local command (stdio)',
    http: 'HTTP server',
    auth: 'Authentication',
    none: 'None',
    unknown: 'Unknown',
    oauth: 'Browser sign-in (OAuth)',
    bearer: 'Bearer token',
    command: 'Command',
    args: 'Arguments (JSON array)',
    env: 'Environment inputs (JSON object)',
    url: 'Server URL',
    token: 'New bearer token',
    invalid:
      'Check the name and provisioning inputs. Arguments must be a JSON string array and environment inputs a JSON string object.',
    inputOnly: 'Enter only new values. Existing values are not loaded.'
  },
  vi: {
    title: 'Máy chủ MCP',
    close: 'Đóng máy chủ MCP',
    scope: agent => `Máy Mac này · ${agent}`,
    deferred:
      'Thay đổi cấu hình áp dụng cho phiên mới. Tải lại là thao tác riêng, cần xác nhận và không khả dụng khi đang có công việc. Hội thoại hiện tại không bị tạo lại.',
    privateSettings: 'Cài đặt kết nối và thông tin xác thực đã lưu không bao giờ được hiển thị ở đây.',
    refresh: 'Làm mới máy chủ',
    error: 'Yêu cầu MCP thất bại. Hãy làm mới trước khi thử lại.',
    uncertain: 'Thao tác có thể đã hoàn tất nhưng chưa thể làm mới cài đặt hiện tại. Hãy làm mới trước khi thử lại.',
    pending: 'Đang chờ thao tác MCP của agent đang chọn…',
    busy: 'Agent này đang làm việc. Không có thao tác MCP nào được bắt đầu. Hãy thử lại khi công việc hoàn tất.',
    applied: 'Thao tác MCP đã hoàn tất.',
    cancelled: 'Không có thao tác MCP nào được bắt đầu.',
    stoppedWatching: 'Đã dừng theo dõi đăng nhập. Luồng trên trình duyệt vẫn có thể hoàn tất cho agent ban đầu.',
    cancelWatching: 'Dừng theo dõi đăng nhập',
    transport: 'Kiểu kết nối',
    stdio: 'Lệnh cục bộ (stdio)',
    http: 'Máy chủ HTTP',
    auth: 'Xác thực',
    none: 'Không',
    unknown: 'Không rõ',
    oauth: 'Đăng nhập trình duyệt (OAuth)',
    bearer: 'Token Bearer',
    command: 'Lệnh',
    args: 'Đối số (mảng JSON)',
    env: 'Giá trị môi trường mới (đối tượng JSON)',
    url: 'URL máy chủ',
    token: 'Token Bearer mới',
    invalid:
      'Kiểm tra tên và giá trị thiết lập. Đối số phải là mảng chuỗi JSON và giá trị môi trường là đối tượng chuỗi JSON.',
    inputOnly: 'Chỉ nhập giá trị mới. Giá trị đã lưu không được tải.'
  },
  ja: {
    title: 'MCP サーバー',
    close: 'MCP サーバーを閉じる',
    scope: agent => `この Mac · ${agent}`,
    deferred:
      '設定変更は新しいセッションに適用されます。再読み込みは別の確認付き操作で、作業中は利用できません。既存の会話は再構築されません。',
    privateSettings: '保存済みの接続設定や認証情報は表示されません。',
    refresh: 'サーバーを更新',
    error: 'MCP のリクエストに失敗しました。更新してから再試行してください。',
    uncertain: '操作は完了した可能性がありますが、現在の設定を更新できませんでした。更新してから再試行してください。',
    pending: '選択中のエージェントの MCP 操作を待っています…',
    busy: 'このエージェントは作業中です。MCP 操作は開始されませんでした。完了後に再試行してください。',
    applied: 'MCP 操作が完了しました。',
    cancelled: 'MCP 操作は開始されませんでした。',
    stoppedWatching: 'サインインの監視を停止しました。ブラウザーの処理は元のエージェントで完了する場合があります。',
    cancelWatching: 'サインインの監視を停止',
    transport: '接続方式',
    stdio: 'ローカルコマンド (stdio)',
    http: 'HTTP サーバー',
    auth: '認証',
    none: 'なし',
    unknown: '不明',
    oauth: 'ブラウザーサインイン (OAuth)',
    bearer: 'Bearer トークン',
    command: 'コマンド',
    args: '引数 (JSON 配列)',
    env: '環境変数の入力 (JSON オブジェクト)',
    url: 'サーバー URL',
    token: '新しい Bearer トークン',
    invalid:
      '名前と設定入力を確認してください。引数は JSON 文字列配列、環境変数は JSON 文字列オブジェクトにする必要があります。',
    inputOnly: '新しい値のみ入力してください。保存済みの値は読み込まれません。'
  },
  zh: {
    title: 'MCP 服务器',
    close: '关闭 MCP 服务器',
    scope: agent => `此 Mac · ${agent}`,
    deferred: '配置更改应用于新会话。重新加载是单独的确认操作，工作进行时不可用。现有对话不会被重建。',
    privateSettings: '此处不显示已保存的连接设置或凭据。',
    refresh: '刷新服务器',
    error: 'MCP 请求失败。请刷新后重试。',
    uncertain: '操作可能已完成，但无法刷新当前设置。请刷新后重试。',
    pending: '正在等待所选代理的 MCP 操作…',
    busy: '此代理正在工作。未启动 MCP 操作。请在工作完成后重试。',
    applied: 'MCP 操作已完成。',
    cancelled: '未启动任何 MCP 操作。',
    stoppedWatching: '已停止观察登录。浏览器流程仍可能为原代理完成。',
    cancelWatching: '停止观察登录',
    transport: '传输方式',
    stdio: '本地命令 (stdio)',
    http: 'HTTP 服务器',
    auth: '身份验证',
    none: '无',
    unknown: '未知',
    oauth: '浏览器登录 (OAuth)',
    bearer: 'Bearer 令牌',
    command: '命令',
    args: '参数（JSON 数组）',
    env: '环境输入（JSON 对象）',
    url: '服务器 URL',
    token: '新的 Bearer 令牌',
    invalid: '请检查名称和配置输入。参数必须是 JSON 字符串数组，环境输入必须是 JSON 字符串对象。',
    inputOnly: '仅输入新值。不加载已保存的值。'
  },
  'zh-hant': {
    title: 'MCP 伺服器',
    close: '關閉 MCP 伺服器',
    scope: agent => `此 Mac · ${agent}`,
    deferred: '設定變更套用至新工作階段。重新載入是獨立的確認操作，工作進行時不可用。現有對話不會被重建。',
    privateSettings: '此處不顯示已儲存的連線設定或憑證。',
    refresh: '重新整理伺服器',
    error: 'MCP 請求失敗。請重新整理後重試。',
    uncertain: '操作可能已完成，但無法重新整理目前設定。請重新整理後重試。',
    pending: '正在等待所選代理的 MCP 操作…',
    busy: '此代理正在工作。未啟動 MCP 操作。請在工作完成後重試。',
    applied: 'MCP 操作已完成。',
    cancelled: '未啟動任何 MCP 操作。',
    stoppedWatching: '已停止觀察登入。瀏覽器流程仍可能為原代理完成。',
    cancelWatching: '停止觀察登入',
    transport: '傳輸方式',
    stdio: '本機命令 (stdio)',
    http: 'HTTP 伺服器',
    auth: '驗證',
    none: '無',
    unknown: '未知',
    oauth: '瀏覽器登入 (OAuth)',
    bearer: 'Bearer 權杖',
    command: '命令',
    args: '參數（JSON 陣列）',
    env: '環境輸入（JSON 物件）',
    url: '伺服器 URL',
    token: '新的 Bearer 權杖',
    invalid: '請檢查名稱和設定輸入。參數必須是 JSON 字串陣列，環境輸入必須是 JSON 字串物件。',
    inputOnly: '僅輸入新值。不載入已儲存的值。'
  }
}
