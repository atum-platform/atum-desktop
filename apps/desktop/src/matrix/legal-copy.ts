import { type Locale, useI18n } from '@/i18n'

import { ATUM_COMPANY, ATUM_MAILBOXES } from '../../shared/atum-company'

/**
 * Atum's legal words in the window, all five languages together: the names of the published
 * pages (atum-links.ts opens them), the Atum Drive source link and the open-source licences, Settings › General › Legal, Settings › Account › Delete
 * my account, and the one seller line under every payment QR (purchase-qr-panel.tsx). The
 * company facts themselves live in shared/atum-company.ts.
 */
export interface MatrixLegalCopy {
  /** Settings › General: the section with the published pages. */
  legal: string
  terms: string
  privacy: string
  /** The source code of the bundled Atum Drive engine, which is free software (GPL). */
  driveEngineSource: string
  /** The open-source notice and licence texts that ship with the app, opened in the app. */
  openSourceLicences: string
  /** Settings › Account: deleting the account is a request by email, done by hand within
   * 30 days (the Privacy Policy). The help names the address; the tip says the rest. */
  deleteAccount: string
  deleteAccountHelp: string
  deleteAccountTip: string
  deleteAccountAction: string
  deleteAccountDialogTitle: string
  deleteAccountDialogBody: string
  deleteAccountConfirm: string
  /** The email the action starts, in the person's own language. */
  deleteAccountSubject: string
  deleteAccountBody: string
  /** The mail app did not open: where to write instead. */
  deleteAccountFailed: string
  /** Who sells, in one muted line: the company, its enterprise code, its head office, support. */
  seller: string
}

const company = ATUM_COMPANY
const support = ATUM_MAILBOXES.support
const privacy = ATUM_MAILBOXES.privacy

