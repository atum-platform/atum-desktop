import { type Locale, useI18n } from '@/i18n'

/** The sign-in window's own words; "Continue with Google" lives in `t.dm`. */
interface SignInCopy {
  tagline: string
  continueWithEmail: string
  newHere: string
  createAccount: string
  /** Under the Google button when the server takes no email sign-in: Google creates accounts too. */
  newHereGoogle: string
  /** On the chosen button before the browser has opened (the app checks the saved sign-in). */
  opening: string
  /** On the button the browser is open for, while the window waits. */
  waiting: string
  /** The same button once the browser is back and the sign-in finishes here. */
  returning: string
  /** The server has no email sign-in yet (`matrix_password_unavailable`). */
  passwordUnavailable: string
  /** The same, for a new account by email. */
  createUnavailable: string
  timedOut: string
  /** A sign-in that did not finish, by the way that was tried; trying it again is right there. */
  failedGoogle: string
  failedEmail: string
  failedCreate: string
  /** An error in this window before any way in was tried (nothing about a sign-in). */
  notConnected: string
  /** An account saved on this Mac that can't be opened or reached: never the ways in. */
  unavailableTitle: string
  unavailableHelp: string
  /** Its saved sign-in can't be read on this Mac (`matrix_vault_unavailable`). */
  vaultTitle: string
  vaultHelp: string
  /** A sign-out that closed access here but did not finish its cleanup. */
  signOutPendingTitle: string
  signOutPendingHelp: string
  /** The sign-in server ended this Mac's session (`matrix_session_ended`): signing in again
   * with the same account brings everything back. */
  sessionEnded: string
  /** Another account was used to sign in over that ended session (`matrix_account_mismatch`);
   * signing out of the saved one, confirmed, is how to switch. */
  accountMismatch: string
  /** The terms line: the age confirmation (18 or older, as the Terms ask) and the agreement;
   * `{terms}` and `{privacy}` become links to the published pages. */
  legal: string
  /** What the assistant does with its work and memory, shown to every new account before
   * sign-in; the privacy policy link follows it in the footer. */
  cloudConsent: string
  terms: string
  privacy: string
}

