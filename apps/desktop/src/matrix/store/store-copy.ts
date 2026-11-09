import type { MatrixStoreKind } from '../../../shared/matrix-store'

export type StoreLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

export interface MatrixStoreCopy {
  title: string
  discover: string
  subtitle: string
  search: string
  featured: string
  agents: string
  skills: string
  pets: string
  apps: string
  purchased: string
  gift: string
  gifts: string
  visiting: string
  /** The Hatch card's once-per-account price, as a short label beside it. */
  firstHatch: string
  /** Read before the struck-through regular price; screen readers do not announce the strike. */
  regularPrice: string
  /** Under the Hatch item: the lower price is for the account's first hatch only. */
  firstHatchNote: string
  /** The Hatch card's line under its summary: a pet is made from words or from a photo. */
  hatchFromPhoto: string
  /** In the Hatch item: how a hatch is made, from a description or a photo of a real pet. */
  hatchHow: string
  /** In the Hatch item, hatching in the companion's hatch panel: when the price is charged. */
  hatchChargedOnHatch: string
  /** In the Hatch item, with a hatch credit held: hatching uses it. */
  hatchCreditReady: string
  /** The Hatch item's button: opens the companion's hatch panel. */
  hatchPet: string
  /** The Hatch item's primary path: open the native photo picker immediately. */
  hatchChoosePhoto: string
  /** The Hatch item's secondary path: start with a written description. */
  hatchDescribe: string
  /** One item's kind, as the eyebrow over a Featured card. */
  kind: Record<MatrixStoreKind, string>
  owned: string
  /** Owned by these assistants: "Owned · Atum". */
  ownedBy: (names: string) => string
  unavailable: string
  free: string
  protons: string
  monthly: string
  /** A monthly hire that renews at a different price: its first month, then every month after. */
  monthlyFirst: (first: string) => string
  monthlyFreeFirst: string
  monthlyThen: (renewal: string) => string
  loading: string
  stale: string
  retry: string
  empty: string
  /** The Assistants shelf while no assistant is on sale yet: a short heading… */
  agentsSoon: string
  /** …and one plain sentence under it. */
  agentsSoonNote: string
  storeUnavailable: string
  appsUnavailable: string
  purchasedEmpty: string
  targetAgent: string
  noTargetAgent: string
  /** Paid content reaches the model only through Atum's AI: an assistant on its own model
   * can't be taught it. */
  needsAtumAi: string
  add: string
  /** A free official skill: the Skills Hub installs it, with its own scan and confirmation. */
  installFromHub: string
  /** The chosen assistant already has that skill. */
  installed: string
  adopt: string
  hire: string
  buy: string
  tryNow: string
  get: string
  open: string
  close: string
  moreInfo: string
  itemByAtum: (kind: string) => string
  whatItUses: string
  trySaying: string
  addsTo: (name: string) => string
  getFor: (price: string) => string
  /** Catalog requirement tokens in words; a token this build does not know is not shown. */
  requirements: Record<string, string>
  tryExample: (value: string) => string
  balance: (amount: string) => string
  balanceLabel: string
  topUp: string
  back: string
  continue: string
  purchasePending: string
  purchaseCompleted: string
  alreadyOwned: string
  offerChanged: string
  /** A definite refusal: what did not happen (by the item's kind), that nothing was charged,
   * and to try again later. Without a kind (a purchase checked from Purchased) it says "purchase". */
  refused: (kind?: MatrixStoreKind) => string
  /** The same for a refusal over too few Protons, whose next step is a top-up. */
  refusedShort: (kind?: MatrixStoreKind) => string
  /** Beside the balance when it is below today's price: how many more Protons are needed. */
  shortfall: (amount: string) => string
  purchaseUncertain: string
  purchaseFailed: string
  checkPurchase: string
  pendingPurchases: string
  purchaseInProgress: string
  cancelMonthly: string
  cancelling: string
  cancelled: string
  renews: (date: string) => string
  lapsed: string
  revoked: string
  searchEmpty: string
  listingMissing: string
  discoverLine: (kind: string, summary: string) => string
  itemAction: (action: string, title: string) => string
  hireRenewalConsent: (renewal: string) => string
  hireInitialPrice: (initial: string) => string
  hireRenewalPrice: (renewal: string) => string
  hireConsentRequired: string
  checkoutLoading: string
  checkoutUnavailable: string
  checkoutBuy: string
  checkoutSave: (percent: number) => string
  checkoutCreating: string
  checkoutPending: string
  checkoutChangePack: string
  checkoutPaid: (amount: string) => string
  checkoutPaidBalance: (amount: string) => string
  checkoutReceived: string
  checkoutExpired: string
  checkoutCancelled: string
  checkoutChooseAnother: string
  checkoutBackToStore: string
  checkoutRecover: string
  checkoutResume: string
  checkoutFailed: string
  checkoutCurrency: string
}

