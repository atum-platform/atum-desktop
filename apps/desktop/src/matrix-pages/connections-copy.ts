import type { Locale } from '@/i18n'

/** The four API key services Connections offers by name (pages-providers.ts PRIMARY_KEYS). */
export const CONNECTION_KEY_SERVICES = ['openai-api', 'gemini', 'anthropic', 'openrouter', 'opencode-go'] as const
export type ConnectionKeyService = (typeof CONNECTION_KEY_SERVICES)[number]

export const CONNECTION_LOCAL_APPS = ['ollama', 'lmstudio'] as const
export type ConnectionLocalApp = (typeof CONNECTION_LOCAL_APPS)[number]

/**
 * Connections (0.18.3, MP-2): one friendly place for a person who is not technical. No
 * "provider", "endpoint", "OAuth" or "token" in the primary copy; the full provider page
 * stays one level deeper, with a warning.
 */
export interface ConnectionsCopy {
  title: string
  close: string
  scope: (agent: string) => string
  intro: string
  usingAtum: string
  usingConnection: (name: string) => string
  backToAtum: string
  chatgptTitle: string
  chatgptHelp: string
  /** The one honest line about the sign-in's status with OpenAI. */
  chatgptNote: string
  chatgptSteps: [string, string, string, string]
  getCode: string
  codeLabel: string
  copyCode: string
  openPage: string
  waiting: string
  cancel: string
  /** Signed out of ChatGPT: the one button, which opens the full provider page where the sign-in lives. */
  chatgptSignIn: string
  chatgptConnected: string
  useChatgpt: string
  disconnect: string
  chatgptReady: string
  chatgptFailed: string
  /** The assistant answers with ChatGPT and its sign-in on this Mac ended: sign in again in Advanced. */
  chatgptSignInAgain: string
  keysTitle: string
  keysHelp: string
  keyNames: Record<ConnectionKeyService, string>
  keySaved: string
  keyMissing: string
  addKey: string
  replaceKey: string
  keyLabel: (service: string) => string
  saveKey: string
  whereKey: string
  chooseModel: string
  localTitle: string
  localHelp: string
  localApps: Record<ConnectionLocalApp, string>
  localModel: string
  localModelExample: string
  connectLocal: string
  inUse: string
  advancedTitle: string
  advancedHelp: string
  advancedWarning: string
  back: string
  working: string
  applied: string
  cancelled: string
  failed: string
  busy: string
  loadFailed: string
  retry: string
}

