import { randomUUID } from 'node:crypto'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  type MatrixProfile,
  matrixProfileDisplayName,
  type MatrixProfileMetadata,
  matrixProfileMxc,
  matrixProfilePhoto,
  type MatrixProfilePhotoChange,
  type MatrixProfileReadResult,
  type MatrixProfileSdkCommand,
  type MatrixProfileTarget,
  matrixProfileTarget
} from '../../shared/matrix-profile'

export interface MatrixProfileHost {
  identity: MatrixIdentity
  /** Captures native account generation, roster/enrollment and the exact SDK host. */
  current(): boolean
  command(command: MatrixProfileSdkCommand): Promise<unknown>
}

/** Native resolves ownership. An editor token selects only a previously bound own session. */
export class MatrixProfiles {
  private editor?: {
    scope: string
    target: MatrixProfileTarget
    host: MatrixProfileHost
    pending: boolean
    staged?: Extract<MatrixProfilePhotoChange, { kind: 'replace' }>
  }

  constructor(
    private readonly options: {
      resolve(target: MatrixProfileTarget): MatrixProfileHost | undefined
      changed?(target: MatrixProfileTarget, profile: MatrixProfileMetadata): void
    }
  ) {}

  private host(target: MatrixProfileTarget) {
    const host = this.options.resolve(target)

    if (!host?.current()) {
      throw new Error('matrix_profile_unavailable')
    }

    return host
  }

  private requireCurrent(host: MatrixProfileHost, scope?: string) {
    if (!host.current() || (scope !== undefined && this.editor?.scope !== scope)) {
      throw new Error('matrix_profile_stale')
    }
  }

  private project(host: MatrixProfileHost, value: unknown): MatrixProfile {
    const result = value as MatrixProfileReadResult | null
    const profile = result?.profile

    if (
      !profile ||
      profile.userId !== host.identity.userId ||
      typeof profile.displayName !== 'string' ||
      profile.displayName.length > 4096 ||
      (profile.avatarMxc !== null && matrixProfileMxc(profile.avatarMxc) !== profile.avatarMxc)
    ) {
      throw new Error('matrix_profile_invalid')
    }

    const photo = result.photo ? matrixProfilePhoto(result.photo) : undefined

    return {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarMxc: profile.avatarMxc,
      avatarUrl: photo ? `data:${photo.type};base64,${Buffer.from(photo.bytes).toString('base64')}` : null,
      ...(result.photoUnavailable ? { photoUnavailable: true } : {})
    }
  }

  async read(value: unknown): Promise<MatrixProfile> {
    const target = matrixProfileTarget(value)
    const host = this.host(target)
    const result = await host.command({ kind: 'profileRead' })
    this.requireCurrent(host)

    return this.project(host, result)
  }

  async open(value: unknown, signal?: AbortSignal): Promise<{ scope: string }> {
    const target = matrixProfileTarget(value)
    const host = this.host(target)
    // Revoke first; awaiting an SDK discard cannot leave the old upload committable.
    this.stop()
    const scope = randomUUID()
    this.editor = { scope, target, host, pending: false }

    const aborted = () => this.stop()
    signal?.addEventListener('abort', aborted, { once: true })

    try {
      signal?.throwIfAborted()
      await host.command({ kind: 'profileOpen', scope })
      signal?.throwIfAborted()
      this.requireCurrent(host, scope)

      return { scope }
    } catch {
      await this.close(scope)
      throw new Error('matrix_profile_unavailable')
    } finally {
      signal?.removeEventListener('abort', aborted)
    }
  }

  async change(scope: unknown, value: unknown, signal?: AbortSignal): Promise<MatrixProfile> {
    const editor = this.editor

    if (typeof scope !== 'string' || !editor || editor.scope !== scope) {
      throw new Error('matrix_profile_stale')
    }

    this.requireCurrent(editor.host, scope)

    if (editor.pending) {
      throw new Error('matrix_profile_pending')
    }

    const raw = value as { kind?: unknown; displayName?: unknown } | null

    // The person's own name. An agent's name is the platform's (its roster entry), so an
    // agent's editor changes only its photo.
    if (raw?.kind === 'name') {
      if (editor.target.kind !== 'human') {
        throw new Error('matrix_profile_name_unavailable')
      }

      const displayName = matrixProfileDisplayName(raw.displayName)
      const aborted = () => this.stop()
      signal?.addEventListener('abort', aborted, { once: true })
      editor.pending = true

      try {
        signal?.throwIfAborted()
        const result = await editor.host.command({ kind: 'profileName', scope, displayName })
        signal?.throwIfAborted()
        this.requireCurrent(editor.host, scope)
        const profile = this.project(editor.host, result)
        this.options.changed?.(editor.target, {
          userId: profile.userId,
          displayName: profile.displayName,
          avatarMxc: profile.avatarMxc
        })

        return profile
      } finally {
        editor.pending = false
        signal?.removeEventListener('abort', aborted)
      }
    }

    if (raw?.kind !== 'replace' && raw?.kind !== 'remove') {
      throw new Error('matrix_profile_photo_type')
    }

    const photo = raw.kind === 'replace' ? matrixProfilePhoto(value) : undefined
    const aborted = () => this.stop()
    signal?.addEventListener('abort', aborted, { once: true })
    editor.pending = true

    try {
      signal?.throwIfAborted()
      if (photo) {
        const staged = editor.staged

        const same =
          staged?.type === photo.type &&
          staged.bytes.length === photo.bytes.length &&
          staged.bytes.every((value, index) => value === photo.bytes[index])

        if (!same) {
          editor.staged = undefined
          await editor.host.command({ kind: 'profileUpload', scope, type: photo.type, bytes: photo.bytes })
          signal?.throwIfAborted()
          // No final SDK write was dispatched while the upload was in flight.
          this.requireCurrent(editor.host, scope)
          editor.staged = photo
        }
      }

      const result = await editor.host.command({ kind: 'profileCommit', scope, ...(photo ? {} : { remove: true }) })
      signal?.throwIfAborted()
      this.requireCurrent(editor.host, scope)
      const profile = this.project(editor.host, result)
      editor.staged = undefined
      this.options.changed?.(editor.target, {
        userId: profile.userId,
        displayName: profile.displayName,
        avatarMxc: profile.avatarMxc
      })

      return profile
    } finally {
      editor.pending = false
      signal?.removeEventListener('abort', aborted)
    }
  }

  /**
   * Brings an assistant's public name to its platform record (assistant-name-sync.ts). Only
   * this Mac's own session for that assistant; never the person's, never from the window.
   */
  async syncName(principal: string, displayName: string): Promise<void> {
    const target = matrixProfileTarget({ kind: 'agent', principal })
    const host = this.host(target)
    const result = await host.command({ kind: 'profileSyncName', displayName: matrixProfileDisplayName(displayName) })
    this.requireCurrent(host)
    const profile = this.project(host, result)
    this.options.changed?.(target, {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarMxc: profile.avatarMxc
    })
  }

  async close(scope: unknown): Promise<void> {
    if (typeof scope !== 'string' || this.editor?.scope !== scope) {
      return
    }

    const editor = this.editor
    this.editor = undefined
    await editor.host.command({ kind: 'profileDiscard', scope }).catch(() => {})
  }

  stop(): void {
    const editor = this.editor
    this.editor = undefined

    if (editor) {
      void editor.host.command({ kind: 'profileDiscard', scope: editor.scope }).catch(() => {})
    }
  }
}
