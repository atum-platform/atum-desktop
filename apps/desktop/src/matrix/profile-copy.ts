import { type Locale, useI18n } from '@/i18n'

/** The profile editor's own words; the photo's stay in `t.atum.account`. */
interface ProfileCopy {
  displayName: string
  displayNameHint: string
  save: string
  cancel: string
  done: string
  nameFailed: string
}

const copies: Record<Locale, ProfileCopy> = {
  en: {
    displayName: 'Display name',
    displayNameHint: 'How people see you in chats.',
    save: 'Save',
    cancel: 'Cancel',
    done: 'Done',
    nameFailed: 'Couldn’t save your name. Check your connection and try again.'
  },
  vi: {
    displayName: 'Tên hiển thị',
    displayNameHint: 'Tên mọi người thấy trong các cuộc trò chuyện.',
    save: 'Lưu',
    cancel: 'Hủy',
    done: 'Xong',
    nameFailed: 'Chưa lưu được tên. Kiểm tra kết nối rồi thử lại.'
  },
  ja: {
    displayName: '表示名',
    displayNameHint: 'チャットで相手に表示される名前です。',
    save: '保存',
    cancel: 'キャンセル',
    done: '完了',
    nameFailed: '名前を保存できませんでした。接続を確認して、もう一度お試しください。'
  },
  zh: {
    displayName: '显示名称',
    displayNameHint: '别人在聊天中看到的名字。',
    save: '保存',
    cancel: '取消',
    done: '完成',
    nameFailed: '无法保存你的名字。请检查连接后重试。'
  },
  'zh-hant': {
    displayName: '顯示名稱',
    displayNameHint: '別人在聊天中看到的名字。',
    save: '儲存',
    cancel: '取消',
    done: '完成',
    nameFailed: '無法儲存你的名字。請檢查連線後再試一次。'
  }
}

export function matrixProfileCopy(locale: Locale): ProfileCopy {
  return copies[locale]
}

export function useProfileCopy(): ProfileCopy {
  return matrixProfileCopy(useI18n().locale)
}
