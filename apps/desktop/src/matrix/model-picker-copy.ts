import { type Locale, useI18n } from '@/i18n'

import type { MatrixConnectedModelProblem, MatrixEffort } from '../../shared/matrix-models'
import type { MatrixShelfRetention } from '../../shared/matrix-shelf-models'

/**
 * The model picker's words. Vietnamese first: short, warm, no "reasoning", "provider" or
 * "token". The picker names whose model changes: a connected route is this assistant on this
 * Mac, Atum's own model is this conversation, and a cloud model belongs to the assistant in the
 * cloud. A connection the person made never mentions Protons. An OpenRouter shelf model is paid
 * in Protons, so its row shows its price, and only its tooltip names the unit (a million tokens).
 */
interface ModelPickerCopy {
  /** The three Atum lineup descriptors shown beneath their model names. */
  taglines: Record<'everyday' | 'hard' | 'flagship', string>
  effort: string
  efforts: Record<MatrixEffort, string>
  effortHelp: Record<MatrixEffort, string>
  /** Under Kỹ, for Atum's models only. */
  effortProtons: string
  connected: string
  atumProvider: string
  thisAssistant: string
  backToAtum: string
  connections: string
  connectionsHelp: string
  /** The plain menu's heading, above Atum's models. */
  answersWith: (assistant?: string) => string
  /** The plain menu's last row: sign in to a plan the person already pays for. Kept for the phone
   * export (phone-chat-keys.json); the desktop's plain menu now names ChatGPT (`useChatGpt`). */
  useSubscription: string
  /** The plain menu's last row when ChatGPT is not connected: it starts the ChatGPT sign-in. */
  useChatGpt: string
  /** A connected ChatGPT plan a cloud assistant cannot reach yet (its sign-in lives on this Mac). */
  chatgptCloudNotReady: string
  /** The row under those not-ready models: ChatGPT's state and its one fix, in Settings. */
  chatgptOpenSettings: string
  /** The model line under the thinking level, and the list it opens. */
  chooseModel: string
  modelsLoading: string
  modelsFailed: string
  modelsUnavailable: string
  modelsRetry: string
  modelsOnlyOne: string
  modelsSignedOut: string
  modelsMore: string
  /** Why a switch of a connected model did not happen; nothing changed in each case. */
  switchProblem: Record<MatrixConnectedModelProblem, string>
  /** The card's top section: Atum's own models and every starred model. */
  defaultsAndFavorites: string
  favorites: string
  modelSources: string
  /** Beside the model that answers when nothing else is chosen. */
  badgeDefault: string
  /** The account subscriptions group and its connect row (2026-10-27). */
  subscriptions: string
  connectChatGpt: string
  connectOpencode: string
  /** A cloud agent's OpenCode Go connection lapsed: the row leads back to Settings. */
  reconnectOpencode: string
  /** The group heading when ChatGPT is the one plan listing models here. */
  yourChatGpt: string
  /** A saved ChatGPT sign-in that stopped working: one line, then one Reconnect row. */
  chatgptSignedOut: string
  reconnectChatGpt: string
  /** One row when neither plan is connected: it leads to Settings › Advanced › Subscriptions. */
  useYourPlan: string
  /** The bar pinned at the card's foot: search, and the filter button's menu. */
  searchPlaceholder: string
  filter: string
  filterWith(summary: string): string
  favoritesOnly: string
  accountFilter: string
  allConnections: string
  signInAgain: string
  modelList: string
  current: string
  favorite: string
  unfavorite: string
  favoritesEmpty: string
  noMatches: string
  clearSearch: string
  noModels: string
  needsSignIn(names: string): string
  planAccount: (provider: string) => string
  keyAccount: string
  thisMac: string
  /** Exactly what a pick changes. */
  changesAssistant(agent: string): string
  changesConversation: string
  changesCloudAssistant: string
  /** Read only by the phone, until it reads changesCloudAssistant; then delete. */
  cloudAtumOnly: string
  /** Destination copy used as the Atum/provider rail moves between cloud and this Mac. */
  cloud: string
  /** A saved level the chosen model does not advertise. */
  effortUnsupported(level: string): string
  effortNoLevels(level: string): string
  useEffort(level: string): string
  effortReconciled(level: string): string
  effortReconcileFailed: string
  switchRefused: string
  /** An OpenRouter shelf row's price line: Protons per million tokens read / written. */
  shelfPrice(input: string, output: string): string
  /** The same price in full, in the row's tooltip. */
  shelfPriceDetail(input: string, output: string): string
  /** Beside a shelf model that costs more than Nhật Thực: a label, never a confirmation. */
  shelfCostly: string
  shelfCostlyDetail: string
  /** What the provider keeps, in the tooltip. Training is never allowed. */
  shelfRetention: Record<MatrixShelfRetention, string>
}

