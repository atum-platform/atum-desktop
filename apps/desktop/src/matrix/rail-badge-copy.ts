import { type Locale, useI18n } from '@/i18n'

/** The rail badges' names for assistive tech (layout r2 G). Five locales, changed together. */
const copies: Record<Locale, { waiting: string; new: string; driveProblem: string; storeArrived: string }> = {
  en: { waiting: 'Waiting for you', new: 'Something new', driveProblem: 'Drive needs you', storeArrived: 'Something you got has arrived' },
  vi: { waiting: 'Đang chờ bạn', new: 'Có điều mới', driveProblem: 'Drive cần bạn xử lý', storeArrived: 'Món bạn nhận đã đến' },
  ja: { waiting: 'あなたを待っています', new: '新しいお知らせ', driveProblem: 'Drive で対応が必要です', storeArrived: '入手したものが届きました' },
  zh: { waiting: '等你处理', new: '有新内容', driveProblem: 'Drive 需要你处理', storeArrived: '你获得的项目已到' },
  'zh-hant': { waiting: '等你處理', new: '有新內容', driveProblem: 'Drive 需要你處理', storeArrived: '你取得的項目已送達' }
}

export function railBadgeCopy(locale: Locale) {
  return copies[locale]
}

export function useRailBadgeCopy() {
  return copies[useI18n().locale]
}