/** What did not happen, by the item's kind; `other` when the kind is not known. */
type NotDone = Record<MatrixStoreKind | 'other', string>

function notDone(phrases: NotDone, kind: MatrixStoreKind | undefined): string {
  return (kind && phrases[kind]) || phrases.other
}

const EN_NOT_DONE: NotDone = {
  agent: 'The hire didn’t go through',
  skill: 'The skill wasn’t added',
  pet: 'The adoption didn’t go through',
  other: 'The purchase didn’t go through'
}

const VI_NOT_DONE: NotDone = {
  agent: 'Chưa thuê được',
  skill: 'Chưa thêm được kỹ năng',
  pet: 'Chưa nhận nuôi được',
  other: 'Chưa mua được'
}

const JA_NOT_DONE: NotDone = {
  agent: 'アシスタントを雇えませんでした',
  skill: 'スキルを追加できませんでした',
  pet: 'ペットを迎えられませんでした',
  other: '購入できませんでした'
}

const ZH_NOT_DONE: NotDone = { agent: '未能雇用助手', skill: '未能添加技能', pet: '未能领养宠物', other: '未能购买' }

const ZH_HANT_NOT_DONE: NotDone = {
  agent: '未能聘用助理',
  skill: '未能新增技能',
  pet: '未能領養寵物',
  other: '未能購買'
}

const en: MatrixStoreCopy = {
  title: 'Store',
  discover: 'Discover',
  subtitle: 'Skills, assistants and apps that give Atum new abilities.',
  search: 'Search the store',
  featured: 'Featured',
  agents: 'Assistants',
  skills: 'Skills',
  pets: 'Pets',
  apps: 'Apps',
  purchased: 'Purchased',
  gift: 'Gift',
  gifts: 'Gifts',
  visiting: 'Visiting',
  firstHatch: 'First hatch',
  regularPrice: 'Regular price',
  firstHatchNote: 'Your first hatch costs less. Every hatch after it is the regular price.',
  hatchFromPhoto: 'Describe a pet, or use a photo of your own.',
  hatchHow:
    'Have a pet at home? Use a photo of it, and Atum copies its colours and markings. Or describe the pet you want in a few words.',
  hatchChargedOnHatch: 'Pay only when you hatch your chosen draft.',
  hatchCreditReady: 'A hatch credit covers your chosen draft.',
  hatchPet: 'Hatch your pet',
  hatchChoosePhoto: 'Choose a photo',
  hatchDescribe: 'Describe instead',
  kind: { skill: 'Skill', agent: 'Assistant', pet: 'Pet' },
  owned: 'Owned',
  ownedBy: names => `Owned · ${names}`,
  unavailable: 'Unavailable',
  free: 'Free',
  protons: 'Protons',
  monthly: '/ month',
  monthlyFirst: first => `${first} Protons first month`,
  monthlyFreeFirst: 'Free first month',
  monthlyThen: renewal => `then ${renewal}/mo`,
  loading: 'Loading store…',
  stale: 'Showing the store as it was last time.',
  retry: 'Try again',
  empty: 'Nothing here yet.',
  agentsSoon: 'Coming soon',
  agentsSoonNote: 'Assistants you can hire will appear here.',
  storeUnavailable: 'The store can’t load right now. Try again in a minute.',
  appsUnavailable: 'Apps couldn’t load.',
  purchasedEmpty: 'You haven’t bought anything yet.',
  targetAgent: 'Add to assistant',
  noTargetAgent: 'There’s no assistant to add this skill to yet.',
  needsAtumAi: 'Only assistants on Atum’s AI can use this. One on its own model isn’t listed.',
  add: 'Add skill',
  installFromHub: 'Install from Skills Hub',
  installed: 'Installed',
  adopt: 'Adopt',
  hire: 'Hire',
  buy: 'Buy',
  tryNow: 'Try it now',
  get: 'Get',
  open: 'Open',
  close: 'Close',
  moreInfo: 'More information',
  itemByAtum: kind => `${kind} · by Atum`,
  whatItUses: 'What it uses',
  trySaying: 'Try saying',
  addsTo: name => `Adds to ${name}.`,
  getFor: price => `Get · ${price}`,
  requirements: { internet: 'Needs internet', 'runs-scripts': 'Runs commands on your Mac' },
  tryExample: value => `Try: ${value}`,
  balance: amount => `You have ${amount} Protons`,
  balanceLabel: 'Your Protons',
  topUp: 'Top up',
  back: 'Back',
  continue: 'Continue',
  purchasePending: 'Bought. Atum is getting it ready…',
  purchaseCompleted: 'Done. It’s ready to use.',
  alreadyOwned: 'You already have this.',
  offerChanged: 'The price just changed. Check it and try again.',
  refused: kind => `${notDone(EN_NOT_DONE, kind)}. You weren’t charged. Try again later.`,
  refusedShort: kind =>
    `${notDone(EN_NOT_DONE, kind)}: you don’t have enough Protons. You weren’t charged. Top up, then try again.`,
  shortfall: amount => `You need ${amount} more Protons`,
  purchaseUncertain:
    'The Store hasn’t answered yet, so we don’t know if your Protons were used. Check Purchased in a minute: if it went through, it will be there; if not, you aren’t charged.',
  purchaseFailed: 'That didn’t work. Try again.',
  checkPurchase: 'Check',
  pendingPurchases: 'In progress',
  purchaseInProgress: 'Purchase in progress',
  cancelMonthly: 'Cancel monthly hire',
  cancelling: 'Cancelling…',
  cancelled: 'Cancelled',
  renews: date => `Renews ${date}`,
  lapsed: 'Lapsed',
  revoked: 'Revoked',
  searchEmpty: 'Nothing matches your search.',
  listingMissing: 'The recommended listing is no longer in the current catalog.',
  discoverLine: (kind, summary) => `${kind} · ${summary}`,
  itemAction: (action, title) => `${action}: ${title}`,
  hireRenewalConsent: renewal => `I agree to renew at ${renewal}.`,
  hireInitialPrice: initial => `Today: ${initial}`,
  hireRenewalPrice: renewal => `Then: ${renewal} each month`,
  hireConsentRequired: 'Tick the box to agree to the monthly renewal.',
  checkoutLoading: 'Loading top-ups…',
  checkoutUnavailable: 'Top-ups aren’t available right now. Try again in a minute.',
  checkoutBuy: 'Buy',
  checkoutSave: percent => `Save ${percent}%`,
  checkoutCreating: 'Preparing your QR code…',
  checkoutPending: 'Scan with your banking app. Atum updates by itself once the payment arrives.',
  checkoutChangePack: 'Want a different pack? Wait for this code to expire.',
  checkoutPaid: amount => `Top-up complete: ${amount} Protons added.`,
  checkoutPaidBalance: amount => `Balance: ${amount} Protons`,
  checkoutReceived: 'Payment received. Your Protons will arrive in a few minutes.',
  checkoutExpired: 'This QR code expired.',
  checkoutCancelled: 'This payment was cancelled.',
  checkoutChooseAnother: 'Choose another pack',
  checkoutBackToStore: 'Back to the store',
  checkoutRecover: 'You have an unfinished top-up.',
  checkoutResume: 'Check it',
  checkoutFailed: 'We couldn’t check this payment yet. Try again.',
  checkoutCurrency: 'Prices are in Vietnamese đồng (VND).'
}