const en: ModelPickerCopy = {
  taglines: {
    everyday: 'Good for everyday tasks',
    hard: 'Good for hard tasks',
    flagship: 'The most powerful model'
  },
  effort: 'Thinking',
  efforts: { low: 'Quick', medium: 'Balanced', high: 'Thorough' },
  effortHelp: {
    low: 'Answers fast, for simple things.',
    medium: 'Right for most things.',
    high: 'Takes longer and thinks harder.'
  },
  effortProtons: 'Thinking longer uses more Protons.',
  connected: 'Your connection · no Protons used',
  atumProvider: 'Atum',
  thisAssistant: 'this assistant',
  backToAtum: 'Switch back to Atum’s AI',
  connections: 'Connections…',
  connectionsHelp: 'Use your ChatGPT or OpenCode Go plan.',
  answersWith: (assistant?: string) => (assistant ? `${assistant} answers with` : 'Answers with'),
  useSubscription: 'Use a subscription you pay for',
  useChatGpt: 'Use your ChatGPT subscription',
  chatgptCloudNotReady: 'Not ready for your assistants yet',
  chatgptOpenSettings: 'Open ChatGPT in Settings',
  chooseModel: 'Choose a model',
  modelsLoading: 'Loading models…',
  modelsFailed: 'Couldn’t load this connection’s models.',
  modelsUnavailable: 'Couldn’t reach this assistant’s connections. Check Connections and try again.',
  modelsRetry: 'Try again',
  modelsOnlyOne: 'No other models on this connection.',
  modelsSignedOut: 'This connection needs you to sign in again.',
  modelsMore: 'All models in Connections…',
  switchProblem: {
    busy: 'Your assistant is busy. Try again in a moment.',
    unavailable: 'Couldn’t choose this model for this assistant right now.',
    failed: 'Couldn’t switch the model. Please try again.'
  },
  defaultsAndFavorites: 'Defaults & favorites',
  favorites: 'Favorites',
  modelSources: 'Model families',
  badgeDefault: 'Default',
  subscriptions: 'Subscriptions',
  connectChatGpt: 'Connect ChatGPT',
  connectOpencode: 'Connect OpenCode Go',
  reconnectOpencode: 'Reconnect OpenCode Go',
  yourChatGpt: 'Your ChatGPT',
  chatgptSignedOut: 'ChatGPT needs you to sign in again.',
  reconnectChatGpt: 'Reconnect ChatGPT',
  useYourPlan: 'Use your ChatGPT or OpenCode plan',
  searchPlaceholder: 'Search models…',
  filter: 'Filter',
  filterWith: summary => `Filter: ${summary}`,
  favoritesOnly: 'Favorites only',
  accountFilter: 'Filter by connection',
  allConnections: 'All connections',
  signInAgain: 'Sign in again',
  modelList: 'Models',
  current: 'Current',
  favorite: 'Add to favorites',
  unfavorite: 'Remove from favorites',
  favoritesEmpty: 'No favorite models yet. Star one to find it here.',
  noMatches: 'No models match this search.',
  clearSearch: 'Clear search',
  noModels: 'No models are available through this assistant’s connections.',
  needsSignIn: names => `Sign in again for ${names} in Connections.`,
  planAccount: provider => `${provider} plan`,
  keyAccount: 'API key',
  thisMac: 'This Mac',
  changesAssistant: agent => `${agent} on this Mac`,
  changesConversation: 'This conversation only',
  changesCloudAssistant: 'This assistant',
  cloudAtumOnly: 'This assistant',
  cloud: 'Cloud',
  effortUnsupported: level => `This model doesn’t offer ${level}. Choose a level it supports.`,
  effortNoLevels: level => `This model sets its own thinking level; your saved ${level} does not apply.`,
  useEffort: level => `Use ${level}`,
  effortReconciled: level => `Thinking is now ${level} for this model.`,
  effortReconcileFailed: 'The model changed, but its thinking level could not be updated.',
  switchRefused: 'Couldn’t change the model.',
  shelfPrice: (input, output) => `${input} / ${output} Protons`,
  shelfPriceDetail: (input, output) =>
    `Per million tokens: ${input} Protons to read, ${output} Protons to write.`,
  shelfCostly: 'Costs more',
  shelfCostlyDetail: 'Uses more Protons than Nhật Thực.',
  shelfRetention: {
    zero_data_retention: 'Not stored and never used for training.',
    safety_retention: 'Never used for training; kept briefly for safety checks.',
    provider_policy: 'Never used for training.'
  }
}

