import { type Locale, useI18n } from '@/i18n'

/** What the roster's atom says about an assistant at work (launch night, 2026-10-04). */
const en = {
  working: (name: string) => `${name} is working`,
  /** A chat with people where one of your assistants is answering. */
  assistantWorking: 'Your assistant is working'
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    working: name => `${name} đang làm việc`,
    assistantWorking: 'Trợ lý của bạn đang làm việc'
  },
  ja: {
    working: name => `${name} が作業中です`,
    assistantWorking: 'アシスタントが作業中です'
  },
  zh: {
    working: name => `${name} 正在工作`,
    assistantWorking: '你的助手正在工作'
  },
  'zh-hant': {
    working: name => `${name} 正在工作`,
    assistantWorking: '你的助理正在工作'
  }
}

export function useWorkingCopy() {
  return copies[useI18n().locale]
}