const vi: MatrixStoreCopy = {
  title: 'Cửa hàng',
  discover: 'Cửa hàng',
  subtitle: 'Kỹ năng, trợ lý và ứng dụng giúp Atum có thêm khả năng.',
  search: 'Tìm trong cửa hàng',
  featured: 'Nổi bật',
  agents: 'Trợ lý',
  skills: 'Kỹ năng',
  pets: 'Thú cưng',
  apps: 'Ứng dụng',
  purchased: 'Đã mua',
  gift: 'Quà tặng',
  gifts: 'Quà tặng',
  visiting: 'Đang ghé chơi',
  firstHatch: 'Lần ấp đầu',
  regularPrice: 'Giá thường',
  firstHatchNote: 'Lần ấp đầu tiên của bạn được giảm giá. Các lần ấp sau tính giá thường.',
  hatchFromPhoto: 'Mô tả một bé, hoặc dùng ảnh thú cưng của bạn.',
  hatchHow:
    'Bạn đang nuôi một bé? Dùng ảnh của bé, Atum sẽ lấy màu lông và hoa văn theo ảnh. Hoặc tả bé bạn muốn trong vài chữ.',
  hatchChargedOnHatch: 'Chỉ trả khi ấp bản nháp đã chọn.',
  hatchCreditReady: 'Lượt ấp dùng cho bản nháp đã chọn.',
  hatchPet: 'Ấp thú cưng của bạn',
  hatchChoosePhoto: 'Chọn ảnh',
  hatchDescribe: 'Mô tả thay thế',
  kind: { skill: 'Kỹ năng', agent: 'Trợ lý', pet: 'Thú cưng' },
  owned: 'Đã có',
  ownedBy: names => `Đã có · ${names}`,
  unavailable: 'Không khả dụng',
  free: 'Miễn phí',
  protons: 'Proton',
  monthly: '/ tháng',
  monthlyFirst: first => `${first} Proton tháng đầu`,
  monthlyFreeFirst: 'Tháng đầu miễn phí',
  monthlyThen: renewal => `sau đó ${renewal}/tháng`,
  loading: 'Đang tải cửa hàng…',
  stale: 'Đang hiện thông tin cửa hàng lần trước.',
  retry: 'Thử lại',
  empty: 'Chưa có gì ở đây.',
  agentsSoon: 'Sắp có',
  agentsSoonNote: 'Các trợ lý bạn có thể thuê sẽ sớm xuất hiện ở đây.',
  storeUnavailable: 'Cửa hàng tạm thời chưa mở được. Thử lại sau ít phút.',
  appsUnavailable: 'Chưa tải được ứng dụng.',
  purchasedEmpty: 'Bạn chưa mua gì.',
  targetAgent: 'Thêm cho trợ lý',
  noTargetAgent: 'Chưa có trợ lý nào để thêm kỹ năng này.',
  needsAtumAi: 'Chỉ trợ lý dùng AI của Atum mới dùng được mục này. Trợ lý dùng mô hình riêng không có trong danh sách.',
  add: 'Thêm kỹ năng',
  installFromHub: 'Cài từ Kho kỹ năng',
  installed: 'Đã cài',
  adopt: 'Nhận nuôi',
  hire: 'Thuê',
  buy: 'Mua',
  tryNow: 'Dùng ngay',
  get: 'Nhận',
  open: 'Mở',
  close: 'Đóng',
  moreInfo: 'Thông tin thêm',
  itemByAtum: kind => `${kind} · của Atum`,
  whatItUses: 'Thông tin được dùng',
  trySaying: 'Thử nói',
  addsTo: name => `Thêm cho ${name}.`,
  getFor: price => `Nhận · ${price}`,
  requirements: { internet: 'Cần kết nối mạng', 'runs-scripts': 'Chạy lệnh trên máy bạn' },
  tryExample: value => `Thử: ${value}`,
  balance: amount => `Bạn có ${amount} Proton`,
  balanceLabel: 'Proton của bạn',
  topUp: 'Nạp Proton',
  back: 'Quay lại',
  continue: 'Tiếp tục',
  purchasePending: 'Đã mua. Atum đang chuẩn bị cho bạn…',
  purchaseCompleted: 'Xong. Bạn dùng được ngay.',
  alreadyOwned: 'Bạn đã có mục này.',
  offerChanged: 'Giá vừa thay đổi. Xem lại giá rồi thử lại.',
  refused: kind => `${notDone(VI_NOT_DONE, kind)}. Bạn không bị trừ Proton nào. Hãy thử lại sau.`,
  refusedShort: kind =>
    `${notDone(VI_NOT_DONE, kind)} vì chưa đủ Proton. Bạn không bị trừ Proton nào. Hãy nạp thêm rồi thử lại.`,
  shortfall: amount => `Cần thêm ${amount} Proton`,
  purchaseUncertain:
    'Cửa hàng chưa trả lời nên chưa biết Proton của bạn đã bị trừ hay chưa. Lát nữa bạn xem lại trong Đã mua: nếu giao dịch đã thành công sẽ thấy ở đó, nếu chưa thì bạn không bị trừ.',
  purchaseFailed: 'Chưa làm được. Hãy thử lại.',
  checkPurchase: 'Kiểm tra',
  pendingPurchases: 'Đang xử lý',
  purchaseInProgress: 'Giao dịch đang xử lý',
  cancelMonthly: 'Hủy thuê theo tháng',
  cancelling: 'Đang hủy…',
  cancelled: 'Đã hủy',
  renews: date => `Gia hạn ngày ${date}`,
  lapsed: 'Đã hết hạn',
  revoked: 'Đã thu hồi',
  searchEmpty: 'Không tìm thấy mục nào.',
  listingMissing: 'Mục được đề xuất không còn trong danh mục hiện tại.',
  discoverLine: (kind, summary) => `${kind} · ${summary}`,
  itemAction: (action, title) => `${action}: ${title}`,
  hireRenewalConsent: renewal => `Tôi đồng ý gia hạn với giá ${renewal}.`,
  hireInitialPrice: initial => `Hôm nay: ${initial}`,
  hireRenewalPrice: renewal => `Sau đó: ${renewal} mỗi tháng`,
  hireConsentRequired: 'Hãy đánh dấu đồng ý gia hạn hằng tháng để thuê.',
  checkoutLoading: 'Đang tải gói nạp…',
  checkoutUnavailable: 'Chưa nạp Proton được lúc này. Thử lại sau ít phút.',
  checkoutBuy: 'Mua',
  checkoutSave: percent => `Tiết kiệm ${percent}%`,
  checkoutCreating: 'Đang tạo mã QR…',
  checkoutPending: 'Quét mã bằng ứng dụng ngân hàng. Atum tự cập nhật khi nhận được tiền.',
  checkoutChangePack: 'Muốn chọn gói khác? Hãy đợi mã này hết hạn.',
  checkoutPaid: amount => `Đã nạp xong ${amount} Proton.`,
  checkoutPaidBalance: amount => `Số dư: ${amount} Proton`,
  checkoutReceived: 'Đã nhận thanh toán. Proton sẽ vào tài khoản trong ít phút.',
  checkoutExpired: 'Mã QR đã hết hạn.',
  checkoutCancelled: 'Thanh toán đã bị hủy.',
  checkoutChooseAnother: 'Chọn gói khác',
  checkoutBackToStore: 'Tiếp tục mua sắm',
  checkoutRecover: 'Bạn có một lần nạp chưa xong.',
  checkoutResume: 'Xem lại',
  checkoutFailed: 'Chưa kiểm tra được thanh toán. Hãy thử lại.',
  checkoutCurrency: 'Giá được tính bằng VND.'
}