const vi: ModelPickerCopy = {
  taglines: {
    everyday: 'Phù hợp tác vụ hàng ngày',
    hard: 'Phù hợp với tác vụ khó khăn',
    flagship: 'Mô hình quyền năng nhất'
  },
  effort: 'Mức suy nghĩ',
  efforts: { low: 'Nhanh', medium: 'Cân bằng', high: 'Kỹ' },
  effortHelp: {
    low: 'Trả lời nhanh, hợp với việc đơn giản.',
    medium: 'Hợp với hầu hết mọi việc.',
    high: 'Lâu hơn một chút, suy nghĩ kỹ hơn.'
  },
  effortProtons: 'Suy nghĩ kỹ hơn sẽ dùng nhiều Proton hơn.',
  connected: 'Kết nối của bạn · không dùng Proton',
  atumProvider: 'Atum',
  thisAssistant: 'trợ lý này',
  backToAtum: 'Quay lại AI của Atum',
  connections: 'Kết nối…',
  connectionsHelp: 'Dùng gói ChatGPT hoặc OpenCode Go của bạn.',
  answersWith: (assistant?: string) => (assistant ? `${assistant} trả lời bằng` : 'Trả lời bằng'),
  useSubscription: 'Dùng gói đăng ký bạn đang trả',
  useChatGpt: 'Dùng gói ChatGPT của bạn',
  chatgptCloudNotReady: 'Trợ lý của bạn chưa dùng được',
  chatgptOpenSettings: 'Mở ChatGPT trong Cài đặt',
  chooseModel: 'Chọn mô hình',
  modelsLoading: 'Đang tải danh sách mô hình…',
  modelsFailed: 'Chưa tải được danh sách mô hình của kết nối này.',
  modelsUnavailable: 'Chưa kết nối được tới các kết nối của trợ lý. Bạn kiểm tra Kết nối rồi thử lại nhé.',
  modelsRetry: 'Thử lại',
  modelsOnlyOne: 'Kết nối này không có mô hình nào khác.',
  modelsSignedOut: 'Kết nối này cần bạn đăng nhập lại.',
  modelsMore: 'Xem tất cả trong Kết nối…',
  switchProblem: {
    busy: 'Trợ lý đang bận. Bạn thử lại sau chút nữa nhé.',
    unavailable: 'Chưa chọn được mô hình cho trợ lý này lúc này.',
    failed: 'Chưa đổi được mô hình. Bạn thử lại nhé.'
  },
  defaultsAndFavorites: 'Mặc định & yêu thích',
  favorites: 'Yêu thích',
  modelSources: 'Nhóm mô hình',
  badgeDefault: 'Mặc định',
  subscriptions: 'Gói đăng ký',
  connectChatGpt: 'Kết nối ChatGPT',
  connectOpencode: 'Kết nối OpenCode Go',
  reconnectOpencode: 'Kết nối lại OpenCode Go',
  yourChatGpt: 'ChatGPT của bạn',
  chatgptSignedOut: 'ChatGPT cần bạn đăng nhập lại.',
  reconnectChatGpt: 'Kết nối lại ChatGPT',
  useYourPlan: 'Dùng gói ChatGPT hoặc OpenCode của bạn',
  searchPlaceholder: 'Tìm mô hình…',
  filter: 'Lọc',
  filterWith: summary => `Lọc: ${summary}`,
  favoritesOnly: 'Chỉ yêu thích',
  accountFilter: 'Lọc theo kết nối',
  allConnections: 'Mọi kết nối',
  signInAgain: 'Đăng nhập lại',
  modelList: 'Mô hình',
  current: 'Đang dùng',
  favorite: 'Thêm vào yêu thích',
  unfavorite: 'Bỏ khỏi yêu thích',
  favoritesEmpty: 'Chưa có mô hình yêu thích. Bạn đánh dấu sao để tìm lại nhanh hơn.',
  noMatches: 'Không có mô hình nào khớp với tìm kiếm.',
  clearSearch: 'Xóa tìm kiếm',
  noModels: 'Chưa có mô hình nào dùng được qua các kết nối của trợ lý này.',
  needsSignIn: names => `Đăng nhập lại ${names} trong Kết nối.`,
  planAccount: provider => `Gói ${provider}`,
  keyAccount: 'Khóa API',
  thisMac: 'Máy này',
  changesAssistant: agent => `${agent} trên máy này`,
  changesConversation: 'Chỉ cuộc trò chuyện này',
  changesCloudAssistant: 'Trợ lý này',
  cloudAtumOnly: 'Trợ lý này',
  cloud: 'Đám mây',
  effortUnsupported: level => `Mô hình này không có mức ${level}. Bạn chọn một mức mà mô hình hỗ trợ nhé.`,
  effortNoLevels: level => `Mô hình này tự đặt mức suy nghĩ; mức ${level} bạn đã lưu không áp dụng.`,
  useEffort: level => `Dùng ${level}`,
  effortReconciled: level => `Mức suy nghĩ đã đổi sang ${level} cho mô hình này.`,
  effortReconcileFailed: 'Đã đổi mô hình nhưng chưa đổi được mức suy nghĩ.',
  switchRefused: 'Chưa đổi được mô hình.',
  shelfPrice: (input, output) => `${input} / ${output} Proton`,
  shelfPriceDetail: (input, output) => `Mỗi triệu token: đọc ${input} Proton, viết ${output} Proton.`,
  shelfCostly: 'Giá cao',
  shelfCostlyDetail: 'Tốn nhiều Proton hơn Nhật Thực.',
  shelfRetention: {
    zero_data_retention: 'Không lưu lại và không dùng để huấn luyện.',
    safety_retention: 'Không dùng để huấn luyện; lưu ngắn hạn để kiểm tra an toàn.',
    provider_policy: 'Không dùng để huấn luyện.'
  }
}

