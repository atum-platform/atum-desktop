import type { Locale } from '@/i18n'

export interface ProvidersCopy {
  title: string
  close: string
  scope: (agent: string) => string
  description: string
  current: string
  providers: string
  ready: string
  notReady: string
  deferred: string
  signIn: string
  disconnect: string
  key: string
  saveKey: string
  replaceKey: string
  model: string
  chooseModel: string
  cancel: string
  add: string
  endpointName: string
  endpointUrl: string
  endpointModel: string
  optionalKey: string
  pending: string
  applied: string
  cancelled: string
  failed: string
  busy: string
  uncertain: string
  reload: string
  loadFailed: string
  empty: string
  oauthPending: string
  userCode: string
  authCode: string
  submitCode: string
  oauthFailed: string
  staleAux: string
  /** Under the description: only plans the provider lets other apps use. */
  termsNote: string
  /** A plan sign-in Atum does not offer (shared/matrix-provider-terms.ts). */
  planAcknowledged: (date: string) => string
  planNotOffered: string
}

export const providersCopy: Record<Locale, ProvidersCopy> = {
  en: {
    title: 'Providers',
    close: 'Close providers',
    scope: agent => `This Mac · ${agent}`,
    description:
      'A change applies from each chat’s next message. A task that is already running finishes on its current model.',
    current: 'Current provider and model',
    providers: 'Available providers',
    ready: 'Ready',
    notReady: 'Not configured',
    deferred: 'Set up with the provider’s existing tools. Nous routing is not available here yet.',
    signIn: 'Sign in',
    disconnect: 'Disconnect',
    key: 'API key',
    saveKey: 'Save API key',
    replaceKey: 'Replace API key',
    model: 'Model',
    chooseModel: 'Choose a model',
    cancel: 'Cancel',
    add: 'Add endpoint',
    endpointName: 'Endpoint name',
    endpointUrl: 'Endpoint URL',
    endpointModel: 'Endpoint model',
    optionalKey: 'API key (optional)',
    pending: 'Waiting for confirmation or the provider…',
    applied: 'Saved for this agent.',
    cancelled: 'Cancelled. Reload providers to check the current status.',
    failed: 'Could not complete this provider action.',
    busy: 'Finish the current task, then try again.',
    uncertain: 'The action may have completed. Reload current settings before trying again.',
    reload: 'Reload providers',
    loadFailed: 'Could not read this agent’s providers.',
    empty: 'No providers are available.',
    oauthPending: 'Finish signing in in your browser. Keep this page open.',
    userCode: 'Verification code',
    authCode: 'Authorization code',
    submitCode: 'Complete sign-in',
    oauthFailed: 'Sign-in did not complete. You can start a new sign-in.',
    staleAux: 'Some auxiliary models still use another provider. Their existing settings were preserved.',
    termsNote:
      'Only use a subscription plan that its provider allows in other apps. Signing in with one it doesn’t allow can get your account limited.',
    planAcknowledged: date => `Account risk acknowledged: ${date}.`,
    planNotOffered:
      'Atum doesn’t offer signing in with this plan, because the provider doesn’t allow it in other apps. Use an API key instead.'
  },
  vi: {
    title: 'Nhà cung cấp',
    close: 'Đóng nhà cung cấp',
    scope: agent => `Máy Mac này · ${agent}`,
    description:
      'Thay đổi áp dụng từ tin nhắn tiếp theo của mỗi cuộc trò chuyện. Tác vụ đang chạy sẽ hoàn tất với mô hình hiện tại.',
    current: 'Nhà cung cấp và mô hình hiện tại',
    providers: 'Nhà cung cấp khả dụng',
    ready: 'Sẵn sàng',
    notReady: 'Chưa cấu hình',
    deferred: 'Thiết lập bằng công cụ hiện có của nhà cung cấp. Định tuyến Nous chưa khả dụng ở đây.',
    signIn: 'Đăng nhập',
    disconnect: 'Ngắt kết nối',
    key: 'Khóa API',
    saveKey: 'Lưu khóa API',
    replaceKey: 'Thay khóa API',
    model: 'Mô hình',
    chooseModel: 'Chọn mô hình',
    cancel: 'Hủy',
    add: 'Thêm endpoint',
    endpointName: 'Tên endpoint',
    endpointUrl: 'URL endpoint',
    endpointModel: 'Mô hình endpoint',
    optionalKey: 'Khóa API (không bắt buộc)',
    pending: 'Đang chờ xác nhận hoặc nhà cung cấp…',
    applied: 'Đã lưu cho agent này.',
    cancelled: 'Đã hủy. Hãy tải lại nhà cung cấp để xem trạng thái hiện tại.',
    failed: 'Không thể hoàn tất thao tác với nhà cung cấp.',
    busy: 'Hãy hoàn tất tác vụ hiện tại rồi thử lại.',
    uncertain: 'Thao tác có thể đã hoàn tất. Hãy tải lại cài đặt hiện tại trước khi thử lại.',
    reload: 'Tải lại nhà cung cấp',
    loadFailed: 'Không thể đọc nhà cung cấp của agent này.',
    empty: 'Không có nhà cung cấp khả dụng.',
    oauthPending: 'Hoàn tất đăng nhập trong trình duyệt. Giữ trang này mở.',
    userCode: 'Mã xác minh',
    authCode: 'Mã ủy quyền',
    submitCode: 'Hoàn tất đăng nhập',
    oauthFailed: 'Đăng nhập chưa hoàn tất. Bạn có thể bắt đầu đăng nhập lại.',
    staleAux: 'Một số mô hình phụ vẫn dùng nhà cung cấp khác. Cài đặt hiện có được giữ nguyên.',
    termsNote:
      'Chỉ dùng gói đăng ký mà nhà cung cấp cho phép dùng trong ứng dụng khác. Đăng nhập bằng gói không được phép có thể khiến tài khoản của bạn bị giới hạn.',
    planAcknowledged: date => `Tài khoản đã xác nhận rủi ro: ${date}.`,
    planNotOffered:
      'Atum không đăng nhập bằng gói này, vì nhà cung cấp không cho phép dùng trong ứng dụng khác. Hãy dùng khóa API thay thế.'
  },
  ja: {
    title: 'プロバイダー',
    close: 'プロバイダーを閉じる',
    scope: agent => `この Mac · ${agent}`,
    description: '変更は各チャットの次のメッセージから適用されます。実行中のタスクは現在のモデルのまま完了します。',
    current: '現在のプロバイダーとモデル',
    providers: '利用可能なプロバイダー',
    ready: '準備完了',
    notReady: '未設定',
    deferred: 'プロバイダーの既存ツールで設定してください。Nous のルーティングはまだここでは利用できません。',
    signIn: 'ログイン',
    disconnect: '接続解除',
    key: 'API キー',
    saveKey: 'API キーを保存',
    replaceKey: 'API キーを置換',
    model: 'モデル',
    chooseModel: 'モデルを選択',
    cancel: 'キャンセル',
    add: 'エンドポイントを追加',
    endpointName: 'エンドポイント名',
    endpointUrl: 'エンドポイント URL',
    endpointModel: 'エンドポイントのモデル',
    optionalKey: 'API キー（任意）',
    pending: '確認またはプロバイダーを待っています…',
    applied: 'このエージェントに保存しました。',
    cancelled: 'キャンセルしました。現在の状態を確認するには再読み込みしてください。',
    failed: 'プロバイダーの操作を完了できませんでした。',
    busy: '現在のタスクを終了してから再試行してください。',
    uncertain: '操作は完了している可能性があります。再試行前に現在の設定を再読み込みしてください。',
    reload: 'プロバイダーを再読み込み',
    loadFailed: 'このエージェントのプロバイダーを読み取れませんでした。',
    empty: '利用可能なプロバイダーはありません。',
    oauthPending: 'ブラウザーでログインを完了してください。このページを開いたままにしてください。',
    userCode: '確認コード',
    authCode: '認証コード',
    submitCode: 'ログインを完了',
    oauthFailed: 'ログインは完了しませんでした。新しいログインを開始できます。',
    staleAux: '一部の補助モデルは別のプロバイダーを使用しています。既存の設定は維持されました。',
    termsNote:
      '他のアプリでの利用が提供元に認められているプランだけを使ってください。認められていないプランでサインインすると、アカウントが制限されることがあります。',
    planAcknowledged: date => `アカウントのリスク同意日: ${date}。`,
    planNotOffered:
      'このプランは提供元が他のアプリでの利用を認めていないため、Atum ではサインインできません。代わりに API キーを使ってください。'
  },
  zh: {
    title: '提供商',
    close: '关闭提供商',
    scope: agent => `此 Mac · ${agent}`,
    description: '更改从每个聊天的下一条消息开始生效。正在运行的任务会用当前模型完成。',
    current: '当前提供商和模型',
    providers: '可用提供商',
    ready: '就绪',
    notReady: '未配置',
    deferred: '请使用提供商现有工具设置。此处尚不支持 Nous 路由。',
    signIn: '登录',
    disconnect: '断开连接',
    key: 'API 密钥',
    saveKey: '保存 API 密钥',
    replaceKey: '替换 API 密钥',
    model: '模型',
    chooseModel: '选择模型',
    cancel: '取消',
    add: '添加端点',
    endpointName: '端点名称',
    endpointUrl: '端点 URL',
    endpointModel: '端点模型',
    optionalKey: 'API 密钥（可选）',
    pending: '正在等待确认或提供商…',
    applied: '已为此智能体保存。',
    cancelled: '已取消。请重新加载提供商以查看当前状态。',
    failed: '无法完成提供商操作。',
    busy: '请完成当前任务后重试。',
    uncertain: '操作可能已完成。重试前请重新加载当前设置。',
    reload: '重新加载提供商',
    loadFailed: '无法读取此智能体的提供商。',
    empty: '没有可用提供商。',
    oauthPending: '请在浏览器中完成登录，并保持此页面打开。',
    userCode: '验证码',
    authCode: '授权码',
    submitCode: '完成登录',
    oauthFailed: '登录未完成。您可以重新开始登录。',
    staleAux: '部分辅助模型仍使用其他提供商。现有设置已保留。',
    termsNote: '只使用提供商允许在其他应用中使用的订阅方案。用不被允许的方案登录，可能导致你的账户受限。',
    planAcknowledged: date => `账户风险确认日期：${date}。`,
    planNotOffered: '提供商不允许在其他应用中使用此方案，所以 Atum 不提供用它登录。请改用 API 密钥。'
  },
  'zh-hant': {
    title: '供應商',
    close: '關閉供應商',
    scope: agent => `此 Mac · ${agent}`,
    description: '變更從每個聊天的下一則訊息開始生效。執行中的工作會用目前模型完成。',
    current: '目前供應商與模型',
    providers: '可用供應商',
    ready: '就緒',
    notReady: '尚未設定',
    deferred: '請使用供應商現有工具設定。此處尚不支援 Nous 路由。',
    signIn: '登入',
    disconnect: '中斷連線',
    key: 'API 金鑰',
    saveKey: '儲存 API 金鑰',
    replaceKey: '更換 API 金鑰',
    model: '模型',
    chooseModel: '選擇模型',
    cancel: '取消',
    add: '新增端點',
    endpointName: '端點名稱',
    endpointUrl: '端點 URL',
    endpointModel: '端點模型',
    optionalKey: 'API 金鑰（選填）',
    pending: '正在等待確認或供應商…',
    applied: '已為此代理儲存。',
    cancelled: '已取消。請重新載入供應商以查看目前狀態。',
    failed: '無法完成供應商操作。',
    busy: '請完成目前工作後再試一次。',
    uncertain: '操作可能已完成。重試前請重新載入目前設定。',
    reload: '重新載入供應商',
    loadFailed: '無法讀取此代理的供應商。',
    empty: '沒有可用供應商。',
    oauthPending: '請在瀏覽器中完成登入，並保持此頁面開啟。',
    userCode: '驗證碼',
    authCode: '授權碼',
    submitCode: '完成登入',
    oauthFailed: '登入未完成。您可以重新開始登入。',
    staleAux: '部分輔助模型仍使用其他供應商。現有設定已保留。',
    termsNote: '只使用供應商允許在其他應用程式中使用的訂閱方案。用不被允許的方案登入，可能導致你的帳戶受限。',
    planAcknowledged: date => `帳戶風險確認日期：${date}。`,
    planNotOffered: '供應商不允許在其他應用程式中使用此方案，所以 Atum 不提供用它登入。請改用 API 金鑰。'
  }
}