const ja: MatrixStoreCopy = {
  title: 'ストア',
  discover: '見つける',
  subtitle: 'Atum に新しい機能を加えるスキル、アシスタント、アプリ。',
  search: 'ストアを検索',
  featured: 'おすすめ',
  agents: 'アシスタント',
  skills: 'スキル',
  pets: 'ペット',
  apps: 'アプリ',
  purchased: '購入済み',
  gift: 'ギフト',
  gifts: 'ギフト',
  visiting: '訪問中',
  firstHatch: '初回の孵化',
  regularPrice: '通常価格',
  firstHatchNote: '初めての孵化は割引価格です。2回目以降は通常価格になります。',
  hatchFromPhoto: '言葉で説明するか、あなたのペットの写真を使えます。',
  hatchHow:
    '飼っているペットがいますか？その写真を使えば、Atum が毛色と模様を写し取ります。ほしいペットを短い言葉で説明することもできます。',
  hatchChargedOnHatch: '選んだ下書きを孵化するときだけ支払います。',
  hatchCreditReady: '孵化クレジットで選んだ下書きを孵化します。',
  hatchPet: 'ペットを孵化させる',
  hatchChoosePhoto: '写真を選ぶ',
  hatchDescribe: '言葉で説明する',
  kind: { skill: 'スキル', agent: 'アシスタント', pet: 'ペット' },
  owned: '所有済み',
  ownedBy: names => `所有済み · ${names}`,
  unavailable: '利用不可',
  free: '無料',
  protons: 'Proton',
  monthly: '/ 月',
  monthlyFirst: first => `初月 ${first} Proton`,
  monthlyFreeFirst: '初月無料',
  monthlyThen: renewal => `以降 ${renewal}/月`,
  loading: 'ストアを読み込み中…',
  stale: '前回のストア情報を表示しています。',
  retry: '再試行',
  empty: 'まだ何もありません。',
  agentsSoon: '近日公開',
  agentsSoonNote: '雇えるアシスタントがまもなくここに表示されます。',
  storeUnavailable: 'ストアを開けませんでした。しばらくしてからもう一度お試しください。',
  appsUnavailable: 'アプリを読み込めませんでした。',
  purchasedEmpty: 'まだ何も購入していません。',
  targetAgent: '追加するアシスタント',
  noTargetAgent: 'このスキルを追加できるアシスタントがまだいません。',
  needsAtumAi: 'これは Atum の AI を使うアシスタントだけが使えます。自分のモデルを使うアシスタントは表示されません。',
  add: 'スキルを追加',
  installFromHub: 'スキルハブからインストール',
  installed: 'インストール済み',
  adopt: '迎える',
  hire: '雇う',
  buy: '購入',
  tryNow: '今すぐ使う',
  get: '入手',
  open: '開く',
  close: '閉じる',
  moreInfo: '詳細情報',
  itemByAtum: kind => `${kind} · Atum 提供`,
  whatItUses: '使用する情報',
  trySaying: 'こんなふうに頼めます',
  addsTo: name => `${name} に追加します。`,
  getFor: price => `入手 · ${price}`,
  requirements: { internet: 'インターネット接続が必要', 'runs-scripts': 'Mac でコマンドを実行' },
  tryExample: value => `試す: ${value}`,
  balance: amount => `残高 ${amount} Proton`,
  balanceLabel: 'Proton 残高',
  topUp: 'チャージ',
  back: '戻る',
  continue: '続ける',
  purchasePending: '購入しました。準備しています…',
  purchaseCompleted: '完了しました。すぐに使えます。',
  alreadyOwned: 'すでに持っています。',
  offerChanged: '価格が変わりました。確認してからもう一度お試しください。',
  refused: kind => `${notDone(JA_NOT_DONE, kind)}。Proton は使われていません。しばらくしてからもう一度お試しください。`,
  refusedShort: kind =>
    `Proton が足りないため、${notDone(JA_NOT_DONE, kind)}。Proton は使われていません。チャージしてからもう一度お試しください。`,
  shortfall: amount => `あと ${amount} Proton 必要です`,
  purchaseUncertain:
    'ストアからまだ応答がなく、Proton が使われたかどうかは分かりません。少し後に「購入済み」を見てください。購入できていればそこに表示され、できていなければ請求されません。',
  purchaseFailed: 'うまくいきませんでした。もう一度お試しください。',
  checkPurchase: '確認',
  pendingPurchases: '処理中',
  purchaseInProgress: '処理中の購入',
  cancelMonthly: '月額雇用を解約',
  cancelling: '解約中…',
  cancelled: '解約済み',
  renews: date => `${date} に更新`,
  lapsed: '失効',
  revoked: '取り消し',
  searchEmpty: '一致するものはありません。',
  listingMissing: 'おすすめの項目は現在のカタログにありません。',
  discoverLine: (kind, summary) => `${kind} · ${summary}`,
  itemAction: (action, title) => `${action}: ${title}`,
  hireRenewalConsent: renewal => `${renewal} で更新することに同意します。`,
  hireInitialPrice: initial => `本日: ${initial}`,
  hireRenewalPrice: renewal => `以降、毎月 ${renewal}`,
  hireConsentRequired: '月額更新に同意するにはチェックを入れてください。',
  checkoutLoading: 'チャージを読み込み中…',
  checkoutUnavailable: '現在チャージできません。しばらくしてからお試しください。',
  checkoutBuy: '購入',
  checkoutSave: percent => `${percent}% お得`,
  checkoutCreating: 'QR コードを準備中…',
  checkoutPending: '銀行アプリで読み取ってください。入金を確認すると自動で更新されます。',
  checkoutChangePack: '別のパックにするには、このコードの期限が切れるまでお待ちください。',
  checkoutPaid: amount => `チャージ完了: ${amount} Proton を追加しました。`,
  checkoutPaidBalance: amount => `残高: ${amount} Proton`,
  checkoutReceived: '支払いを受け取りました。まもなく Proton が反映されます。',
  checkoutExpired: 'この QR コードは期限切れです。',
  checkoutCancelled: 'この支払いはキャンセルされました。',
  checkoutChooseAnother: '別のパックを選ぶ',
  checkoutBackToStore: 'ストアに戻る',
  checkoutRecover: '完了していないチャージがあります。',
  checkoutResume: '確認する',
  checkoutFailed: 'まだ支払いを確認できません。もう一度お試しください。',
  checkoutCurrency: '料金はベトナムドン（VND）です。'
}

