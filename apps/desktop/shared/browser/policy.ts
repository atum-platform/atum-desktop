import { isIP } from 'node:net'

import type { BrowserBoundsInput } from './ipc'

const MAX_ADDRESS_LENGTH = 2_048
const SEARCH_ORIGIN = 'https://www.google.com/search?q='

function ipv4IsPrivate(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)

  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {return false}
  const [a, b, c] = octets as [number, number, number, number]

  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function embeddedIpv4IsPrivate(host: string): boolean {
  const match = /^(?:::ffff:(?:0:)?|::|64:ff9b::|64:ff9b:1::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host)

  const privatePair = (highText: string, lowText: string, invert = false): boolean => {
    let high = Number.parseInt(highText, 16)
    let low = Number.parseInt(lowText, 16)

    if (invert) {
      high ^= 0xffff
      low ^= 0xffff
    }

    return ipv4IsPrivate(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
  }

  if (match && privatePair(match[1]!, match[2]!)) {return true}
  const pieces = host.split('::')

  if (pieces.length > 2) {return false}
  const left = pieces[0] ? pieces[0].split(':') : []
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : []
  const zeroCount = pieces.length === 2 ? 8 - left.length - right.length : 0
  const words = [...left, ...Array.from({ length: zeroCount }, () => '0'), ...right]

  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/u.test(word))) {return false}

  if (words[0] === '2002' && privatePair(words[1]!, words[2]!)) {return true}

  return (
    words[0] === '2001' &&
    Number.parseInt(words[1]!, 16) === 0 &&
    (privatePair(words[2]!, words[3]!) || privatePair(words[6]!, words[7]!, true))
  )
}

export function hostIsLocalOrPrivate(hostname: string): boolean {
  const isIpv6Literal = hostname.includes(':')

  const host = hostname
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
    .replace(/\.$/u, '')

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'host.docker.internal' ||
    host === 'local' ||
    host.endsWith('.local')
  )
    {return true}

  if (
    isIpv6Literal &&
    (host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('ff') ||
      embeddedIpv4IsPrivate(host))
  )
    {return true}

  return ipv4IsPrivate(host)
}

export function assertPublicResolvedAddresses(addresses: readonly string[]): void {
  if (
    addresses.length === 0 ||
    addresses.some(address => {
      const family = isIP(address)

      if (family === 0) {return true}

      if (family === 4) {return ipv4IsPrivate(address)}

      try {
        return hostIsLocalOrPrivate(new URL(`http://[${address}]/`).hostname)
      } catch {
        return true
      }
    })
  ) {
    throw new Error('browser_url_blocked')
  }
}

function assertSafeNetworkUrl(raw: string, protocols: readonly string[]): string {
  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('browser_url_invalid')
  }

  if (
    !protocols.includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    hostIsLocalOrPrivate(parsed.hostname)
  ) {
    throw new Error('browser_url_blocked')
  }

  return parsed.href
}

export function assertSafeBrowserUrl(raw: string): string {
  if (raw === 'about:blank') {return raw}

  return assertSafeNetworkUrl(raw, ['http:', 'https:'])
}

export function assertSafeBrowserRequestUrl(raw: string): string {
  return assertSafeNetworkUrl(raw, ['http:', 'https:', 'ws:', 'wss:'])
}

export function normalizeBrowserInput(input: string): string {
  const value = input.trim()

  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error('browser_url_invalid')
  }

  if (/^https?:\/\//iu.test(value) || value === 'about:blank') {return assertSafeBrowserUrl(value)}
  const authority = value.split('/', 1)[0] ?? ''
  const looksLikeIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/u.test(authority)
  const looksLikeIpv6 = /^\[[0-9a-f:.]+\](?::\d{1,5})?$/iu.test(authority)
  const looksLikeDnsName = /[a-z\u0080-\uFFFF]/iu.test(authority) && /^[^\s/]+\.[^\s/]+$/u.test(authority)

  if ((looksLikeIpv4 || looksLikeIpv6 || looksLikeDnsName) && /^[^\s/]+(?:\/.*)?$/u.test(value)) {
    return assertSafeBrowserUrl(`https://${value}`)
  }

  return `${SEARCH_ORIGIN}${encodeURIComponent(value)}`
}

function requireBounds(values: readonly number[]) {
  if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 20_000)) {
    throw new Error('browser_bounds_invalid')
  }
}

/** DOM CSS pixels become native DIPs at the host's current Chromium zoom.
 * Same conversion as the existing PDF surface; preserve the browser IPC's
 * integer/nonnegative bounds contract before rounding the scaled result. */
export function scaleBrowserBounds(input: BrowserBoundsInput, factor: number): BrowserBoundsInput {
  requireBounds([input.x, input.y, input.width, input.height])
  const z = Number.isFinite(factor) && factor > 0 ? factor : 1

  return {
    x: Math.round(input.x * z),
    y: Math.round(input.y * z),
    width: Math.round(input.width * z),
    height: Math.round(input.height * z)
  }
}

export function clampBrowserBounds(
  input: BrowserBoundsInput,
  content: { height: number; width: number }
): BrowserBoundsInput {
  const values = [input.x, input.y, input.width, input.height, content.width, content.height]

  requireBounds(values)

  const x = Math.min(input.x, content.width)
  const y = Math.min(input.y, content.height)

  return {
    x,
    y,
    width: Math.min(input.width, content.width - x),
    height: Math.min(input.height, content.height - y)
  }
}
