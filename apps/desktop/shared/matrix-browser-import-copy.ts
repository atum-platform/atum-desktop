import type { DesktopLocale } from './desktop-locale'
import type { MatrixBrowserImportReason } from './matrix-browser-import'

/**
 * Everything a person reads about importing browser logins: the Settings section, the result line, why an import
 * did not happen, and the words on the Touch ID sheet. One table per locale, Vietnamese first in spirit (the
 * product default). The legacy formatter arguments remain compatible with phone exports.
 *
 * Kept to the shapes the phone copy exporter accepts (`packages/mobile-design-exports`): a formatter takes at most
 * one number and only interpolates its string arguments.
 */
interface BrowserImportCopy {
  title: string
  /** The explanation that does not fit on a row, behind the section's (?). */
  tip: (agent: string) => string
  rowTitle: string
  /** One muted line under the row title. */
  rowHelp: (agent: string) => string
  button: string
  /** While the Keychain and Touch ID prompts are up. */
  working: string
  imported: (agent: string, sites: number) => string
  /** After a successful import, the one sentence about what was not imported. */
  leftOut: string
  declined: string
  reasons: Record<MatrixBrowserImportReason, string>
  /** The Touch ID sheet: who, how many, encrypted, what stays out. */
  approvalReason: (agent: string, sites: number) => string
}

