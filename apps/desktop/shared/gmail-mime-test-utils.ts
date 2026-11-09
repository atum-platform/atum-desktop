/**
 * Test helpers only (never imported by product code): read a Gmail `raw` message back the way a mail
 * client would, so tests compare what a recipient sees, not the builder's own strings.
 */

import { execFileSync } from 'node:child_process'

export interface DecodedPart {
  headers: Record<string, string>
  contentType: string
  /** Parameters of Content-Type / Content-Disposition, decoded (RFC 2047 words joined). */
  params: Record<string, string>
  disposition: string
  /** Decoded bytes (base64 → bytes) of a leaf part. */
  bytes?: Buffer
  parts?: DecodedPart[]
}

/** An RFC 2047 value (`=?UTF-8?B?...?=` words, possibly folded) as text. */
export function decodeWords(value: string): string {
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ')
  const words = [...unfolded.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)]

  if (!words.length) {
    return unfolded
  }

  // Adjacent encoded words are one value; whitespace between them is not part of it.
  return words.map(match => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[1]!, 'base64'))).join('')
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const line of block.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':')

    if (colon > 0) {
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
    }
  }

  return headers
}

/** RFC 2231 value: `charset'language'percent-encoded`, or continuation segments joined first. */
function extendedValue(raw: string): string {
  const match = /^([^']*)'[^']*'([\s\S]*)$/.exec(raw)
  const bytes = Buffer.from((match ? match[2]! : raw).replace(/%([0-9A-Fa-f]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1')

  return new TextDecoder(match?.[1]?.toLowerCase() === 'utf-8' ? 'utf-8' : 'utf-8', { fatal: true }).decode(bytes)
}

function params(value: string): { main: string; params: Record<string, string> } {
  const [main = '', ...rest] = value.replace(/\r\n[ \t]+/g, ' ').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  const plain: Record<string, string> = {}
  const extended: Record<string, string> = {}
  const pieces: Record<string, Array<[number, string]>> = {}

  for (const item of rest) {
    const equals = item.indexOf('=')

    if (equals <= 0) {
      continue
    }

    const key = item.slice(0, equals).trim().toLowerCase()
    const raw = item.slice(equals + 1).trim()
    const quoted = /^"([\s\S]*)"$/.exec(raw)
    const continued = /^([^*]+)\*(\d+)(\*?)$/.exec(key)

    if (continued) {
      (pieces[continued[1]!] ??= []).push([Number(continued[2]), raw])
    } else if (key.endsWith('*')) {
      extended[key.slice(0, -1)] = extendedValue(raw)
    } else {
      // RFC 822 quoted-string: backslash escapes the next character. No RFC 2047 words here (RFC 2047 section 5).
      plain[key] = quoted ? quoted[1]!.replace(/\\(.)/g, '$1') : raw
    }
  }

  for (const [name, list] of Object.entries(pieces)) {
    // The first segment carries `charset'language'`; the rest are bare percent-encoded text.
    extended[name] = extendedValue(list.sort((a, b) => a[0] - b[0]).map(([, value]) => value).join(''))
  }

  // The extended form wins over the ASCII fallback, as every RFC 2231 reader does.
  return { main: main.trim().toLowerCase(), params: { ...plain, ...extended } }
}

function decodeEntity(text: string): DecodedPart {
  const split = text.indexOf('\r\n\r\n')
  const headers = parseHeaders(split < 0 ? text : text.slice(0, split))
  const body = split < 0 ? '' : text.slice(split + 4)
  const type = params(headers['content-type'] ?? 'text/plain')
  const disposition = params(headers['content-disposition'] ?? '')
  const merged = { ...disposition.params, ...type.params }

  if (type.main.startsWith('multipart/')) {
    const boundary = type.params.boundary!
    const sections = body.split(`--${boundary}`).slice(1)
    const closing = sections.findIndex(section => section.startsWith('--'))
    const real = (closing < 0 ? sections : sections.slice(0, closing)).map(section => section.replace(/^\r\n/, '').replace(/\r\n$/, ''))

    return { headers, contentType: type.main, params: merged, disposition: disposition.main, parts: real.map(decodeEntity) }
  }

  const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase()

  return {
    headers, contentType: type.main, params: merged, disposition: disposition.main,
    bytes: encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'utf8')
  }
}

/** Gmail's base64url `raw` → the top-level entity with its headers and (nested) decoded parts. */
export function decodeRaw(raw: string): DecodedPart & { text: string; files: DecodedPart[]; source: string } {
  return decodeMime(Buffer.from(raw, 'base64url'))
}

/** RFC 822 bytes → the same decoded view. */
export function decodeMime(bytes: Buffer): DecodedPart & { text: string; files: DecodedPart[]; source: string } {
  const source = bytes.toString('utf8')
  const entity = decodeEntity(source)
  const leaves = entity.parts ?? [entity]
  const textPart = leaves.find(part => part.contentType === 'text/plain')

  return {
    ...entity,
    source,
    text: textPart?.bytes?.toString('utf8') ?? '',
    files: leaves.filter(part => part.disposition === 'attachment')
  }
}

/** A Gmail media upload (`/upload/...?uploadType=`) read back: its metadata part (if any) and the message bytes. */
export function parseUpload(contentType: string, body: Buffer | Uint8Array | string): {
  uploadType: 'media' | 'multipart'
  metadata?: Record<string, unknown>
  mime: Buffer
} {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'latin1') : Buffer.from(body)
  const boundary = /^multipart\/related;\s*boundary=(\S+)$/.exec(contentType)?.[1]

  if (!boundary) {
    if (contentType !== 'message/rfc822') {
      throw new Error(`unexpected upload type ${contentType}`)
    }

    return { uploadType: 'media', mime: bytes }
  }

  // Binary-safe: latin1 keeps one character per byte.
  const text = bytes.toString('latin1')
  const [, json, message] = text.split(`--${boundary}`)
  const metadata = JSON.parse(json!.split('\r\n\r\n')[1]!.replace(/\r\n$/, ''))
  const rfc = message!.slice(message!.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')

  return { uploadType: 'multipart', metadata, mime: Buffer.from(rfc, 'latin1') }
}

/** What Python's standard `email` package (an independent MIME implementation) makes of a message. */
export function pythonParse(mime: Buffer, options: { withoutAsciiFallback?: boolean } = {}): {
  subject: string
  to: string
  cc: string
  text: string
  attachments: Array<{ filename: string; contentType: string; name: string; size: number; sha256: string }>
} {
  const script = [
    'import sys, json, hashlib, email',
    'from email import policy',
    'msg = email.message_from_bytes(sys.stdin.buffer.read(), policy=policy.default)',
    'body = msg.get_body(preferencelist=("plain",))',
    'files = []',
    'for part in msg.iter_attachments():',
    '    data = part.get_payload(decode=True)',
    '    files.append({"filename": part.get_filename(), "contentType": part.get_content_type(), "name": part.get_param("name"), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})',
    'print(json.dumps({"subject": str(msg["subject"]), "to": str(msg["to"] or ""), "cc": str(msg["cc"] or ""), "text": body.get_content() if body else "", "attachments": files}, ensure_ascii=False))'
  ].join('\n')

  // Python (like some other readers) takes the first `filename=` it meets, so the RFC 2231 form is also checked alone.
  const input = options.withoutAsciiFallback
    ? Buffer.from(mime.toString('latin1').replace(/;\r\n (?:file)?name="(?:[^"\\]|\\.)*"/g, ''), 'latin1')
    : mime

  return JSON.parse(execFileSync('python3', ['-I', '-c', script], { input, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'))
}
