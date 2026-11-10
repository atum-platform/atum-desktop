/** Platform-neutral wire contract for consented Mac source requests and bounded scans. */
const REQUEST_BYTES = 4_096

export type MacSourcesRequest =
  | { op: 'messages.conversations'; days: number; limit: number }
  | { op: 'messages.read'; id: string; days: number; limit: number }
  | {
      op: 'browser.history'
      browser: 'safari' | 'chrome' | 'all'
      days: number
      limit: number
      mode: 'recent' | 'top'
    }
  | { op: 'location.current'; precision: 'city' | 'precise' }

function strictObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function boundedInt(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high
}

export function parseMacSourcesRequest(value: unknown): MacSourcesRequest | null {
  if (!strictObject(value)) {
    return null
  }

  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > REQUEST_BYTES) {
      return null
    }
  } catch {
    return null
  }

  if (
    value.op === 'messages.conversations' &&
    exactKeys(value, ['op', 'days', 'limit']) &&
    boundedInt(value.days, 1, 365) &&
    boundedInt(value.limit, 1, 40)
  ) {
    return value as MacSourcesRequest
  }

  if (
    value.op === 'messages.read' &&
    exactKeys(value, ['op', 'id', 'days', 'limit']) &&
    typeof value.id === 'string' &&
    /^\d{1,18}$/u.test(value.id) &&
    boundedInt(value.days, 1, 90) &&
    boundedInt(value.limit, 1, 60)
  ) {
    return value as MacSourcesRequest
  }

  if (
    value.op === 'browser.history' &&
    exactKeys(value, ['op', 'browser', 'days', 'limit', 'mode']) &&
    typeof value.browser === 'string' &&
    ['safari', 'chrome', 'all'].includes(value.browser) &&
    boundedInt(value.days, 1, 90) &&
    boundedInt(value.limit, 1, 100) &&
    typeof value.mode === 'string' &&
    ['recent', 'top'].includes(value.mode)
  ) {
    return value as MacSourcesRequest
  }

  if (
    value.op === 'location.current' &&
    exactKeys(value, ['op', 'precision']) &&
    typeof value.precision === 'string' &&
    ['city', 'precise'].includes(value.precision)
  ) {
    return value as MacSourcesRequest
  }

  return null
}

export function scanRequest(operation: unknown): Record<string, unknown> | null {
  switch (operation) {
    case 'mac.list_message_conversations': return { op: 'messages.conversations', days: 1, limit: 40 }

    case 'mac.list_browser_history': return { op: 'browser.history', browser: 'all', days: 1, limit: 50, mode: 'recent' }

    case 'mac.read_city_location': return { op: 'location.current', precision: 'city' }

    default: return null
  }
}

export interface MacSourceScanResult {
  error?: string
  status?: 'ok'
  cursor?: string
  entries?: Array<{ objectId: string; observedAt: number; provenance: { deviceServiceId: string }; fresh: boolean; data: unknown }>
}

/** Validate a scan envelope before admitting it to the sweep; one day, fifty rows, no bodies. */
export function boundedScan(value: unknown, device: string, now = Date.now()): MacSourceScanResult | null {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > 96 * 1024) return null
      value = JSON.parse(value)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 96 * 1024) return null
    const r = value as MacSourceScanResult
    if (Object.keys(r).sort().join(',') !== 'cursor,entries,status' || r.status !== 'ok' || !Array.isArray(r.entries) || r.entries.length > 50 || typeof r.cursor !== 'string' || r.cursor.length > 2048) return null
    if (r.entries.some(e => e.provenance?.deviceServiceId !== device || !e.objectId?.startsWith(`${device}:`) ||
      !Number.isFinite(e.observedAt) || e.observedAt < now - 86_400_000 || e.observedAt > now || typeof e.fresh !== 'boolean')) return null
    if (r.entries.some(e => !safeScanData(e.data))) return null
    return r
  } catch { return null }
}

function safeScanData(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  const keys = Object.keys(r).sort().join(',')
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v)
  if (keys === 'fromMeShare,id,isGroup,lastActivity,messageCount,participants,title') {
    return typeof r.id === 'string' && /^[1-9][0-9]{0,17}$/.test(r.id) && text(r.title, 120) &&
      typeof r.isGroup === 'boolean' && Number.isSafeInteger(r.messageCount) && Number(r.messageCount) >= 0 &&
      typeof r.fromMeShare === 'number' && r.fromMeShare >= 0 && r.fromMeShare <= 1 &&
      typeof r.lastActivity === 'string' && Number.isFinite(Date.parse(r.lastActivity)) &&
      Array.isArray(r.participants) && r.participants.length <= 20 && r.participants.every(p => p && typeof p === 'object' &&
        Object.keys(p).every(k => k === 'name' || k === 'handle') &&
        (p.name === undefined || text(p.name, 120)) && (p.handle === undefined || /^Contact [a-f0-9]{6}$/.test(p.handle)))
  }
  if (keys === 'browser,domain,lastVisit,path,title,visits') {
    if (!text(r.path, 512) || !text(r.title, 240) || !text(r.domain, 253) ||
      !/^[a-z0-9.-]+$/i.test(String(r.domain)) || !['safari', 'chrome'].includes(String(r.browser)) ||
      !Number.isSafeInteger(r.visits) || Number(r.visits) < 1 || typeof r.lastVisit !== 'string' || !Number.isFinite(Date.parse(r.lastVisit))) return false
    try {
      const path = decodeURIComponent(String(r.path))
      return path.startsWith('/') && !/[?#]/.test(path) && !/(?:auth|login|token|password|session|oauth|callback|reset|verify|credential)/i.test(path + ' ' + r.title) &&
        !path.split('/').some(part => /^[A-Za-z0-9_-]{24,}$/.test(part))
    } catch { return false }
  }
  return Object.keys(r).every(k => ['city', 'region', 'country', 'timeZone'].includes(k)) &&
    text(r.timeZone, 128) && Object.values(r).every(v => text(v, 128))
}
