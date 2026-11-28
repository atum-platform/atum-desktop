import { type Locale, useI18n } from '@/i18n'

import type { AgentPlace } from './agent-place'

/** The place icon's one label: its tooltip and what a screen reader hears. */
interface AgentPlaceCopy {
  cloud: string
  mac: (mac: string) => string
  macOff: (mac: string) => string
  /** A Mac whose fact carries no name. */
  aMac: string
}

const en: AgentPlaceCopy = {
  cloud: 'Working in the cloud',
  mac: mac => `Working on ${mac}`,
  macOff: mac => `Works on ${mac}, which is off`,
  aMac: 'a Mac'
}

const vi: AgentPlaceCopy = {
  cloud: 'Đang làm việc trên đám mây',
  mac: mac => `Đang làm việc trên ${mac}`,
  macOff: mac => `Làm việc trên ${mac}, máy đang tắt`,
  aMac: 'một máy Mac'
}

const ja: AgentPlaceCopy = {
  cloud: 'クラウドで作業中',
  mac: mac => `${mac} で作業中`,
  macOff: mac => `${mac} で作業（現在オフ）`,
  aMac: 'Mac'
}

const zh: AgentPlaceCopy = {
  cloud: '正在云端工作',
  mac: mac => `正在 ${mac} 上工作`,
  macOff: mac => `在 ${mac} 上工作（已关闭）`,
  aMac: '一台 Mac'
}

const zhHant: AgentPlaceCopy = {
  cloud: '正在雲端工作',
  mac: mac => `正在 ${mac} 上工作`,
  macOff: mac => `在 ${mac} 上工作（已關閉）`,
  aMac: '一台 Mac'
}

const COPY: Record<Locale, AgentPlaceCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function agentPlaceLabel(place: AgentPlace, locale: Locale): string {
  const copy = COPY[locale]

  if (place.kind === 'cloud') {
    return copy.cloud
  }

  const name = place.name || copy.aMac

  return place.online ? copy.mac(name) : copy.macOff(name)
}

export function useAgentPlaceLabel(place: AgentPlace | undefined): string | undefined {
  const { locale } = useI18n()

  return place ? agentPlaceLabel(place, locale) : undefined
}