const zh: MatrixStoreCopy = {
  title: '商店',
  discover: '发现',
  subtitle: '为 Atum 增添新能力的技能、助手和应用。',
  search: '搜索商店',
  featured: '精选',
  agents: '助手',
  skills: '技能',
  pets: '宠物',
  apps: '应用',
  purchased: '已购买',
  gift: '礼物',
  gifts: '礼物',
  visiting: '来访中',
  firstHatch: '首次孵化',
  regularPrice: '原价',
  firstHatchNote: '首次孵化享受优惠价，之后每次孵化按原价计算。',
  hatchFromPhoto: '描述一只宠物，或使用你自家宠物的照片。',
  hatchHow: '家里养着宠物？用它的照片，Atum 会照着它的毛色和花纹来画。也可以用几句话描述你想要的宠物。',
  hatchChargedOnHatch: '仅在孵化所选草稿时付款。',
  hatchCreditReady: '孵化额度用于所选草稿。',
  hatchPet: '孵化你的宠物',
  hatchChoosePhoto: '选择照片',
  hatchDescribe: '改用文字描述',
  kind: { skill: '技能', agent: '助手', pet: '宠物' },
  owned: '已拥有',
  ownedBy: names => `已拥有 · ${names}`,
  unavailable: '不可用',
  free: '免费',
  protons: 'Proton',
  monthly: '/ 月',
  monthlyFirst: first => `首月 ${first} Proton`,
  monthlyFreeFirst: '首月免费',
  monthlyThen: renewal => `之后 ${renewal}/月`,
  loading: '正在加载商店…',
  stale: '正在显示上次的商店信息。',
  retry: '重试',
  empty: '这里还没有内容。',
  agentsSoon: '即将推出',
  agentsSoonNote: '可雇用的助手很快会出现在这里。',
  storeUnavailable: '商店暂时无法打开，请稍后再试。',
  appsUnavailable: '应用无法加载。',
  purchasedEmpty: '你还没有购买任何东西。',
  targetAgent: '添加给助手',
  noTargetAgent: '还没有可以添加此技能的助手。',
  needsAtumAi: '只有使用 Atum 的 AI 的助手才能使用此项。使用自己模型的助手不会列出。',
  add: '添加技能',
  installFromHub: '从技能中心安装',
  installed: '已安装',
  adopt: '领养',
  hire: '雇用',
  buy: '购买',
  tryNow: '立即使用',
  get: '获取',
  open: '打开',
  close: '关闭',
  moreInfo: '更多信息',
  itemByAtum: kind => `${kind} · Atum 提供`,
  whatItUses: '使用的信息',
  trySaying: '试着这样说',
  addsTo: name => `添加到 ${name}。`,
  getFor: price => `获取 · ${price}`,
  requirements: { internet: '需要联网', 'runs-scripts': '在你的 Mac 上运行命令' },
  tryExample: value => `试试：${value}`,
  balance: amount => `你有 ${amount} Proton`,
  balanceLabel: '你的 Proton',
  topUp: '充值',
  back: '返回',
  continue: '继续',
  purchasePending: '已购买，正在为你准备…',
  purchaseCompleted: '完成，可以立即使用。',
  alreadyOwned: '你已经拥有它。',
  offerChanged: '价格刚刚变了，请查看后重试。',
  refused: kind => `${notDone(ZH_NOT_DONE, kind)}。没有扣除任何 Proton。请稍后再试。`,
  refusedShort: kind => `Proton 不足，${notDone(ZH_NOT_DONE, kind)}。没有扣除任何 Proton。请充值后再试。`,
  shortfall: amount => `还需要 ${amount} Proton`,
  purchaseUncertain:
    '商店暂时没有回应，目前还不知道你的 Proton 是否已被扣除。稍后请在“已购买”中查看：购买成功的话会显示在那里，未成功则不会扣费。',
  purchaseFailed: '没有成功，请重试。',
  checkPurchase: '检查',
  pendingPurchases: '处理中',
  purchaseInProgress: '购买处理中',
  cancelMonthly: '取消按月雇用',
  cancelling: '正在取消…',
  cancelled: '已取消',
  renews: date => `${date} 续订`,
  lapsed: '已失效',
  revoked: '已撤销',
  searchEmpty: '没有匹配的内容。',
  listingMissing: '推荐项目已不在当前目录中。',
  discoverLine: (kind, summary) => `${kind} · ${summary}`,
  itemAction: (action, title) => `${action}：${title}`,
  hireRenewalConsent: renewal => `我同意以 ${renewal} 续订。`,
  hireInitialPrice: initial => `今天：${initial}`,
  hireRenewalPrice: renewal => `之后每月：${renewal}`,
  hireConsentRequired: '请勾选同意按月续订。',
  checkoutLoading: '正在加载充值包…',
  checkoutUnavailable: '目前无法充值，请稍后再试。',
  checkoutBuy: '购买',
  checkoutSave: percent => `省 ${percent}%`,
  checkoutCreating: '正在生成二维码…',
  checkoutPending: '请用银行应用扫码。收到付款后会自动更新。',
  checkoutChangePack: '想换一个套餐？请等待此二维码过期。',
  checkoutPaid: amount => `充值完成：已添加 ${amount} Proton。`,
  checkoutPaidBalance: amount => `余额：${amount} Proton`,
  checkoutReceived: '已收到付款，Proton 将在几分钟内到账。',
  checkoutExpired: '此二维码已过期。',
  checkoutCancelled: '此付款已取消。',
  checkoutChooseAnother: '选择其他套餐',
  checkoutBackToStore: '返回商店',
  checkoutRecover: '你有一笔未完成的充值。',
  checkoutResume: '查看',
  checkoutFailed: '暂时无法确认付款，请重试。',
  checkoutCurrency: '价格以越南盾（VND）计价。'
}

