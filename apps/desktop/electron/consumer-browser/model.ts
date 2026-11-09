import { assertSafeBrowserUrl } from '../../shared/browser/policy'

export interface ConsumerBrowserTabInput {
  active: boolean
  tabId: string
  title: string
  url: string
}

export interface SafeConsumerBrowserTab extends ConsumerBrowserTabInput {
  restoreBlocked: boolean
}

export function sanitizeConsumerBrowserTab(
  tab: ConsumerBrowserTabInput,
  assertUrl: (raw: string) => string = assertSafeBrowserUrl
): SafeConsumerBrowserTab {
  try {
    return { ...tab, url: assertUrl(tab.url), restoreBlocked: false }
  } catch {
    return { ...tab, url: 'about:blank', restoreBlocked: true }
  }
}
