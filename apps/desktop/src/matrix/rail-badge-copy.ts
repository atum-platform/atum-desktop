import { type Locale, useI18n } from '@/i18n'

/** The rail badges' names for assistive tech (layout r2 G). Five locales, changed together. */
const copies: Record<Locale, { waiting: string; new: string; driveProblem: string }> = {
  en: { waiting: 'Waiting for you', new: 'Something new', driveProblem: 'Drive needs you' },
  vi: { waiting: 'Đang chờ bạn', new: 'Có điều mới', driveProblem: 'Drive cần bạn xử lý' },
  ja: { waiting: 'あなたを待っています', new: '新しいお知らせ', driveProblem: 'Drive で対応が必要です' },
  zh: { waiting: '等你处理', new: '有新内容', driveProblem: 'Drive 需要你处理' },
  'zh-hant': { waiting: '等你處理', new: '有新內容', driveProblem: 'Drive 需要你處理' }
}

export function railBadgeCopy(locale: Locale) {
  return copies[locale]
}

export function useRailBadgeCopy() {
  return copies[useI18n().locale]
}