const copies: Record<Locale, SignInCopy> = {
  en: {
    tagline: 'One place to ask, and it gets done.',
    continueWithEmail: 'Continue with email',
    newHere: 'New to Atum?',
    createAccount: 'Create an account',
    newHereGoogle: 'New to Atum? Continue with Google to create your account.',
    opening: 'Opening your browser…',
    waiting: 'Waiting for you to finish in your browser…',
    returning: 'Signing you in…',
    passwordUnavailable: 'Email sign-in isn’t supported yet. Continue with Google for now.',
    createUnavailable: 'Creating an account with email isn’t supported yet. Continue with Google to create one.',
    timedOut: 'Sign-in timed out. Choose a way in to start again.',
    failedGoogle: 'Couldn’t sign in with Google. Check your connection, then try again.',
    failedEmail: 'Couldn’t sign in with email. Check your connection, then try again.',
    failedCreate: 'Couldn’t create your account. Check your connection, then try again.',
    notConnected: 'Atum couldn’t connect. Check your connection, then try again.',
    unavailableTitle: 'Can’t reach Atum right now',
    unavailableHelp: 'Check your connection, then try again.',
    vaultTitle: 'Couldn’t open your saved sign-in',
    vaultHelp: 'Atum couldn’t open the sign-in saved on this Mac. Try again, or sign out and sign in again.',
    signOutPendingTitle: 'Signing out didn’t finish',
    signOutPendingHelp: 'Atum has closed access on this Mac, but some cleanup is left. Check your connection, then sign out again.',
    sessionEnded: 'You were signed out on this Mac. Sign in again to continue.',
    accountMismatch: 'This Mac was signed in with a different Atum account. Sign in with that account to continue, or sign out of it first.',
    legal: 'By continuing you confirm you’re 18 or older and agree to the Atum {terms} and {privacy}.',
    cloudConsent: "Your assistant runs and keeps its memory on Atum's servers.",
    terms: 'Terms',
    privacy: 'Privacy Policy'
  },
  vi: {
    tagline: 'Một nơi để hỏi, rồi mọi việc được hoàn thành.',
    continueWithEmail: 'Tiếp tục với email',
    newHere: 'Mới dùng Atum?',
    createAccount: 'Tạo tài khoản',
    newHereGoogle: 'Mới dùng Atum? Tiếp tục với Google để tạo tài khoản.',
    opening: 'Đang mở trình duyệt…',
    waiting: 'Đang chờ bạn hoàn tất trong trình duyệt…',
    returning: 'Đang đăng nhập…',
    passwordUnavailable: 'Hiện chưa hỗ trợ đăng nhập bằng email. Tạm thời bạn hãy tiếp tục với Google.',
    createUnavailable: 'Hiện chưa hỗ trợ tạo tài khoản bằng email. Tạm thời bạn hãy tiếp tục với Google để tạo tài khoản.',
    timedOut: 'Phiên đăng nhập đã hết thời gian. Hãy chọn một cách đăng nhập để bắt đầu lại.',
    failedGoogle: 'Chưa đăng nhập được bằng Google. Kiểm tra kết nối rồi thử lại.',
    failedEmail: 'Chưa đăng nhập được bằng email. Kiểm tra kết nối rồi thử lại.',
    failedCreate: 'Chưa tạo được tài khoản. Kiểm tra kết nối rồi thử lại.',
    notConnected: 'Atum chưa kết nối được. Kiểm tra kết nối rồi thử lại.',
    unavailableTitle: 'Chưa kết nối được với Atum',
    unavailableHelp: 'Kiểm tra kết nối rồi thử lại.',
    vaultTitle: 'Chưa mở được thông tin đăng nhập đã lưu',
    vaultHelp: 'Atum chưa mở được thông tin đăng nhập đã lưu trên máy Mac này. Hãy thử lại, hoặc đăng xuất rồi đăng nhập lại.',
    signOutPendingTitle: 'Chưa đăng xuất xong',
    signOutPendingHelp: 'Atum đã đóng quyền truy cập trên máy Mac này nhưng vẫn còn bước dọn dẹp. Kiểm tra kết nối rồi đăng xuất lại.',
    sessionEnded: 'Bạn đã được đăng xuất trên máy Mac này. Đăng nhập lại để tiếp tục.',
    accountMismatch: 'Máy Mac này đang dùng một tài khoản Atum khác. Hãy đăng nhập bằng tài khoản đó để tiếp tục, hoặc đăng xuất tài khoản đó trước.',
    legal: 'Khi tiếp tục, bạn xác nhận mình từ 18 tuổi trở lên và đồng ý với {terms} và {privacy} của Atum.',
    cloudConsent: 'Trợ lý của bạn chạy và lưu trí nhớ trên máy chủ của Atum.',
    terms: 'Điều khoản',
    privacy: 'Chính sách quyền riêng tư'
  },
  ja: {
    tagline: 'ここで頼めば、あとは完了まで。',
    continueWithEmail: 'メールで続行',
    newHere: 'Atum は初めてですか？',
    createAccount: 'アカウントを作成',
    newHereGoogle: 'Atum は初めてですか？Google で続行するとアカウントが作成されます。',
    opening: 'ブラウザを開いています…',
    waiting: 'ブラウザでの操作が終わるのを待っています…',
    returning: 'サインインしています…',
    passwordUnavailable: 'メールでのログインはまだ利用できません。今は Google で続行してください。',
    createUnavailable: 'メールでのアカウント作成はまだ利用できません。今は Google で続行してアカウントを作成してください。',
    timedOut: 'ログインがタイムアウトしました。続行する方法を選んで、もう一度始めてください。',
    failedGoogle: 'Google でログインできませんでした。接続を確認して、もう一度お試しください。',
    failedEmail: 'メールでログインできませんでした。接続を確認して、もう一度お試しください。',
    failedCreate: 'アカウントを作成できませんでした。接続を確認して、もう一度お試しください。',
    notConnected: 'Atum に接続できませんでした。接続を確認して、もう一度お試しください。',
    unavailableTitle: 'いま Atum に接続できません',
    unavailableHelp: '接続を確認して、もう一度お試しください。',
    vaultTitle: '保存されたログイン情報を開けませんでした',
    vaultHelp: 'この Mac に保存されたログイン情報を開けませんでした。もう一度お試しいただくか、ログアウトしてから再度ログインしてください。',
    signOutPendingTitle: 'ログアウトが完了していません',
    signOutPendingHelp: 'この Mac でのアクセスは閉じましたが、後処理が残っています。接続を確認して、もう一度ログアウトしてください。',
    sessionEnded: 'この Mac ではログアウトされました。続けるには、もう一度ログインしてください。',
    accountMismatch: 'この Mac は別の Atum アカウントで使われていました。そのアカウントでログインして続けるか、先にそのアカウントからログアウトしてください。',
    legal: '続行すると、18 歳以上であることを確認し、Atum の{terms}と{privacy}に同意したことになります。',
    cloudConsent: 'アシスタントは Atum のサーバーで動作し、記憶もそこに保存されます。',
    terms: '利用規約',
    privacy: 'プライバシーポリシー'
  },
  zh: {
    tagline: '只需开口，事情就在这里完成。',
    continueWithEmail: '使用邮箱继续',
    newHere: '第一次使用 Atum？',
    createAccount: '创建账号',
    newHereGoogle: '第一次使用 Atum？使用 Google 继续即可创建账号。',
    opening: '正在打开浏览器…',
    waiting: '正在等待你在浏览器中完成…',
    returning: '正在登录…',
    passwordUnavailable: '邮箱登录暂未开放。请先使用 Google 继续。',
    createUnavailable: '暂不支持用邮箱创建账号。请先使用 Google 继续来创建账号。',
    timedOut: '登录已超时。请选择一种方式重新开始。',
    failedGoogle: '无法使用 Google 登录。请检查连接后重试。',
    failedEmail: '无法使用邮箱登录。请检查连接后重试。',
    failedCreate: '无法创建账号。请检查连接后重试。',
    notConnected: 'Atum 无法连接。请检查连接后重试。',
    unavailableTitle: '暂时无法连接到 Atum',
    unavailableHelp: '请检查连接后重试。',
    vaultTitle: '无法打开已保存的登录信息',
    vaultHelp: 'Atum 无法打开这台 Mac 上保存的登录信息。请重试，或退出后重新登录。',
    signOutPendingTitle: '退出登录尚未完成',
    signOutPendingHelp: '这台 Mac 上的访问已关闭，但还有清理未完成。请检查连接后再次退出登录。',
    sessionEnded: '你已在这台 Mac 上退出登录。请重新登录以继续。',
    accountMismatch: '这台 Mac 之前登录的是另一个 Atum 账号。请用那个账号登录以继续，或先退出那个账号。',
    legal: '继续即表示你确认已年满 18 周岁，并同意 Atum 的{terms}和{privacy}。',
    cloudConsent: '你的助手在 Atum 的服务器上运行并保存记忆。',
    terms: '条款',
    privacy: '隐私政策'
  },
  'zh-hant': {
    tagline: '只要開口，事情就在這裡完成。',
    continueWithEmail: '使用電子郵件繼續',
    newHere: '第一次使用 Atum？',
    createAccount: '建立帳號',
    newHereGoogle: '第一次使用 Atum？使用 Google 繼續即可建立帳號。',
    opening: '正在開啟瀏覽器…',
    waiting: '正在等待你在瀏覽器中完成…',
    returning: '正在登入…',
    passwordUnavailable: '電子郵件登入尚未開放。請先使用 Google 繼續。',
    createUnavailable: '暫不支援用電子郵件建立帳號。請先使用 Google 繼續來建立帳號。',
    timedOut: '登入已逾時。請選擇一種方式重新開始。',
    failedGoogle: '無法使用 Google 登入。請檢查連線後再試一次。',
    failedEmail: '無法使用電子郵件登入。請檢查連線後再試一次。',
    failedCreate: '無法建立帳號。請檢查連線後再試一次。',
    notConnected: 'Atum 無法連線。請檢查連線後再試一次。',
    unavailableTitle: '暫時無法連線到 Atum',
    unavailableHelp: '請檢查連線後再試一次。',
    vaultTitle: '無法開啟已儲存的登入資訊',
    vaultHelp: 'Atum 無法開啟這台 Mac 上儲存的登入資訊。請再試一次，或登出後重新登入。',
    signOutPendingTitle: '登出尚未完成',
    signOutPendingHelp: '這台 Mac 上的存取已關閉，但還有清理未完成。請檢查連線後再次登出。',
    sessionEnded: '你已在這台 Mac 上登出。請重新登入以繼續。',
    accountMismatch: '這台 Mac 之前登入的是另一個 Atum 帳號。請用那個帳號登入以繼續，或先登出那個帳號。',
    legal: '繼續即表示你確認已年滿 18 歲，並同意 Atum 的{terms}和{privacy}。',
    cloudConsent: '你的助理在 Atum 的伺服器上運作並保存記憶。',
    terms: '條款',
    privacy: '隱私權政策'
  }
}

export function matrixSignInCopy(locale: Locale): SignInCopy {
  return copies[locale]
}

export function useSignInCopy(): SignInCopy {
  return matrixSignInCopy(useI18n().locale)
}
