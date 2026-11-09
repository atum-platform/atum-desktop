import { createHash } from 'node:crypto'

import {
  MATRIX_DEBUG_DESTINATIONS,
  MATRIX_DEBUG_LABELS,
  type MatrixDebugConfirmation,
  type MatrixDebugDestination,
  type MatrixDebugLabel,
  type MatrixDebugPreview,
  type MatrixDebugStatus
} from '../../shared/matrix-debug-share'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/command-center/debug-share/'
const MAX_BYTES = 3 * 1024 * 1024
interface Options {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(value: MatrixDebugConfirmation): Promise<boolean>
  open(url: string): Promise<unknown>
  copy(url: string): Promise<void>
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function fail(code = 'matrix_debug_share_invalid_response'): never {
  throw new Error(code)
}

function label(v: unknown): v is MatrixDebugLabel {
  return MATRIX_DEBUG_LABELS.includes(v as MatrixDebugLabel)
}

function destination(v: unknown): v is MatrixDebugDestination {
  return MATRIX_DEBUG_DESTINATIONS.includes(v as MatrixDebugDestination)
}

function validUrl(v: unknown, host: MatrixDebugDestination): v is string {
  return (
    typeof v === 'string' &&
    !/\s/.test(v) &&
    new RegExp(`^https://${host.split('.').join('\\.')}/[A-Za-z0-9_-]{1,100}(?:\\.txt)?/?$`).test(v)
  )
}

export function isMatrixDebugShareRequest(value: unknown): boolean {
  return record(value) && typeof value.path === 'string' && value.path.startsWith(PREFIX)
}

/** Captured token and URL custody stay native. Renderer authority is only a
 * fixed public provider and a subset of the locally previewed file labels. */
export class MatrixPagesDebugShareScope {
  private captured?: { token: string; expires: number; value: MatrixDebugPreview }
  private writing = false
  constructor(private readonly options: Options) {}
  private current(): void {
    if (!this.options.isCurrent()) {
      fail('matrix_pages_agent_unavailable')
    }
  }
  private async forward(value: MatrixPagesForwardRequest): Promise<unknown> {
    this.current()
    const result = await this.options.forward(value)
    this.current()

    return result
  }
  private project(raw: unknown): MatrixDebugStatus {
    if (
      !record(raw) ||
      raw.profile_scoped !== true ||
      !['unknown', 'running', 'succeeded', 'uncertain'].includes(raw.state as string) ||
      !(raw.destination === null || destination(raw.destination)) ||
      !Array.isArray(raw.urls) ||
      raw.urls.length > 5 ||
      !(raw.uncertain_label === null || label(raw.uncertain_label))
    ) {
      fail()
    }

    const seen = new Set<string>()

    const urls = raw.urls.map(item => {
      if (
        !record(item) ||
        !label(item.label) ||
        !destination(raw.destination) ||
        !validUrl(item.url, raw.destination) ||
        seen.has(item.label)
      ) {
        fail()
      }

      seen.add(item.label)

      return { label: item.label, url: item.url }
    })

    if (raw.state === 'unknown' && (urls.length || raw.destination !== null)) {
      fail()
    }

    return {
      state: raw.state as MatrixDebugStatus['state'],
      destination: raw.destination as MatrixDebugDestination | null,
      urls,
      uncertainLabel: raw.uncertain_label as MatrixDebugLabel | null
    }
  }
  private async status(): Promise<MatrixDebugStatus> {
    return this.project(await this.forward({ path: '/api/debug-share/status?profile=default', method: 'GET' }))
  }
  private async preview(): Promise<MatrixDebugPreview> {
    const raw = await this.forward({ path: '/api/debug-share/preview?profile=default', method: 'POST' })

    if (
      !record(raw) ||
      raw.profile_scoped !== true ||
      typeof raw.token !== 'string' ||
      !/^[a-f0-9]{32}$/.test(raw.token) ||
      typeof raw.expires_at !== 'number' ||
      !Number.isFinite(raw.expires_at) ||
      raw.expires_at * 1000 <= Date.now() ||
      raw.expires_at * 1000 > Date.now() + 610_000 ||
      !Array.isArray(raw.files) ||
      raw.files.length < 1 ||
      raw.files.length > 5
    ) {
      fail()
    }

    const seen = new Set<string>()
    let total = 0

    const files = raw.files.map(item => {
      if (
        !record(item) ||
        !label(item.label) ||
        seen.has(item.label) ||
        typeof item.text !== 'string' ||
        typeof item.bytes !== 'number' ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0 ||
        item.bytes !== Buffer.byteLength(item.text, 'utf8') ||
        typeof item.digest !== 'string' ||
        item.digest !== createHash('sha256').update(item.text).digest('hex')
      ) {
        fail()
      }

      seen.add(item.label)
      total += item.bytes

      return { label: item.label, text: item.text, bytes: item.bytes }
    })

    if (!seen.has('report') || total > MAX_BYTES) {
      fail()
    }

    const value = { files }
    this.captured = { token: raw.token, expires: raw.expires_at * 1000, value }

    return value
  }
  private async upload(body: Record<string, unknown>) {
    if (
      Object.keys(body).some(k => !['destination', 'labels'].includes(k)) ||
      !destination(body.destination) ||
      !Array.isArray(body.labels) ||
      body.labels.length < 1 ||
      body.labels.length > 5 ||
      !body.labels.every(label) ||
      new Set(body.labels).size !== body.labels.length ||
      !body.labels.includes('report')
    ) {
      fail('matrix_pages_request_denied')
    }

    const captured = this.captured

    if (
      !captured ||
      captured.expires <= Date.now() ||
      body.labels.some(l => !captured.value.files.some(f => f.label === l))
    ) {
      fail('matrix_debug_preview_expired')
    }

    const before = await this.status() // older runtimes fail before irreversible upload

    if (before.state === 'running') {
      return { status: 'started', value: before }
    }

    const selected = captured.value.files.filter(f => (body.labels as MatrixDebugLabel[]).includes(f.label))

    if (
      !(await this.options.confirm({
        destination: body.destination,
        files: selected.map(({ label, bytes }) => ({ label, bytes }))
      }))
    ) {
      this.current()

      return { status: 'cancelled' }
    }

    this.current()

    if (captured !== this.captured || captured.expires <= Date.now()) {
      fail('matrix_debug_preview_expired')
    }

    // Consume locally before the POST. An unknown response never restores it.
    this.captured = undefined

    return {
      status: 'started',
      value: this.project(
        await this.forward({
          path: '/api/debug-share/upload?profile=default',
          method: 'POST',
          body: { token: captured.token, destination: body.destination, labels: selected.map(f => f.label) }
        })
      )
    }
  }
  async request(value: unknown): Promise<unknown> {
    if (
      !record(value) ||
      Object.keys(value).some(k => !['path', 'method', 'body'].includes(k)) ||
      typeof value.path !== 'string'
    ) {
      fail('matrix_pages_request_denied')
    }

    const match =
      /^\/api\/command-center\/debug-share\/(preview|status|upload|open|copy)(?:\/(report|agent\.log|gateway\.log|gui\.log|desktop\.log))?$/.exec(
        value.path
      )

    if (
      !match ||
      (match[1] === 'status' ? value.method !== undefined && value.method !== 'GET' : value.method !== 'POST') ||
      (match[1] === 'upload' ? !record(value.body) : value.body !== undefined) ||
      (['open', 'copy'].includes(match[1]) ? !match[2] : Boolean(match[2]))
    ) {
      fail('matrix_pages_request_denied')
    }

    this.current()
    let claimed = false

    try {
      if (match[1] === 'status') {
        return await this.status()
      }

      if (this.writing) {
        fail('pages_agent_busy')
      }

      this.writing = true
      claimed = true

      if (match[1] === 'preview') {
        return await this.preview()
      }

      if (match[1] === 'upload') {
        return await this.upload(value.body as Record<string, unknown>)
      }

      const result = await this.status()
      const url = result.urls.find(item => item.label === match[2])?.url

      if (!url) {
        fail('matrix_debug_link_unavailable')
      }

      this.current()

      if (match[1] === 'open') {
        await this.options.open(url)
      } else {
        await this.options.copy(url)
      }

      this.current()

      return { ok: true }
    } catch (error) {
      this.current()
      const code = error instanceof Error ? error.message : ''

      if (/^(?:matrix_debug_|matrix_pages_|pages_agent_|pages_hermes_)[a-z_]+$/.test(code)) {
        throw error
      }

      fail('matrix_debug_share_failed')
    } finally {
      if (claimed) {
        this.writing = false
      }
    }
  }
}