const ja: ModelPickerCopy = {
  taglines: {
    everyday: '日常のタスクに適しています',
    hard: '難しいタスクに適しています',
    flagship: '最も強力なモデル'
  },
  effort: '思考の深さ',
  efforts: { low: '速く', medium: 'バランス', high: 'じっくり' },
  effortHelp: {
    low: 'すばやく答えます。簡単なことに。',
    medium: 'たいていのことに合います。',
    high: '時間をかけて、よく考えます。'
  },
  effortProtons: 'じっくり考えるほど、Proton を多く使います。',
  connected: 'あなたの接続 · Proton は使いません',
  atumProvider: 'Atum',
  thisAssistant: 'このアシスタント',
  backToAtum: 'Atum の AI に戻す',
  connections: '接続…',
  connectionsHelp: 'ChatGPT または OpenCode Go のプランを使います。',
  answersWith: (assistant?: string) => (assistant ? `${assistant} が使うモデル` : '使うモデル'),
  useSubscription: '契約中のサブスクリプションを使う',
  useChatGpt: 'ChatGPT のサブスクリプションを使う',
  chatgptCloudNotReady: 'アシスタントではまだ使えません',
  chatgptOpenSettings: '設定で ChatGPT を開く',
  chooseModel: 'モデルを選ぶ',
  modelsLoading: 'モデルを読み込んでいます…',
  modelsFailed: 'この接続のモデルを読み込めませんでした。',
  modelsUnavailable: 'このアシスタントの接続に届きませんでした。接続を確認してもう一度お試しください。',
  modelsRetry: 'もう一度',
  modelsOnlyOne: 'この接続にはほかのモデルがありません。',
  modelsSignedOut: 'この接続はもう一度サインインが必要です。',
  modelsMore: 'すべてのモデルは「接続」で…',
  switchProblem: {
    busy: 'アシスタントは作業中です。少ししてからもう一度お試しください。',
    unavailable: '今はこのアシスタントにこのモデルを選べませんでした。',
    failed: 'モデルを切り替えられませんでした。もう一度お試しください。'
  },
  defaultsAndFavorites: 'デフォルトとお気に入り',
  favorites: 'お気に入り',
  modelSources: 'モデルの種類',
  badgeDefault: 'デフォルト',
  subscriptions: 'サブスクリプション',
  connectChatGpt: 'ChatGPT を接続',
  connectOpencode: 'OpenCode Go を接続',
  reconnectOpencode: 'OpenCode Go を再接続',
  yourChatGpt: 'あなたの ChatGPT',
  chatgptSignedOut: 'ChatGPT にもう一度サインインしてください。',
  reconnectChatGpt: 'ChatGPT を再接続',
  useYourPlan: 'ChatGPT または OpenCode Go のプランを使う',
  searchPlaceholder: 'モデルを検索…',
  filter: 'フィルター',
  filterWith: summary => `フィルター: ${summary}`,
  favoritesOnly: 'お気に入りのみ',
  accountFilter: '接続で絞り込む',
  allConnections: 'すべての接続',
  signInAgain: 'もう一度サインイン',
  modelList: 'モデル',
  current: '使用中',
  favorite: 'お気に入りに追加',
  unfavorite: 'お気に入りから削除',
  favoritesEmpty: 'お気に入りのモデルはまだありません。星を付けるとここに表示されます。',
  noMatches: '検索に一致するモデルがありません。',
  clearSearch: '検索をクリア',
  noModels: 'このアシスタントの接続で使えるモデルがありません。',
  needsSignIn: names => `${names} にもう一度サインインしてください。`,
  planAccount: provider => `${provider} のプラン`,
  keyAccount: 'API キー',
  thisMac: 'この Mac',
  changesAssistant: agent => `${agent}・この Mac`,
  changesConversation: 'この会話のみ',
  changesCloudAssistant: 'このアシスタント',
  cloudAtumOnly: 'このアシスタント',
  cloud: 'クラウド',
  effortUnsupported: level => `このモデルは「${level}」に対応していません。対応するレベルを選んでください。`,
  effortNoLevels: level => `このモデルは思考レベルを自分で決めます。保存した「${level}」は適用されません。`,
  useEffort: level => `「${level}」を使う`,
  effortReconciled: level => `このモデルの思考レベルを「${level}」に変更しました。`,
  effortReconcileFailed: 'モデルは変更されましたが、思考レベルを変更できませんでした。',
  switchRefused: 'モデルを変更できませんでした。',
  shelfPrice: (input, output) => `${input} / ${output} Proton`,
  shelfPriceDetail: (input, output) =>
    `100万トークンあたり：読み取り ${input} Proton、書き出し ${output} Proton。`,
  shelfCostly: '高価格',
  shelfCostlyDetail: 'Nhật Thực より多くの Proton を使います。',
  shelfRetention: {
    zero_data_retention: '保存されず、学習にも使われません。',
    safety_retention: '学習には使われません。安全確認のため短期間だけ保存されます。',
    provider_policy: '学習には使われません。'
  }
}

