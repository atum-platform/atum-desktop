import type { CloudTrialOffer } from './cloud-agent'

type TrialLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

/** What the trial includes, already formatted: storage only when the offer grants some. */
interface TrialGrants {
  days: string
  hours: string
  protons: string
  storage?: string
  tasks: string
}

interface TrialConfirmWords {
  title: string
  detail: (grants: TrialGrants, concurrentTasks: number) => string
  start: string
  cancel: string
}

const COPY: Record<TrialLocale, TrialConfirmWords> = {
  en: {
    title: 'Start the free cloud trial?',
    detail: ({ days, hours, protons, storage, tasks }, concurrentTasks) =>
      `${days} days free · ${hours} cloud hours · ${protons} AI Protons` +
      `${storage ? ` · ${storage} storage` : ''} · ${tasks} concurrent ${concurrentTasks === 1 ? 'task' : 'tasks'}/assistant · no card or renewal`,
    start: 'Start the free trial',
    cancel: 'Not now'
  },
  vi: {
    title: 'Bắt đầu dùng thử đám mây miễn phí?',
    detail: ({ days, hours, protons, storage, tasks }) =>
      `${days} ngày miễn phí · ${hours} giờ đám mây · ${protons} Proton AI` +
      `${storage ? ` · ${storage} lưu trữ` : ''} · ${tasks} việc cùng lúc/trợ lý · không thẻ, không gia hạn`,
    start: 'Bắt đầu dùng thử',
    cancel: 'Để sau'
  },
  ja: {
    title: '無料のクラウドトライアルを始めますか？',
    detail: ({ days, hours, protons, storage, tasks }) =>
      `${days} 日無料 · クラウド ${hours} 時間 · AI ${protons} Proton` +
      `${storage ? ` · ${storage} ストレージ` : ''} · 同時 ${tasks} 件/アシスタント · カード・自動更新なし`,
    start: 'トライアルを始める',
    cancel: 'あとで'
  },
  zh: {
    title: '开始免费云端试用？',
    detail: ({ days, hours, protons, storage, tasks }) =>
      `免费 ${days} 天 · 云端 ${hours} 小时 · AI ${protons} Proton` +
      `${storage ? ` · ${storage} 存储` : ''} · 每位助手同时 ${tasks} 个任务 · 无银行卡或续订`,
    start: '开始试用',
    cancel: '以后再说'
  },
  'zh-hant': {
    title: '開始免費雲端試用？',
    detail: ({ days, hours, protons, storage, tasks }) =>
      `免費 ${days} 天 · 雲端 ${hours} 小時 · AI ${protons} Proton` +
      `${storage ? ` · ${storage} 儲存空間` : ''} · 每位助理同時 ${tasks} 個工作 · 無信用卡或續約`,
    start: '開始試用',
    cancel: '稍後再說'
  }
}

const DAY_MS = 86_400_000
const GIB = 1_073_741_824

/** main's confirmation of the exact offer it is about to accept, naming every grant in it, in
 * `locale` (Vietnamese by default). */
export function cloudTrialConfirmCopy(locale: string | undefined, offer: CloudTrialOffer) {
  const key = (Object.hasOwn(COPY, locale ?? '') ? locale : 'vi') as TrialLocale
  const words = COPY[key]
  const number = new Intl.NumberFormat(key, { maximumFractionDigits: 1 })
  const whole = new Intl.NumberFormat(key, { maximumFractionDigits: 0 })

  return {
    title: words.title,
    detail: words.detail({
      days: number.format(Math.max(1, Math.round(offer.durationMs / DAY_MS))),
      hours: number.format(offer.computeSeconds / 3600),
      protons: whole.format(Math.floor(offer.includedMicroProtons / 1_000_000)),
      ...(offer.includedStorageBytes > 0 ? { storage: `${number.format(offer.includedStorageBytes / GIB)} GB` } : {}),
      tasks: number.format(offer.concurrentTasks)
    }, offer.concurrentTasks),
    start: words.start,
    cancel: words.cancel
  }
}
