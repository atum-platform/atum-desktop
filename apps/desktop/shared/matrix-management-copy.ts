import type { MatrixMcpConfirmation } from './matrix-mcp-settings'
import type { MatrixProviderConfirmation } from './matrix-provider-settings'

type Confirmation = MatrixProviderConfirmation | MatrixMcpConfirmation
type Copy = {
  title: string
  cancel: string
  apply: string
  help: string
  planRisk: (policy: string, date: string) => string
  actions: Record<Confirmation['kind'], string>
}

const copy: Record<string, Copy> = {
  en: {
    title: 'Change this agent on this Mac?',
    cancel: 'Cancel',
    apply: 'Allow',
    help: 'Tools you connect can run commands and use the internet. Changes apply to new chats with this agent.',
    planRisk: (policy, date) =>
      `OpenAI has not approved this Atum plan sign-in. Your account may be limited. Continue only if you accept that risk. Policy: ${policy}. Account acknowledgment: ${date}.`,
    actions: {
      'provider-key': 'Save provider credential',
      'provider-select': 'Select model',
      'provider-endpoint': 'Add model endpoint',
      'provider-oauth': 'Sign in to provider in your browser',
      'provider-disconnect': 'Disconnect provider',
      'expensive-model': 'Select a model with additional cost',
      'mcp-add': 'Add MCP server',
      'mcp-remove': 'Remove MCP server configuration',
      'mcp-test': 'Connect and test MCP server',
      'mcp-auth': 'Sign in to MCP server in your browser',
      'mcp-enabled': 'Change MCP server availability',
      'mcp-install': 'Install MCP server',
      'mcp-reload': 'Reconnect configured MCP servers'
    }
  },
  vi: {
    title: 'Thay đổi trợ lý trên máy Mac này?',
    cancel: 'Hủy',
    apply: 'Cho phép',
    help: 'Công cụ bạn kết nối có thể chạy lệnh và dùng Internet. Thay đổi áp dụng cho các cuộc trò chuyện mới với trợ lý này.',
    planRisk: (policy, date) =>
      `OpenAI chưa phê duyệt cách đăng nhập gói này trong Atum. Tài khoản của bạn có thể bị giới hạn. Chỉ tiếp tục nếu bạn chấp nhận rủi ro đó. Chính sách: ${policy}. Ngày tài khoản xác nhận: ${date}.`,
    actions: {
      'provider-key': 'Lưu thông tin đăng nhập nhà cung cấp',
      'provider-select': 'Chọn mô hình',
      'provider-endpoint': 'Thêm điểm kết nối mô hình',
      'provider-oauth': 'Đăng nhập nhà cung cấp trong trình duyệt',
      'provider-disconnect': 'Ngắt kết nối nhà cung cấp',
      'expensive-model': 'Chọn mô hình có chi phí bổ sung',
      'mcp-add': 'Thêm máy chủ MCP',
      'mcp-remove': 'Xóa cấu hình máy chủ MCP',
      'mcp-test': 'Kết nối và kiểm tra máy chủ MCP',
      'mcp-auth': 'Đăng nhập máy chủ MCP trong trình duyệt',
      'mcp-enabled': 'Thay đổi trạng thái máy chủ MCP',
      'mcp-install': 'Cài máy chủ MCP',
      'mcp-reload': 'Kết nối lại các máy chủ MCP đã cấu hình'
    }
  },
  ja: {
    title: 'この Mac のエージェントを変更しますか？',
    cancel: 'キャンセル',
    apply: '許可',
    help: '接続したツールはコマンドを実行したりインターネットを使ったりできます。変更はこのエージェントとの新しいチャットに適用されます。',
    planRisk: (policy, date) =>
      `OpenAI は Atum でのこのプラン認証を承認していません。アカウントが制限される可能性があります。このリスクに同意する場合のみ続行してください。ポリシー: ${policy}。アカウントの同意日: ${date}。`,
    actions: {
      'provider-key': 'プロバイダーの認証情報を保存',
      'provider-select': 'モデルを選択',
      'provider-endpoint': 'モデル接続先を追加',
      'provider-oauth': 'ブラウザーでプロバイダーにログイン',
      'provider-disconnect': 'プロバイダーを切断',
      'expensive-model': '追加料金のあるモデルを選択',
      'mcp-add': 'MCP サーバーを追加',
      'mcp-remove': 'MCP サーバー設定を削除',
      'mcp-test': 'MCP サーバーに接続してテスト',
      'mcp-auth': 'ブラウザーで MCP サーバーにログイン',
      'mcp-enabled': 'MCP サーバーの利用状態を変更',
      'mcp-install': 'MCP サーバーをインストール',
      'mcp-reload': '設定済み MCP サーバーに再接続'
    }
  },
  zh: {
    title: '更改此 Mac 上的智能体？',
    cancel: '取消',
    apply: '允许',
    help: '你连接的工具可以运行命令并访问互联网。更改会应用于与此智能体的新聊天。',
    planRisk: (policy, date) =>
      `OpenAI 尚未批准 Atum 的此订阅登录方式。你的账户可能受限。仅在接受此风险时继续。政策：${policy}。账户确认日期：${date}。`,
    actions: {
      'provider-key': '保存提供商凭据',
      'provider-select': '选择模型',
      'provider-endpoint': '添加模型端点',
      'provider-oauth': '在浏览器中登录提供商',
      'provider-disconnect': '断开提供商连接',
      'expensive-model': '选择有额外费用的模型',
      'mcp-add': '添加 MCP 服务器',
      'mcp-remove': '删除 MCP 服务器配置',
      'mcp-test': '连接并测试 MCP 服务器',
      'mcp-auth': '在浏览器中登录 MCP 服务器',
      'mcp-enabled': '更改 MCP 服务器可用状态',
      'mcp-install': '安装 MCP 服务器',
      'mcp-reload': '重新连接已配置的 MCP 服务器'
    }
  },
  'zh-hant': {
    title: '變更此 Mac 上的智慧代理？',
    cancel: '取消',
    apply: '允許',
    help: '你連接的工具可以執行命令並存取網際網路。變更會套用至與此智慧代理的新聊天。',
    planRisk: (policy, date) =>
      `OpenAI 尚未核准 Atum 的此訂閱登入方式。你的帳戶可能受限。僅在接受此風險時繼續。政策：${policy}。帳戶確認日期：${date}。`,
    actions: {
      'provider-key': '儲存供應商憑證',
      'provider-select': '選擇模型',
      'provider-endpoint': '新增模型端點',
      'provider-oauth': '在瀏覽器中登入供應商',
      'provider-disconnect': '中斷供應商連線',
      'expensive-model': '選擇有額外費用的模型',
      'mcp-add': '新增 MCP 伺服器',
      'mcp-remove': '刪除 MCP 伺服器設定',
      'mcp-test': '連接並測試 MCP 伺服器',
      'mcp-auth': '在瀏覽器中登入 MCP 伺服器',
      'mcp-enabled': '變更 MCP 伺服器可用狀態',
      'mcp-install': '安裝 MCP 伺服器',
      'mcp-reload': '重新連接已設定的 MCP 伺服器'
    }
  }
}

export function matrixManagementConfirmationCopy(locale: string, agentName: string, request: Confirmation) {
  const c = Object.hasOwn(copy, locale) ? copy[locale] : copy.en
  const name = 'provider' in request ? request.provider : 'name' in request ? request.name : ''
  const model = 'model' in request ? request.model : ''
  let target = 'target' in request && typeof request.target === 'string' ? request.target : ''

  if (request.kind === 'provider-endpoint') {
    try {
      const url = new URL(request.baseUrl)
      target = `${url.origin}${url.pathname}`
    } catch {
      /* malformed endpoints are rejected by the native adapter */
    }
  }

  const risk =
    request.kind === 'provider-oauth' && request.planRisk
      ? `\n\n${c.planRisk(request.planRisk.policyVersion, request.planRisk.acknowledgedAt)}`
      : ''

  return {
    title: c.title,
    cancel: c.cancel,
    apply: c.apply,
    detail: `${agentName}\n${c.actions[request.kind]}${name ? ` · ${name}` : ''}${model ? ` · ${model}` : ''}${target ? `\n${target}` : ''}\n\n${c.help}${risk}`
  }
}