const zh: ModelPickerCopy = {
  taglines: {
    everyday: '适合日常任务',
    hard: '适合困难任务',
    flagship: '最强大的模型'
  },
  effort: '思考深度',
  efforts: { low: '快速', medium: '均衡', high: '深入' },
  effortHelp: {
    low: '回答快，适合简单的事。',
    medium: '适合大多数事情。',
    high: '花更多时间，想得更深入。'
  },
  effortProtons: '想得越深入，用的 Proton 越多。',
  connected: '你的连接 · 不使用 Proton',
  atumProvider: 'Atum',
  thisAssistant: '此助理',
  backToAtum: '改回 Atum 的 AI',
  connections: '连接…',
  connectionsHelp: '使用你的 ChatGPT 或 OpenCode Go 方案。',
  answersWith: (assistant?: string) => (assistant ? `${assistant} 使用的模型` : '使用的模型'),
  useSubscription: '使用你已付费的订阅',
  useChatGpt: '使用你的 ChatGPT 订阅',
  chatgptCloudNotReady: '你的助理暂时还不能使用',
  chatgptOpenSettings: '在设置中打开 ChatGPT',
  chooseModel: '选择模型',
  modelsLoading: '正在加载模型…',
  modelsFailed: '无法加载这个连接的模型。',
  modelsUnavailable: '无法连接到此助理的连接。请检查“连接”后重试。',
  modelsRetry: '重试',
  modelsOnlyOne: '这个连接没有其他模型。',
  modelsSignedOut: '这个连接需要你重新登录。',
  modelsMore: '在“连接”中查看全部…',
  switchProblem: {
    busy: '助理正在忙。请稍后再试。',
    unavailable: '目前无法为这个助理选择这个模型。',
    failed: '无法切换模型。请重试。'
  },
  defaultsAndFavorites: '默认与收藏',
  favorites: '收藏',
  modelSources: '模型系列',
  badgeDefault: '默认',
  subscriptions: '订阅',
  connectChatGpt: '连接 ChatGPT',
  connectOpencode: '连接 OpenCode Go',
  reconnectOpencode: '重新连接 OpenCode Go',
  yourChatGpt: '你的 ChatGPT',
  chatgptSignedOut: 'ChatGPT 需要你重新登录。',
  reconnectChatGpt: '重新连接 ChatGPT',
  useYourPlan: '使用你的 ChatGPT 或 OpenCode 方案',
  searchPlaceholder: '搜索模型…',
  filter: '筛选',
  filterWith: summary => `筛选：${summary}`,
  favoritesOnly: '仅看收藏',
  accountFilter: '按连接筛选',
  allConnections: '所有连接',
  signInAgain: '需要重新登录',
  modelList: '模型',
  current: '当前',
  favorite: '添加到收藏',
  unfavorite: '从收藏中移除',
  favoritesEmpty: '还没有收藏的模型。加星后可以在这里找到。',
  noMatches: '没有匹配的模型。',
  clearSearch: '清除搜索',
  noModels: '此助理的连接中没有可用模型。',
  needsSignIn: names => `请在“连接”中重新登录 ${names}。`,
  planAccount: provider => `${provider} 方案`,
  keyAccount: 'API 密钥',
  thisMac: '这台 Mac',
  changesAssistant: agent => `${agent} · 这台 Mac`,
  changesConversation: '仅此对话',
  changesCloudAssistant: '此助理',
  cloudAtumOnly: '此助理',
  cloud: '云端',
  effortUnsupported: level => `此模型不支持“${level}”。请选择它支持的级别。`,
  effortNoLevels: level => `此模型自行决定思考级别；已保存的“${level}”不会应用。`,
  useEffort: level => `使用“${level}”`,
  effortReconciled: level => `此模型的思考级别已改为“${level}”。`,
  effortReconcileFailed: '模型已更改，但无法更新思考级别。',
  switchRefused: '无法更改模型。',
  shelfPrice: (input, output) => `${input} / ${output} Proton`,
  shelfPriceDetail: (input, output) => `每百万 token：读取 ${input} Proton，写出 ${output} Proton。`,
  shelfCostly: '价格较高',
  shelfCostlyDetail: '比 Nhật Thực 用更多 Proton。',
  shelfRetention: {
    zero_data_retention: '不保存，也绝不用于训练。',
    safety_retention: '绝不用于训练；为安全检查短期保存。',
    provider_policy: '绝不用于训练。'
  }
}

