import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'

import type { I18nConfigClient } from './context'

/** Only legacy Hermes composition roots opt into profile-config synchronization. */
export const hermesI18nConfigClient: I18nConfigClient = {
  getConfig: () =>
    typeof window === 'undefined' || !window.hermesDesktop?.api ? Promise.resolve({}) : getHermesConfigRecord(),
  saveConfig: config =>
    typeof window === 'undefined' || !window.hermesDesktop?.api
      ? Promise.resolve({ ok: true })
      : saveHermesConfig(config)
}