export const matrixBrowserImportCopy: Record<DesktopLocale, BrowserImportCopy> = {
  en: {
    title: 'Browser logins',
    tip: () => 'Chrome logins are encrypted; passwords and financial sites stay out.',
    rowTitle: 'Chrome',
    rowHelp: () => 'Import your signed-in sites into Atum.',
    button: 'Import browser logins',
    working: 'Waiting for your approval…',
    imported: (_agent, sites) => `Imported ${sites} ${sites === 1 ? 'site' : 'sites'}.`,
    leftOut: 'Banking, wallets and password managers were left out.',
    declined: 'Nothing was imported.',
    reasons: {
      unsupported: 'Importing browser logins needs a Mac with Touch ID.',
      signed_out: 'Sign in to Atum first.',
      chrome_not_found: 'Atum couldn’t find Google Chrome on this Mac.',
      nothing_to_import: 'There’s nothing to import: Chrome has no signed-in sites Atum can bring over.',
      keychain_denied: 'Atum couldn’t read Chrome’s saved sign-ins. Allow access when macOS asks, then try again.',
      approval_unavailable: 'Touch ID isn’t available on this Mac, so nothing was imported.',
      no_computer: 'This assistant doesn’t have a cloud computer yet, so there’s nowhere to bring your logins.',
      key_untrusted: 'Atum couldn’t verify where to send your logins, so nothing was sent.',
      offline: 'Atum couldn’t reach the cloud. Check your connection and try again.',
      refused: 'The cloud didn’t accept the import and kept nothing. Try again in a moment.',
      busy: 'An import is already running.',
      failed: 'The import didn’t finish and nothing was sent. Try again.'
    },
    approvalReason: (_agent, sites) =>
      `Import ${sites} Chrome ${sites === 1 ? 'site' : 'sites'} to your primary assistant, encrypted; no passwords or financial sites.`
  },
  vi: {
    title: 'Đăng nhập từ trình duyệt',
    tip: () => 'Đăng nhập Chrome được mã hóa; bỏ qua mật khẩu và tài chính.',
    rowTitle: 'Chrome',
    rowHelp: () => 'Nhập các trang bạn đã đăng nhập vào Atum.',
    button: 'Nhập đăng nhập từ trình duyệt',
    working: 'Đang chờ bạn xác nhận…',
    imported: (_agent, sites) => `Đã nhập đăng nhập của ${sites} trang.`,
    leftOut: 'Ngân hàng, ví và trình quản lý mật khẩu đã được bỏ qua.',
    declined: 'Chưa nhập gì cả.',
    reasons: {
      unsupported: 'Nhập đăng nhập từ trình duyệt cần một máy Mac có Touch ID.',
      signed_out: 'Hãy đăng nhập Atum trước.',
      chrome_not_found: 'Atum không tìm thấy Google Chrome trên máy Mac này.',
      nothing_to_import: 'Không có gì để nhập: Chrome không có trang đăng nhập nào mà Atum có thể mang sang.',
      keychain_denied: 'Atum chưa đọc được phần đăng nhập đã lưu của Chrome. Hãy cho phép khi macOS hỏi, rồi thử lại.',
      approval_unavailable: 'Máy Mac này không dùng được Touch ID nên chưa nhập gì.',
      no_computer: 'Trợ lý này chưa có máy tính đám mây nên chưa có nơi để nhận đăng nhập.',
      key_untrusted: 'Atum không xác minh được nơi cần gửi nên chưa gửi gì.',
      offline: 'Atum không kết nối được với đám mây. Hãy kiểm tra mạng rồi thử lại.',
      refused: 'Đám mây chưa nhận bản nhập này và không giữ lại gì. Hãy thử lại sau một lát.',
      busy: 'Một lần nhập đang chạy.',
      failed: 'Chưa nhập xong và chưa gửi gì. Hãy thử lại.'
    },
    approvalReason: (_agent, sites) =>
      `Nhập ${sites} trang Chrome cho trợ lý chính, đã mã hóa; không có mật khẩu hay tài chính.`
  },
  ja: {
    title: 'ブラウザのログイン',
    tip: () => 'Chrome ログインは暗号化され、パスワードと金融サイトは除外されます。',
    rowTitle: 'Chrome',
    rowHelp: () => 'ログイン中のサイトを Atum に取り込みます。',
    button: 'ブラウザのログインを取り込む',
    working: '承認をお待ちしています…',
    imported: (_agent, sites) => `${sites} サイトのログインを取り込みました。`,
    leftOut: '銀行、ウォレット、パスワードマネージャは除外しました。',
    declined: '何も取り込んでいません。',
    reasons: {
      unsupported: 'ブラウザのログインの取り込みには Touch ID 搭載の Mac が必要です。',
      signed_out: '先に Atum にサインインしてください。',
      chrome_not_found: 'この Mac で Google Chrome が見つかりませんでした。',
      nothing_to_import: '取り込めるものがありません。Atum が引き継げるログイン済みサイトが Chrome にありません。',
      keychain_denied:
        'Chrome に保存されたログイン情報を読み取れませんでした。macOS の確認で許可してから、もう一度お試しください。',
      approval_unavailable: 'この Mac では Touch ID を使えないため、何も取り込んでいません。',
      no_computer: 'このアシスタントにはまだクラウドのコンピュータがないため、ログインの送り先がありません。',
      key_untrusted: '送信先を確認できなかったため、何も送信していません。',
      offline: 'クラウドに接続できませんでした。接続を確認してもう一度お試しください。',
      refused: 'クラウドが取り込みを受け付けず、何も保存されていません。少し待ってからもう一度お試しください。',
      busy: '取り込みはすでに実行中です。',
      failed: '取り込みが完了せず、何も送信していません。もう一度お試しください。'
    },
    approvalReason: (_agent, sites) =>
      `Chrome ${sites} サイトをメインアシスタントへ暗号化して取り込みます。パスワードと金融サイトは除外します。`
  },
  zh: {
    title: '浏览器登录',
    tip: () => 'Chrome 登录会加密；不导入密码和金融网站。',
    rowTitle: 'Chrome',
    rowHelp: () => '把你已登录的网站导入 Atum。',
    button: '导入浏览器登录',
    working: '正在等待你的批准…',
    imported: (_agent, sites) => `已导入 ${sites} 个网站的登录。`,
    leftOut: '银行、钱包和密码管理器已跳过。',
    declined: '未导入任何内容。',
    reasons: {
      unsupported: '导入浏览器登录需要支持 Touch ID 的 Mac。',
      signed_out: '请先登录 Atum。',
      chrome_not_found: 'Atum 在这台 Mac 上找不到 Google Chrome。',
      nothing_to_import: '没有可导入的内容：Chrome 中没有 Atum 能带过去的已登录网站。',
      keychain_denied: 'Atum 无法读取 Chrome 保存的登录信息。macOS 询问时请允许，然后重试。',
      approval_unavailable: '这台 Mac 无法使用 Touch ID，所以没有导入任何内容。',
      no_computer: '这位助理还没有云端电脑，没有地方接收你的登录。',
      key_untrusted: 'Atum 无法验证该发送到哪里，所以没有发送任何内容。',
      offline: 'Atum 无法连接云端。请检查网络后重试。',
      refused: '云端没有接受这次导入，也没有保留任何内容。请稍后重试。',
      busy: '已有一次导入正在进行。',
      failed: '导入没有完成，也没有发送任何内容。请重试。'
    },
    approvalReason: (_agent, sites) => `将 ${sites} 个 Chrome 网站加密导入主助理；不含密码或金融网站。`
  },
  'zh-hant': {
    title: '瀏覽器登入',
    tip: () => 'Chrome 登入會加密；不匯入密碼和金融網站。',
    rowTitle: 'Chrome',
    rowHelp: () => '把你已登入的網站匯入 Atum。',
    button: '匯入瀏覽器登入',
    working: '正在等待你的核准…',
    imported: (_agent, sites) => `已匯入 ${sites} 個網站的登入。`,
    leftOut: '銀行、錢包和密碼管理員已略過。',
    declined: '未匯入任何內容。',
    reasons: {
      unsupported: '匯入瀏覽器登入需要支援 Touch ID 的 Mac。',
      signed_out: '請先登入 Atum。',
      chrome_not_found: 'Atum 在這台 Mac 上找不到 Google Chrome。',
      nothing_to_import: '沒有可匯入的內容：Chrome 中沒有 Atum 能帶過去的已登入網站。',
      keychain_denied: 'Atum 無法讀取 Chrome 儲存的登入資訊。macOS 詢問時請允許，然後重試。',
      approval_unavailable: '這台 Mac 無法使用 Touch ID，所以沒有匯入任何內容。',
      no_computer: '這位助理還沒有雲端電腦，沒有地方接收你的登入。',
      key_untrusted: 'Atum 無法驗證該傳送到哪裡，所以沒有傳送任何內容。',
      offline: 'Atum 無法連線到雲端。請檢查網路後重試。',
      refused: '雲端沒有接受這次匯入，也沒有保留任何內容。請稍後重試。',
      busy: '已有一次匯入正在進行。',
      failed: '匯入沒有完成，也沒有傳送任何內容。請重試。'
    },
    approvalReason: (_agent, sites) => `將 ${sites} 個 Chrome 網站加密匯入主助理；不含密碼或金融網站。`
  }
}