const copy: Record<Locale, MatrixLegalCopy> = {
  en: {
    legal: 'Legal',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    driveEngineSource: 'Atum Drive source code (GPL)',
    openSourceLicences: 'Open-source licences',
    deleteAccount: 'Delete my account',
    deleteAccountHelp: `Email ${privacy} · within 30 days`,
    deleteAccountTip:
      'Send it from the address you sign in with. We check it’s you, then delete your account and its data within 30 days.',
    deleteAccountAction: 'Delete account…',
    deleteAccountDialogTitle: 'Delete your account?',
    deleteAccountDialogBody: 'Your account and its data are deleted within 30 days.',
    deleteAccountConfirm: 'Delete account',
    deleteAccountSubject: 'Delete my Atum account',
    deleteAccountBody: 'Please delete my Atum account.',
    deleteAccountFailed: `Couldn’t open your email app. Write to ${privacy} from the address you sign in with.`,
    seller: `Seller: ${company.englishName} · Enterprise code ${company.enterpriseCode} · ${company.headOffice.en} · ${support}`
  },
  vi: {
    legal: 'Pháp lý',
    terms: 'Điều khoản sử dụng',
    privacy: 'Chính sách quyền riêng tư',
    driveEngineSource: 'Mã nguồn Atum Drive (GPL)',
    openSourceLicences: 'Giấy phép mã nguồn mở',
    deleteAccount: 'Xóa tài khoản',
    deleteAccountHelp: `Qua email ${privacy} · trong 30 ngày`,
    deleteAccountTip:
      'Gửi từ địa chỉ email bạn dùng để đăng nhập. Chúng tôi xác minh đó là bạn, rồi xóa tài khoản và dữ liệu trong vòng 30 ngày.',
    deleteAccountAction: 'Xóa tài khoản…',
    deleteAccountDialogTitle: 'Xóa tài khoản của bạn?',
    deleteAccountDialogBody: 'Tài khoản và dữ liệu của bạn sẽ được xóa trong vòng 30 ngày.',
    deleteAccountConfirm: 'Xóa tài khoản',
    deleteAccountSubject: 'Yêu cầu xóa tài khoản Atum',
    deleteAccountBody: 'Vui lòng xóa tài khoản Atum của tôi.',
    deleteAccountFailed: `Không mở được ứng dụng email. Hãy gửi email tới ${privacy} từ địa chỉ bạn dùng để đăng nhập.`,
    seller: `Bên bán: ${company.legalName} · MSDN ${company.enterpriseCode} · ${company.headOffice.vi} · ${support}`
  },
  ja: {
    legal: '法的情報',
    terms: '利用規約',
    privacy: 'プライバシーポリシー',
    driveEngineSource: 'Atum Drive のソースコード (GPL)',
    openSourceLicences: 'オープンソースライセンス',
    deleteAccount: 'アカウントの削除',
    deleteAccountHelp: `${privacy} にメール · 30 日以内に削除`,
    deleteAccountTip:
      'ログインに使っているアドレスから送ってください。ご本人であることを確認したうえで、30 日以内にアカウントとデータを削除します。',
    deleteAccountAction: 'アカウントを削除…',
    deleteAccountDialogTitle: 'アカウントを削除しますか？',
    deleteAccountDialogBody: 'アカウントとそのデータは 30 日以内に削除されます。',
    deleteAccountConfirm: 'アカウントを削除',
    deleteAccountSubject: 'Atum アカウントの削除依頼',
    deleteAccountBody: 'Atum アカウントを削除してください。',
    deleteAccountFailed: `メールアプリを開けませんでした。ログインに使っているアドレスから ${privacy} にメールしてください。`,
    seller: `販売者：${company.englishName} · 企業コード ${company.enterpriseCode} · ${company.headOffice.en} · ${support}`
  },
  zh: {
    legal: '法律信息',
    terms: '服务条款',
    privacy: '隐私政策',
    driveEngineSource: 'Atum Drive 源代码 (GPL)',
    openSourceLicences: '开源许可',
    deleteAccount: '删除账户',
    deleteAccountHelp: `发邮件至 ${privacy} · 30 天内删除`,
    deleteAccountTip: '请从你登录所用的邮箱发送。我们确认是你本人后，会在 30 天内删除你的账户和数据。',
    deleteAccountAction: '删除账户…',
    deleteAccountDialogTitle: '删除你的账户？',
    deleteAccountDialogBody: '你的账户及其数据将在 30 天内删除。',
    deleteAccountConfirm: '删除账户',
    deleteAccountSubject: '申请删除 Atum 账户',
    deleteAccountBody: '请删除我的 Atum 账户。',
    deleteAccountFailed: `无法打开邮件应用。请用你登录所用的邮箱发送邮件至 ${privacy}。`,
    seller: `销售方：${company.englishName} · 企业代码 ${company.enterpriseCode} · ${company.headOffice.en} · ${support}`
  },
  'zh-hant': {
    legal: '法律資訊',
    terms: '服務條款',
    privacy: '隱私權政策',
    driveEngineSource: 'Atum Drive 原始碼 (GPL)',
    openSourceLicences: '開放原始碼授權',
    deleteAccount: '刪除帳戶',
    deleteAccountHelp: `寄信至 ${privacy} · 30 天內刪除`,
    deleteAccountTip: '請從你登入使用的電子郵件地址寄出。我們確認是你本人後，會在 30 天內刪除你的帳戶和資料。',
    deleteAccountAction: '刪除帳戶…',
    deleteAccountDialogTitle: '刪除你的帳戶？',
    deleteAccountDialogBody: '你的帳戶及其資料將在 30 天內刪除。',
    deleteAccountConfirm: '刪除帳戶',
    deleteAccountSubject: '申請刪除 Atum 帳戶',
    deleteAccountBody: '請刪除我的 Atum 帳戶。',
    deleteAccountFailed: `無法開啟郵件 App。請用你登入使用的電子郵件地址寄信至 ${privacy}。`,
    seller: `銷售方：${company.englishName} · 企業代碼 ${company.enterpriseCode} · ${company.headOffice.en} · ${support}`
  }
}

export function matrixLegalCopy(locale: Locale): MatrixLegalCopy {
  return copy[locale] ?? copy.vi
}

export function useMatrixLegalCopy(): MatrixLegalCopy {
  return matrixLegalCopy(useI18n().locale)
}