const zhHant: ModelPickerCopy = {
  taglines: {
    everyday: '適合日常任務',
    hard: '適合困難任務',
    flagship: '最強大的模型'
  },
  effort: '思考深度',
  efforts: { low: '快速', medium: '均衡', high: '深入' },
  effortHelp: {
    low: '回答快，適合簡單的事。',
    medium: '適合大多數事情。',
    high: '花更多時間，想得更深入。'
  },
  effortProtons: '想得越深入，用的 Proton 越多。',
  connected: '你的連接 · 不使用 Proton',
  atumProvider: 'Atum',
  thisAssistant: '此助理',
  backToAtum: '改回 Atum 的 AI',
  connections: '連接…',
  connectionsHelp: '使用你的 ChatGPT 或 OpenCode Go 方案。',
  answersWith: (assistant?: string) => (assistant ? `${assistant} 使用的模型` : '使用的模型'),
  useSubscription: '使用你已付費的訂閱',
  useChatGpt: '使用你的 ChatGPT 訂閱',
  chatgptCloudNotReady: '你的助理暫時還不能使用',
  chatgptOpenSettings: '在設定中開啟 ChatGPT',
  chooseModel: '選擇模型',
  modelsLoading: '正在載入模型…',
  modelsFailed: '無法載入這個連接的模型。',
  modelsUnavailable: '無法連接至此助理的連接。請檢查「連接」後重試。',
  modelsRetry: '重試',
  modelsOnlyOne: '這個連接沒有其他模型。',
  modelsSignedOut: '這個連接需要你重新登入。',
  modelsMore: '在「連接」中查看全部…',
  switchProblem: {
    busy: '助理正在忙。請稍後再試。',
    unavailable: '目前無法為這個助理選擇這個模型。',
    failed: '無法切換模型。請重試。'
  },
  defaultsAndFavorites: '預設與收藏',
  favorites: '收藏',
  modelSources: '模型系列',
  badgeDefault: '預設',
  subscriptions: '訂閱',
  connectChatGpt: '連接 ChatGPT',
  connectOpencode: '連接 OpenCode Go',
  reconnectOpencode: '重新連接 OpenCode Go',
  yourChatGpt: '你的 ChatGPT',
  chatgptSignedOut: 'ChatGPT 需要你重新登入。',
  reconnectChatGpt: '重新連接 ChatGPT',
  useYourPlan: '使用你的 ChatGPT 或 OpenCode 方案',
  searchPlaceholder: '搜尋模型…',
  filter: '篩選',
  filterWith: summary => `篩選：${summary}`,
  favoritesOnly: '僅看收藏',
  accountFilter: '依連接篩選',
  allConnections: '所有連接',
  signInAgain: '需要重新登入',
  modelList: '模型',
  current: '目前',
  favorite: '加入收藏',
  unfavorite: '從收藏移除',
  favoritesEmpty: '還沒有收藏的模型。加上星號後可以在這裡找到。',
  noMatches: '沒有符合的模型。',
  clearSearch: '清除搜尋',
  noModels: '此助理的連接中沒有可用模型。',
  needsSignIn: names => `請在「連接」中重新登入 ${names}。`,
  planAccount: provider => `${provider} 方案`,
  keyAccount: 'API 金鑰',
  thisMac: '這台 Mac',
  changesAssistant: agent => `${agent} · 這台 Mac`,
  changesConversation: '僅此對話',
  changesCloudAssistant: '此助理',
  cloudAtumOnly: '此助理',
  cloud: '雲端',
  effortUnsupported: level => `此模型不支援「${level}」。請選擇它支援的等級。`,
  effortNoLevels: level => `此模型自行決定思考等級；已儲存的「${level}」不會套用。`,
  useEffort: level => `使用「${level}」`,
  effortReconciled: level => `此模型的思考等級已改為「${level}」。`,
  effortReconcileFailed: '模型已變更，但無法更新思考等級。',
  switchRefused: '無法變更模型。',
  shelfPrice: (input, output) => `${input} / ${output} Proton`,
  shelfPriceDetail: (input, output) => `每百萬 token：讀取 ${input} Proton，寫出 ${output} Proton。`,
  shelfCostly: '價格較高',
  shelfCostlyDetail: '比 Nhật Thực 用更多 Proton。',
  shelfRetention: {
    zero_data_retention: '不保存，也絕不用於訓練。',
    safety_retention: '絕不用於訓練；為安全檢查短期保存。',
    provider_policy: '絕不用於訓練。'
  }
}

const COPY: Record<Locale, ModelPickerCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function useModelPickerCopy(): ModelPickerCopy {
  return COPY[useI18n().locale]
}
