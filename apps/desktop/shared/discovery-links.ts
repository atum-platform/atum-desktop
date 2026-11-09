/** First-party fragment links: handled by Atum, never an acquisition command. */
export function storeListingLink(itemId: string): string {
  return `https://atumplatform.com/#atum-store/${encodeURIComponent(itemId)}`
}

export function appListingLink(appId: string): string {
  return `https://atumplatform.com/#atum-app/${appId}`
}

export function parseDiscoveryLink(
  input: string
): { kind: 'store'; itemId: string; shelf: 'agents' | 'skills' | 'pets' } | { kind: 'app'; appId: string } | null {
  try {
    const url = new URL(input)
    if (url.origin !== 'https://atumplatform.com' || url.username || url.password || url.pathname !== '/' || url.search)
      {return null}
    if (url.hash.startsWith('#atum-store/')) {
      const itemId = decodeURIComponent(url.hash.slice('#atum-store/'.length))
      if (!/^(skill|agent|pet)\/[a-z0-9][a-z0-9_/-]{0,119}$/.test(itemId)) {return null}
      return {
        kind: 'store',
        itemId,
        shelf: itemId.startsWith('skill/') ? 'skills' : itemId.startsWith('agent/') ? 'agents' : 'pets'
      }
    }
    const appId = url.hash.slice('#atum-app/'.length)
    return url.hash.startsWith('#atum-app/') && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(appId)
      ? { kind: 'app', appId }
      : null
  } catch {
    return null
  }
}
