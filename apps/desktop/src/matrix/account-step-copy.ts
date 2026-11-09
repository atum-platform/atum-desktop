import { type Locale, useI18n } from '@/i18n'

/**
 * The recovery step's one sentence, by what the account already has: no key yet (this is
 * the first Mac: make one) or a key on the server (another Mac: approve it from another device,
 * or enter the key). The panel's own buttons and fields keep their words in security-copy.ts and
 * shared/matrix-approval-copy.ts.
 */
interface AccountStepCopy {
  setUpTitle: string
  setUpHelp: string
  unlockTitle: string
  unlockHelp: string
}

const copies: Record<Locale, AccountStepCopy> = {
  en: {
    setUpTitle: 'Save your recovery key',
    setUpHelp: 'You’ll need it to read your messages on another Mac.',
    unlockTitle: 'Unlock your messages on this Mac',
    unlockHelp:
      'Approve this Mac from your other device, or enter your recovery key. On a Mac that has it: Settings › Privacy & Security.'
  },
  vi: {
    setUpTitle: 'Lưu khóa khôi phục',
    setUpHelp: 'Bạn sẽ cần khóa này để đọc tin nhắn trên một máy Mac khác.',
    unlockTitle: 'Mở khóa tin nhắn trên Mac này',
    unlockHelp:
      'Cho phép Mac này từ máy khác của bạn, hoặc nhập khóa khôi phục. Trên máy Mac đang có khóa: Cài đặt › Quyền riêng tư & Bảo mật.'
  },
  ja: {
    setUpTitle: '復旧キーを保存',
    setUpHelp: '別の Mac でメッセージを読むときに必要です。',
    unlockTitle: 'この Mac でメッセージのロックを解除',
    unlockHelp:
      'ほかの端末からこの Mac を承認するか、復旧キーを入力してください。キーのある Mac では「設定 › プライバシーとセキュリティ」にあります。'
  },
  zh: {
    setUpTitle: '保存恢复密钥',
    setUpHelp: '在另一台 Mac 上阅读消息时需要它。',
    unlockTitle: '在这台 Mac 上解锁消息',
    unlockHelp: '从你的另一台设备批准这台 Mac，或输入恢复密钥。在有密钥的 Mac 上：设置 › 隐私与安全性。'
  },
  'zh-hant': {
    setUpTitle: '儲存復原金鑰',
    setUpHelp: '在另一台 Mac 上閱讀訊息時需要它。',
    unlockTitle: '在這台 Mac 上解鎖訊息',
    unlockHelp: '從你的另一台裝置核准這台 Mac，或輸入復原金鑰。在有金鑰的 Mac 上：設定 › 隱私權與安全性。'
  }
}

export function matrixAccountStepCopy(locale: Locale): AccountStepCopy {
  return copies[locale]
}

export function useAccountStepCopy(): AccountStepCopy {
  return matrixAccountStepCopy(useI18n().locale)
}
