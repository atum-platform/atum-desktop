import { type Locale, useI18n } from '@/i18n'

const en = {
  notifications: 'Unread notifications'
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    notifications: 'Thông báo chưa đọc'
  },
  ja: {
    notifications: '未読通知'
  },
  zh: {
    notifications: '未读通知'
  },
  'zh-hant': {
    notifications: '未讀通知'
  }
}

export function useReadStateCopy() {
  return copies[useI18n().locale]
}
