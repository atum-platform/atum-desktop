import { randomUUID } from 'node:crypto'

import type { MatrixWebPreviewOffer, MatrixWebPreviewTarget } from '../../shared/matrix-workbench-preview'

const TTL = 5 * 60_000

export function matrixWebPreviewTarget(value: unknown): MatrixWebPreviewTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return
  }

  const row = value as Record<string, unknown>

  if (typeof row.url !== 'string' || !row.url.trim() || row.url.length > 4096 || /[\p{Cc}]/u.test(row.url)) {
    return
  }

  try {
    const url = new URL(row.url)

    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return
    }

    const label =
      typeof row.label === 'string' && row.label.trim() && row.label.length <= 120 && !/[\p{Cc}]/u.test(row.label)
        ? row.label.trim()
        : url.hostname

    return { url: url.href, label }
  } catch {
    return
  }
}

/** One foreground offer; never history, cross-room state, or browser authority. */
export class MatrixWebPreviewOffers {
  private entry?: { scope: string; target: MatrixWebPreviewTarget; offer: MatrixWebPreviewOffer; alive(): boolean }

  constructor(private readonly now = Date.now) {}

  receive(scope: string, value: MatrixWebPreviewTarget, alive: () => boolean): void {
    const target = matrixWebPreviewTarget(value)

    if (!scope || !target || !alive()) {
      return
    }

    if (this.view(scope) && this.entry?.target.url === target.url && this.entry.target.label === target.label) {
      return
    }

    this.entry = {
      scope,
      target,
      alive,
      offer: {
        id: randomUUID(),
        label: target.label,
        hostname: new URL(target.url).hostname,
        expiresAt: this.now() + TTL
      }
    }
  }

  view(scope: string): MatrixWebPreviewOffer | undefined {
    const entry = this.entry

    if (!entry) {
      return
    }

    if (this.now() >= entry.offer.expiresAt || !entry.alive()) {
      this.entry = undefined

      return
    }

    if (entry.scope !== scope) {
      return
    }

    return { ...entry.offer }
  }

  open(scope: string, id: unknown): { id: string; url: string } {
    if (typeof id !== 'string' || this.view(scope)?.id !== id || !this.entry) {
      throw new Error('matrix_web_preview_unavailable')
    }

    const result = { id, url: this.entry.target.url }
    this.entry = undefined

    return result
  }

  dismiss(scope: string, id: unknown): void {
    if (typeof id === 'string' && this.view(scope)?.id === id) {
      this.entry = undefined
    }
  }

  clear(): void {
    this.entry = undefined
  }
}