const zhHant: MatrixStoreCopy = {
  title: '商店',
  discover: '探索',
  subtitle: '為 Atum 增添新能力的技能、助理和應用程式。',
  search: '搜尋商店',
  featured: '精選',
  agents: '助理',
  skills: '技能',
  pets: '寵物',
  apps: '應用程式',
  purchased: '已購買',
  gift: '禮物',
  gifts: '禮物',
  visiting: '來訪中',
  firstHatch: '首次孵化',
  regularPrice: '原價',
  firstHatchNote: '首次孵化享優惠價，之後每次孵化按原價計算。',
  hatchFromPhoto: '描述一隻寵物，或使用你自家寵物的照片。',
  hatchHow: '家裡養著寵物？用牠的照片，Atum 會照著牠的毛色和花紋來畫。也可以用幾句話描述你想要的寵物。',
  hatchChargedOnHatch: '僅在孵化所選草稿時付款。',
  hatchCreditReady: '孵化額度用於所選草稿。',
  hatchPet: '孵化你的寵物',
  hatchChoosePhoto: '選擇照片',
  hatchDescribe: '改用文字描述',
  kind: { skill: '技能', agent: '助理', pet: '寵物' },
  owned: '已擁有',
  ownedBy: names => `已擁有 · ${names}`,
  unavailable: '無法使用',
  free: '免費',
  protons: 'Proton',
  monthly: '/ 月',
  monthlyFirst: first => `首月 ${first} Proton`,
  monthlyFreeFirst: '首月免費',
  monthlyThen: renewal => `之後 ${renewal}/月`,
  loading: '正在載入商店…',
  stale: '正在顯示上次的商店資訊。',
  retry: '重試',
  empty: '這裡還沒有內容。',
  agentsSoon: '即將推出',
  agentsSoonNote: '可聘用的助理很快會出現在這裡。',
  storeUnavailable: '商店暫時無法開啟，請稍後再試。',
  appsUnavailable: '無法載入應用程式。',
  purchasedEmpty: '你還沒有購買任何東西。',
  targetAgent: '新增給助理',
  noTargetAgent: '還沒有可以新增此技能的助理。',
  needsAtumAi: '只有使用 Atum 的 AI 的助理才能使用此項。使用自己模型的助理不會列出。',
  add: '新增技能',
  installFromHub: '從技能庫安裝',
  installed: '已安裝',
  adopt: '領養',
  hire: '聘用',
  buy: '購買',
  tryNow: '立即使用',
  get: '取得',
  open: '開啟',
  close: '關閉',
  moreInfo: '更多資訊',
  itemByAtum: kind => `${kind} · Atum 提供`,
  whatItUses: '使用的資訊',
  trySaying: '試著這樣說',
  addsTo: name => `新增到 ${name}。`,
  getFor: price => `取得 · ${price}`,
  requirements: { internet: '需要連網', 'runs-scripts': '在你的 Mac 上執行指令' },
  tryExample: value => `試試：${value}`,
  balance: amount => `你有 ${amount} Proton`,
  balanceLabel: '你的 Proton',
  topUp: '儲值',
  back: '返回',
  continue: '繼續',
  purchasePending: '已購買，正在為你準備…',
  purchaseCompleted: '完成，可以立即使用。',
  alreadyOwned: '你已經擁有它。',
  offerChanged: '價格剛剛變更，請查看後再試一次。',
  refused: kind => `${notDone(ZH_HANT_NOT_DONE, kind)}。沒有扣除任何 Proton。請稍後再試。`,
  refusedShort: kind => `Proton 不足，${notDone(ZH_HANT_NOT_DONE, kind)}。沒有扣除任何 Proton。請儲值後再試。`,
  shortfall: amount => `還需要 ${amount} Proton`,
  purchaseUncertain:
    '商店暫時沒有回應，目前還不知道你的 Proton 是否已被扣除。稍後請在「已購買」中查看：購買成功的話會顯示在那裡，未成功則不會扣費。',
  purchaseFailed: '沒有成功，請再試一次。',
  checkPurchase: '檢查',
  pendingPurchases: '處理中',
  purchaseInProgress: '購買處理中',
  cancelMonthly: '取消月度聘用',
  cancelling: '正在取消…',
  cancelled: '已取消',
  renews: date => `${date} 續訂`,
  lapsed: '已失效',
  revoked: '已撤銷',
  searchEmpty: '沒有符合的內容。',
  listingMissing: '推薦項目已不在目前的目錄中。',
  discoverLine: (kind, summary) => `${kind} · ${summary}`,
  itemAction: (action, title) => `${action}：${title}`,
  hireRenewalConsent: renewal => `我同意以 ${renewal} 續訂。`,
  hireInitialPrice: initial => `今天：${initial}`,
  hireRenewalPrice: renewal => `之後每月：${renewal}`,
  hireConsentRequired: '請勾選同意按月續訂。',
  checkoutLoading: '正在載入儲值方案…',
  checkoutUnavailable: '目前無法儲值，請稍後再試。',
  checkoutBuy: '購買',
  checkoutSave: percent => `省 ${percent}%`,
  checkoutCreating: '正在產生 QR 碼…',
  checkoutPending: '請用銀行 App 掃描。收到付款後會自動更新。',
  checkoutChangePack: '想換其他方案？請等待此 QR 碼過期。',
  checkoutPaid: amount => `儲值完成：已新增 ${amount} Proton。`,
  checkoutPaidBalance: amount => `餘額：${amount} Proton`,
  checkoutReceived: '已收到付款，Proton 將在幾分鐘內入帳。',
  checkoutExpired: '此 QR 碼已過期。',
  checkoutCancelled: '此付款已取消。',
  checkoutChooseAnother: '選擇其他方案',
  checkoutBackToStore: '返回商店',
  checkoutRecover: '你有一筆未完成的儲值。',
  checkoutResume: '查看',
  checkoutFailed: '暫時無法確認付款，請再試一次。',
  checkoutCurrency: '價格以越南盾（VND）計價。'
}

/** The window's locale ids are lower case (`zh-hant`); BCP 47 spelling (`zh-Hant`) reads the same. */
export function matrixStoreCopy(locale: string): MatrixStoreCopy {
  const id = locale.toLowerCase()

  if (id === 'vi') {
    return vi
  }

  if (id === 'ja') {
    return ja
  }

  if (id === 'zh-hant') {
    return zhHant
  }

  if (id === 'zh') {
    return zh
  }

  return en
}

/** The requirements this build can say in words; an unknown token is left out rather than printed raw. */
export function storeRequirements(needs: readonly string[], copy: MatrixStoreCopy): string[] {
  return needs.flatMap(token => (copy.requirements[token] ? [copy.requirements[token]] : []))
}
