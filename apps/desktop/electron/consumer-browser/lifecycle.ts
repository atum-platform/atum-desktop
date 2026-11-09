export type ConsumerBrowserVisibleStatus = 'blocked' | 'error' | 'loading' | 'ready' | 'start'

export function stoppedNavigationPersistence(
  failed: boolean,
  committed: { title: string; url: string },
  observed: { title: string; url: string }
): { status: 'error' | 'ready'; title: string; url: string } {
  return failed ? { ...committed, status: 'error' } : { ...observed, status: 'ready' }
}

export function browserContentVisible(status: ConsumerBrowserVisibleStatus, committedUrl: string): boolean {
  if (status === 'blocked') {return committedUrl !== 'about:blank'}

  return status !== 'start' && status !== 'error'
}

export function nextPopupWindow(
  previous: readonly number[],
  now: number,
  options: { limit?: number; windowMs?: number } = {}
): { allowed: boolean; timestamps: number[] } {
  if (!Number.isFinite(now) || now < 0) {throw new Error('browser_popup_clock_invalid')}
  const limit = options.limit ?? 3
  const windowMs = options.windowMs ?? 10_000
  const retained = previous.filter(value => Number.isFinite(value) && value >= 0 && now - value < windowMs)

  if (retained.length >= limit) {return { allowed: false, timestamps: retained }}

  return { allowed: true, timestamps: [...retained, now] }
}
