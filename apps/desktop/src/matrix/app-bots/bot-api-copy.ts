type BotApiLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

interface BotApiCopy {
  photo: string
  photoUnavailable: string
  openPhoto: string
}

const copy: Record<BotApiLocale, BotApiCopy> = {
  en: { photo: 'Photo', photoUnavailable: 'Photo unavailable', openPhoto: 'Open photo' },
  vi: { photo: 'Ảnh', photoUnavailable: 'Không tải được ảnh', openPhoto: 'Mở ảnh' },
  ja: { photo: '写真', photoUnavailable: '写真を表示できません', openPhoto: '写真を開く' },
  zh: { photo: '照片', photoUnavailable: '照片不可用', openPhoto: '打开照片' },
  'zh-hant': { photo: '照片', photoUnavailable: '照片無法使用', openPhoto: '開啟照片' }
}

export function botApiCopy(locale: string | undefined): BotApiCopy {
  return copy[
    locale === 'vi' || locale === 'ja' || locale === 'zh' || locale === 'zh-hant' ? locale : 'en'
  ]
}