const en: ConnectionsCopy = {
  title: 'Connections',
  close: 'Close Connections',
  scope: agent => `On this Mac · ${agent}`,
  intro: 'Let your assistant use a plan or model of your own.',
  usingAtum: 'Answering with Atum’s AI',
  usingConnection: name => `Answering with ${name}`,
  backToAtum: 'Switch back to Atum’s AI',
  chatgptTitle: 'Your ChatGPT plan',
  chatgptHelp: 'Use your ChatGPT Plus or Pro plan. It doesn’t use Protons.',
  chatgptNote:
    'OpenAI hasn’t approved this sign-in for apps like Atum yet, so there is a small risk your account gets limited.',
  chatgptSteps: [
    'In ChatGPT, open Settings › Security and turn on “device code sign-in” if it’s off.',
    'Press Get a code. Atum opens OpenAI’s sign-in page.',
    'Type the code shown here and confirm.',
    'Come back here. Atum finishes by itself.'
  ],
  getCode: 'Get a code',
  codeLabel: 'Your code',
  copyCode: 'Copy code',
  openPage: 'Open the sign-in page again',
  waiting: 'Waiting for you to confirm in your browser…',
  cancel: 'Cancel',
  chatgptSignIn: 'Sign in to ChatGPT',
  chatgptConnected: 'Connected',
  useChatgpt: 'Use ChatGPT for this assistant',
  disconnect: 'Disconnect',
  chatgptReady: 'Done. Your assistant now uses your ChatGPT plan, without Protons.',
  chatgptFailed:
    'That didn’t go through. If the page refused, turn on device code sign-in in ChatGPT › Settings › Security, then try again.',
  chatgptSignInAgain: 'Your ChatGPT sign-in on this Mac has ended, so this assistant can’t answer. Sign in to ChatGPT again below.',
  keysTitle: 'API keys',
  keysHelp: 'Paste a key from a service you pay for. It bills you directly, and the key stays on this Mac.',
  keyNames: { 'openai-api': 'OpenAI', gemini: 'Google AI Studio', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' },
  keySaved: 'Key saved',
  keyMissing: 'No key yet',
  addKey: 'Add key',
  replaceKey: 'Replace key',
  keyLabel: service => `${service} key`,
  saveKey: 'Save key',
  whereKey: 'Where do I get a key?',
  chooseModel: 'Choose a model',
  localTitle: 'Models on this Mac',
  localHelp: 'Open Ollama or LM Studio on this Mac and download a model first. Then type its name here.',
  localApps: { ollama: 'Ollama', lmstudio: 'LM Studio' },
  localModel: 'Model name',
  localModelExample: 'for example llama3.2',
  connectLocal: 'Connect',
  inUse: 'In use',
  advancedTitle: 'All services (advanced)',
  advancedHelp: 'Every service the engine supports, for people who know what they need.',
  advancedWarning:
    'This page is for advanced use. Settings here can stop your assistant from answering, and some services may not allow their plans in other apps.',
  back: 'Back to Connections',
  working: 'Working on it…',
  applied: 'Saved.',
  cancelled: 'Nothing changed.',
  failed: 'That didn’t work. Check your connection and try again.',
  busy: 'Your assistant is busy. Try again in a moment.',
  loadFailed: 'Couldn’t load your connections.',
  retry: 'Try again'
}

const vi: ConnectionsCopy = {
  title: 'Kết nối',
  close: 'Đóng Kết nối',
  scope: agent => `Trên Mac này · ${agent}`,
  intro: 'Cho trợ lý dùng gói hoặc mô hình của riêng bạn.',
  usingAtum: 'Đang trả lời bằng AI của Atum',
  usingConnection: name => `Đang trả lời bằng ${name}`,
  backToAtum: 'Quay lại AI của Atum',
  chatgptTitle: 'Gói ChatGPT của bạn',
  chatgptHelp: 'Dùng gói ChatGPT Plus hoặc Pro bạn đang có. Không tốn Proton.',
  chatgptNote:
    'OpenAI chưa chính thức duyệt cách đăng nhập này cho ứng dụng như Atum, nên có một chút rủi ro tài khoản bị giới hạn.',
  chatgptSteps: [
    'Trong ChatGPT, vào Cài đặt › Bảo mật và bật “Đăng nhập bằng mã thiết bị” nếu đang tắt.',
    'Bấm Lấy mã. Atum sẽ mở trang đăng nhập của OpenAI.',
    'Nhập mã hiện ở đây rồi xác nhận.',
    'Quay lại đây. Atum sẽ tự hoàn tất.'
  ],
  getCode: 'Lấy mã',
  codeLabel: 'Mã của bạn',
  copyCode: 'Sao chép mã',
  openPage: 'Mở lại trang đăng nhập',
  waiting: 'Đang chờ bạn xác nhận trên trình duyệt…',
  cancel: 'Hủy',
  chatgptSignIn: 'Đăng nhập ChatGPT',
  chatgptConnected: 'Đã kết nối',
  useChatgpt: 'Dùng ChatGPT cho trợ lý này',
  disconnect: 'Ngắt kết nối',
  chatgptReady: 'Xong rồi! Trợ lý giờ dùng gói ChatGPT của bạn, không tốn Proton.',
  chatgptFailed:
    'Chưa kết nối được. Nếu trang báo lỗi, hãy bật đăng nhập bằng mã thiết bị trong ChatGPT › Cài đặt › Bảo mật rồi thử lại nhé.',
  chatgptSignInAgain: 'Phiên đăng nhập ChatGPT trên Mac này đã hết nên trợ lý chưa trả lời được. Bấm Đăng nhập ChatGPT bên dưới để đăng nhập lại.',
  keysTitle: 'Khóa API',
  keysHelp: 'Dán khóa từ dịch vụ bạn trả phí. Dịch vụ tính phí trực tiếp cho bạn, và khóa chỉ lưu trên Mac này.',
  keyNames: { 'openai-api': 'OpenAI', gemini: 'Google AI Studio', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' },
  keySaved: 'Đã lưu khóa',
  keyMissing: 'Chưa có khóa',
  addKey: 'Thêm khóa',
  replaceKey: 'Thay khóa',
  keyLabel: service => `Khóa ${service}`,
  saveKey: 'Lưu khóa',
  whereKey: 'Lấy khóa ở đâu?',
  chooseModel: 'Chọn mô hình',
  localTitle: 'Mô hình trên máy',
  localHelp: 'Mở Ollama hoặc LM Studio trên Mac này và tải một mô hình trước. Rồi gõ đúng tên mô hình ở đây.',
  localApps: { ollama: 'Ollama', lmstudio: 'LM Studio' },
  localModel: 'Tên mô hình',
  localModelExample: 'ví dụ llama3.2',
  connectLocal: 'Kết nối',
  inUse: 'Đang dùng',
  advancedTitle: 'Tất cả dịch vụ (nâng cao)',
  advancedHelp: 'Mọi dịch vụ mà hệ thống hỗ trợ, dành cho người biết rõ mình cần gì.',
  advancedWarning:
    'Trang này dành cho người dùng nâng cao. Cài đặt ở đây có thể khiến trợ lý ngừng trả lời, và một số dịch vụ có thể không cho dùng gói của họ trong ứng dụng khác.',
  back: 'Quay lại Kết nối',
  working: 'Đang xử lý…',
  applied: 'Đã lưu.',
  cancelled: 'Không có gì thay đổi.',
  failed: 'Chưa được. Kiểm tra kết nối mạng rồi thử lại nhé.',
  busy: 'Trợ lý đang bận. Thử lại sau một chút nhé.',
  loadFailed: 'Chưa tải được các kết nối.',
  retry: 'Thử lại'
}

const ja: ConnectionsCopy = {
  title: '接続',
  close: '接続を閉じる',
  scope: agent => `この Mac · ${agent}`,
  intro: 'アシスタントに自分のプランやモデルを使わせます。',
  usingAtum: 'Atum の AI で回答中',
  usingConnection: name => `${name} で回答中`,
  backToAtum: 'Atum の AI に戻す',
  chatgptTitle: 'あなたの ChatGPT プラン',
  chatgptHelp: 'ChatGPT Plus または Pro のプランを使います。Proton は使いません。',
  chatgptNote:
    'OpenAI はまだ Atum のようなアプリでのこのサインインを承認していないため、アカウントが制限される小さなリスクがあります。',
  chatgptSteps: [
    'ChatGPT の 設定 › セキュリティ で「デバイスコードでのサインイン」がオフならオンにします。',
    '「コードを取得」を押すと、Atum が OpenAI のサインインページを開きます。',
    'ここに表示されたコードを入力して確認します。',
    'ここに戻ってください。Atum が自動で完了します。'
  ],
  getCode: 'コードを取得',
  codeLabel: 'あなたのコード',
  copyCode: 'コードをコピー',
  openPage: 'サインインページをもう一度開く',
  waiting: 'ブラウザでの確認を待っています…',
  cancel: 'キャンセル',
  chatgptSignIn: 'ChatGPT にサインイン',
  chatgptConnected: '接続済み',
  useChatgpt: 'このアシスタントで ChatGPT を使う',
  disconnect: '接続を解除',
  chatgptReady: '完了しました。アシスタントは Proton を使わず、あなたの ChatGPT プランで回答します。',
  chatgptFailed:
    'うまくいきませんでした。ページで拒否された場合は、ChatGPT › 設定 › セキュリティ でデバイスコードでのサインインをオンにしてから、もう一度お試しください。',
  chatgptSignInAgain: 'この Mac での ChatGPT のサインインが切れたため、このアシスタントは応答できません。下の「ChatGPT にサインイン」から、もう一度サインインしてください。',
  keysTitle: 'API キー',
  keysHelp: '有料で使っているサービスのキーを貼り付けます。料金はそのサービスから直接請求され、キーはこの Mac にだけ保存されます。',
  keyNames: { 'openai-api': 'OpenAI', gemini: 'Google AI Studio', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' },
  keySaved: 'キー保存済み',
  keyMissing: 'キーなし',
  addKey: 'キーを追加',
  replaceKey: 'キーを置き換える',
  keyLabel: service => `${service} のキー`,
  saveKey: 'キーを保存',
  whereKey: 'キーはどこで取得できますか？',
  chooseModel: 'モデルを選ぶ',
  localTitle: 'この Mac 上のモデル',
  localHelp: 'まずこの Mac で Ollama か LM Studio を開いてモデルをダウンロードし、ここにその名前を入力してください。',
  localApps: { ollama: 'Ollama', lmstudio: 'LM Studio' },
  localModel: 'モデル名',
  localModelExample: '例: llama3.2',
  connectLocal: '接続',
  inUse: '使用中',
  advancedTitle: 'すべてのサービス（詳細）',
  advancedHelp: 'エンジンが対応するすべてのサービス。必要なものがわかっている方向けです。',
  advancedWarning:
    'このページは上級者向けです。ここでの設定によりアシスタントが回答しなくなることがあり、一部のサービスは他のアプリでのプラン利用を認めていない場合があります。',
  back: '接続に戻る',
  working: '処理中…',
  applied: '保存しました。',
  cancelled: '何も変更されていません。',
  failed: 'うまくいきませんでした。接続を確認して、もう一度お試しください。',
  busy: 'アシスタントは処理中です。少し待ってからお試しください。',
  loadFailed: '接続を読み込めませんでした。',
  retry: 'もう一度試す'
}

const zh: ConnectionsCopy = {
  title: '连接',
  close: '关闭连接',
  scope: agent => `这台 Mac · ${agent}`,
  intro: '让助理使用你自己的方案或模型。',
  usingAtum: '正在用 Atum 的 AI 回答',
  usingConnection: name => `正在用 ${name} 回答`,
  backToAtum: '改回 Atum 的 AI',
  chatgptTitle: '你的 ChatGPT 方案',
  chatgptHelp: '使用你的 ChatGPT Plus 或 Pro 方案。不使用 Proton。',
  chatgptNote: 'OpenAI 尚未正式批准 Atum 这类应用使用此登录方式，因此账户有小概率受到限制。',
  chatgptSteps: [
    '在 ChatGPT 的 设置 › 安全 中，如果“设备码登录”已关闭，请打开。',
    '点按“获取代码”，Atum 会打开 OpenAI 的登录页面。',
    '输入这里显示的代码并确认。',
    '回到这里，Atum 会自动完成。'
  ],
  getCode: '获取代码',
  codeLabel: '你的代码',
  copyCode: '复制代码',
  openPage: '再次打开登录页面',
  waiting: '正在等你在浏览器中确认…',
  cancel: '取消',
  chatgptSignIn: '登录 ChatGPT',
  chatgptConnected: '已连接',
  useChatgpt: '让这个助理使用 ChatGPT',
  disconnect: '断开连接',
  chatgptReady: '完成了！助理现在使用你的 ChatGPT 方案，不消耗 Proton。',
  chatgptFailed: '没有成功。如果页面拒绝，请在 ChatGPT › 设置 › 安全 中打开设备码登录，然后再试一次。',
  chatgptSignInAgain: '这台 Mac 上的 ChatGPT 登录已失效，所以这个助理暂时无法回答。请点下方的“登录 ChatGPT”重新登录。',
  keysTitle: 'API 密钥',
  keysHelp: '粘贴你付费服务的密钥。费用由该服务直接向你收取，密钥只保存在这台 Mac 上。',
  keyNames: { 'openai-api': 'OpenAI', gemini: 'Google AI Studio', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' },
  keySaved: '已保存密钥',
  keyMissing: '还没有密钥',
  addKey: '添加密钥',
  replaceKey: '更换密钥',
  keyLabel: service => `${service} 密钥`,
  saveKey: '保存密钥',
  whereKey: '在哪里获取密钥？',
  chooseModel: '选择模型',
  localTitle: '这台 Mac 上的模型',
  localHelp: '先在这台 Mac 上打开 Ollama 或 LM Studio 并下载一个模型，然后在这里输入它的名称。',
  localApps: { ollama: 'Ollama', lmstudio: 'LM Studio' },
  localModel: '模型名称',
  localModelExample: '例如 llama3.2',
  connectLocal: '连接',
  inUse: '使用中',
  advancedTitle: '所有服务（高级）',
  advancedHelp: '引擎支持的所有服务，适合清楚自己需要什么的人。',
  advancedWarning: '此页面供高级用户使用。这里的设置可能导致助理停止回答，部分服务也可能不允许在其他应用中使用其方案。',
  back: '返回连接',
  working: '正在处理…',
  applied: '已保存。',
  cancelled: '没有任何更改。',
  failed: '没有成功。请检查网络后再试一次。',
  busy: '助理正忙，请稍后再试。',
  loadFailed: '无法载入你的连接。',
  retry: '再试一次'
}

const zhHant: ConnectionsCopy = {
  title: '連接',
  close: '關閉連接',
  scope: agent => `這台 Mac · ${agent}`,
  intro: '讓助理使用你自己的方案或模型。',
  usingAtum: '正在用 Atum 的 AI 回答',
  usingConnection: name => `正在用 ${name} 回答`,
  backToAtum: '改回 Atum 的 AI',
  chatgptTitle: '你的 ChatGPT 方案',
  chatgptHelp: '使用你的 ChatGPT Plus 或 Pro 方案。不使用 Proton。',
  chatgptNote: 'OpenAI 尚未正式核准 Atum 這類應用程式使用此登入方式，因此帳戶有小機率受到限制。',
  chatgptSteps: [
    '在 ChatGPT 的 設定 › 安全性 中，如果「裝置代碼登入」已關閉，請開啟。',
    '點按「取得代碼」，Atum 會開啟 OpenAI 的登入頁面。',
    '輸入這裡顯示的代碼並確認。',
    '回到這裡，Atum 會自動完成。'
  ],
  getCode: '取得代碼',
  codeLabel: '你的代碼',
  copyCode: '複製代碼',
  openPage: '再次開啟登入頁面',
  waiting: '正在等你在瀏覽器中確認…',
  cancel: '取消',
  chatgptSignIn: '登入 ChatGPT',
  chatgptConnected: '已連接',
  useChatgpt: '讓這個助理使用 ChatGPT',
  disconnect: '中斷連接',
  chatgptReady: '完成了！助理現在使用你的 ChatGPT 方案，不消耗 Proton。',
  chatgptFailed: '沒有成功。如果頁面拒絕，請在 ChatGPT › 設定 › 安全性 中開啟裝置代碼登入，然後再試一次。',
  chatgptSignInAgain: '這台 Mac 上的 ChatGPT 登入已失效，所以這個助理暫時無法回答。請點下方的「登入 ChatGPT」重新登入。',
  keysTitle: 'API 金鑰',
  keysHelp: '貼上你付費服務的金鑰。費用由該服務直接向你收取，金鑰只儲存在這台 Mac 上。',
  keyNames: { 'openai-api': 'OpenAI', gemini: 'Google AI Studio', anthropic: 'Anthropic API', openrouter: 'OpenRouter', 'opencode-go': 'OpenCode Go' },
  keySaved: '已儲存金鑰',
  keyMissing: '還沒有金鑰',
  addKey: '新增金鑰',
  replaceKey: '更換金鑰',
  keyLabel: service => `${service} 金鑰`,
  saveKey: '儲存金鑰',
  whereKey: '在哪裡取得金鑰？',
  chooseModel: '選擇模型',
  localTitle: '這台 Mac 上的模型',
  localHelp: '先在這台 Mac 上開啟 Ollama 或 LM Studio 並下載一個模型，然後在這裡輸入它的名稱。',
  localApps: { ollama: 'Ollama', lmstudio: 'LM Studio' },
  localModel: '模型名稱',
  localModelExample: '例如 llama3.2',
  connectLocal: '連接',
  inUse: '使用中',
  advancedTitle: '所有服務（進階）',
  advancedHelp: '引擎支援的所有服務，適合清楚自己需要什麼的人。',
  advancedWarning: '此頁面供進階使用者使用。這裡的設定可能導致助理停止回答，部分服務也可能不允許在其他應用程式中使用其方案。',
  back: '返回連接',
  working: '正在處理…',
  applied: '已儲存。',
  cancelled: '沒有任何變更。',
  failed: '沒有成功。請檢查網路後再試一次。',
  busy: '助理正忙，請稍後再試。',
  loadFailed: '無法載入你的連接。',
  retry: '再試一次'
}

export const connectionsCopy: Record<Locale, ConnectionsCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }
