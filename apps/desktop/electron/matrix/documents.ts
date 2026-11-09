import { createHash, randomUUID } from 'node:crypto'

import {
  MATRIX_MAX_FILE_BYTES,
  type MatrixDocumentPreview,
  type MatrixHermesAttachment,
  type MatrixLinkedDocument
} from '../../shared/matrix'
import { type AtumConsumerFilesService, consumerFileImageMime, consumerFileOpenKind } from '../atum-consumer-files'
import type { EncryptedStore } from '../encrypted-store'

import type { MatrixTextDocument } from './text-document'
import type { MatrixWordDocument, MatrixWordRequest } from './word-document'

interface Intent {
  name: string
  revision: string
  kind?: 'word'
}
interface Link extends Intent {
  token: string
  word?: MatrixWordDocument
  text?: MatrixTextDocument
  unavailable?: boolean
}
export interface MatrixDocumentScope {
  userId: string
  roomId: string
}

/** Local user intent only. Matrix owns rooms; Files owns grants; Hermes owns
 * attachment staging. No second conversation store or renderer path authority.
 * Persist only a display name, never bytes, paths or a reusable read capability. */
export class MatrixRoomDocuments {
  private readonly links = new Map<string, Link>()
  private readonly intents = new Map<string, Intent | null>()
  private readonly operations = new Map<string, symbol>()
  private readonly previews = new Map<string, { key: string; link: Link }>()

  hasTextPreview(): boolean {
    return [...this.previews.values()].some(preview => Boolean(preview.link.text))
  }

  constructor(
    private readonly files: Pick<AtumConsumerFilesService, 'grantCapture' | 'capture' | 'releaseView' | 'resolveView'>,
    private readonly store: EncryptedStore,
    private readonly closeNativePreview: (token: string) => void = () => {},
    private readonly word?: (scope: MatrixDocumentScope, token: string) => MatrixWordDocument,
    private readonly text?: (scope: MatrixDocumentScope, path: string) => MatrixTextDocument
  ) {}

  private key(scope: MatrixDocumentScope) {
    if (!scope.userId.startsWith('@') || !scope.roomId.startsWith('!')) {
      throw new Error('matrix_document_unavailable')
    }

    return `matrix-document-${createHash('sha256')
      .update(JSON.stringify([scope.userId, scope.roomId]))
      .digest('hex')}`
  }

  private intent(key: string): Intent | null {
    if (this.intents.has(key)) {
      return this.intents.get(key)!
    }

    const raw = this.store.getItem(key)

    if (this.store.failureCode()) {
      throw new Error('matrix_document_unavailable')
    }

    const intent = raw === null ? null : (JSON.parse(raw) as Intent)

    if (
      intent &&
      (typeof intent.name !== 'string' ||
        !intent.name ||
        intent.name.length > 255 ||
        /[\\/\p{Cc}]/u.test(intent.name) ||
        typeof intent.revision !== 'string' ||
        !intent.revision || (intent.kind !== undefined && intent.kind !== 'word'))
    ) {
      throw new Error('matrix_document_unavailable')
    }

    this.intents.set(key, intent)

    return intent
  }

  describe(scope: MatrixDocumentScope): MatrixLinkedDocument | null {
    try {
      const key = this.key(scope)
      const intent = this.intent(key)

      if (!intent) {
        return null
      }

      const link = this.links.get(key)

      return {
        name: intent.name,
        revision: intent.revision,
        ...(intent.kind ? { kind: intent.kind } : {}),
        state: !link ? 'reconnect_required' : link.unavailable ? 'unavailable' : 'linked'
      }
    } catch {
      return { name: '', state: 'unavailable' }
    }
  }

  async choose(scope: MatrixDocumentScope, pick: () => Promise<string | null>) {
    const key = this.key(scope)
    const operation = Symbol()
    this.operations.set(key, operation)
    let token: string | undefined
    let word: MatrixWordDocument | undefined
    let text: MatrixTextDocument | undefined

    try {
      const selected = await pick()

      if (this.operations.get(key) !== operation) {
        throw new Error('matrix_document_unavailable')
      }

      if (!selected) {
        return
      }

      const grant = await this.files.grantCapture(selected, MATRIX_MAX_FILE_BYTES)
      token = grant.token

      if (
        this.operations.get(key) !== operation ||
        !grant.name ||
        grant.name.length > 255 ||
        /[\\/\p{Cc}]/u.test(grant.name)
      ) {
        throw new Error('matrix_document_unavailable')
      }

      const isWord = /\.(doc|docx)$/iu.test(grant.name) && Boolean(this.word)

      if (isWord) {
        word = this.word!(scope, token)
        await word.open(selected)

        if (this.operations.get(key) !== operation) {throw new Error('matrix_document_unavailable')}
      }

      if (!isWord && /\.(md|markdown|txt)$/iu.test(grant.name) && this.text) {
        text = this.text(scope, selected)
        try {
          text.open(selected)
          await text.read()
        } catch (error) {
          // Unsupported/oversized editor input keeps the original read-only,
          // raw-byte grant. Never fall back after scope, custody, or IO errors.
          if (!(error instanceof Error) || !['MATRIX_TEXT_DOCUMENT_UNSUPPORTED', 'WORKSPACE_FILE_TOO_LARGE'].includes(error.message)) {throw error}
          await text.release()
          text = undefined
        }

        if (this.operations.get(key) !== operation) {throw new Error('matrix_document_unavailable')}
      }

      const intent: Intent = { name: grant.name, revision: randomUUID(), ...(isWord ? { kind: 'word' } : {}) }
      this.store.setItem(key, JSON.stringify(intent))
      const previous = this.links.get(key)

      if (previous) {
        this.closePreviews(key)
        this.files.releaseView(previous.token)
        void previous.word?.dispose().catch(() => {})
        void previous.text?.release()
      }

      this.intents.set(key, intent)
      this.links.set(key, { ...intent, token, ...(word ? { word } : {}), ...(text ? { text } : {}) })
      token = undefined
      word = undefined
      text = undefined
    } finally {
      if (token) {
        this.files.releaseView(token)
      }

      if (word) {await word.dispose().catch(() => {})}

      if (text) {await text.release()}

      if (this.operations.get(key) === operation) {
        this.operations.delete(key)
      }
    }
  }

  remove(scope: MatrixDocumentScope) {
    const key = this.key(scope)
    this.operations.delete(key)
    this.store.removeItem(key)
    this.closePreviews(key)
    const link = this.links.get(key)

    if (link) {
      this.files.releaseView(link.token)
      void link.word?.dispose().catch(() => {})
      void link.text?.release()
    }

    this.links.delete(key)
    this.intents.set(key, null)
  }

  /** One read-only saved snapshot. View lifetime is separate from the file link.
   * Install the token before awaiting capture so close/scope changes win races. */
  async preview(scope: MatrixDocumentScope): Promise<MatrixDocumentPreview> {
    const key = this.key(scope)
    const link = this.links.get(key)

    if (!link || link.unavailable) {
      throw new Error('matrix_document_unavailable')
    }

    this.closePreviews(key)
    const token = randomUUID()
    this.previews.set(token, { key, link })

    try {
      if (link.text) {
        const descriptor = link.text.describe()

        return { token, name: link.name, kind: 'editable', recovery: descriptor.recovery === 'available' }
      }

      if (link.word) {
        const capture = await link.word.capture()

        if (!this.previews.has(token) || this.links.get(key) !== link) {throw new Error('matrix_document_unavailable')}

        return { token, name: link.name, kind: 'word', text: capture.text, saved: capture.saved }
      }

      const result = await this.files.capture(link.token, MATRIX_MAX_FILE_BYTES)

      if (!this.previews.has(token) || this.links.get(key) !== link) {
        throw new Error('matrix_document_unavailable')
      }

      const bytes = Buffer.from(result.dataUrl.split(',')[1]!, 'base64')
      const base = { token, name: link.name }
      const kind = consumerFileOpenKind(link.name)

      if (kind === 'pdf') {
        return { ...base, kind }
      }

      if (kind === 'image') {
        // Image element, never an executable document/frame. Candidate CSP has no network.
        return { ...base, kind, dataUrl: `data:${consumerFileImageMime(link.name)};base64,${bytes.toString('base64')}` }
      }

      if (kind === 'text' && bytes.length <= 512 * 1024 && !bytes.includes(0)) {
        try {
          return { ...base, kind, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        } catch {
          /* Binary/unsupported encoding: do not turn it into active HTML. */
        }
      }

      return { ...base, kind: 'unsupported' }
    } catch {
      this.closePreview(token)
      throw new Error('matrix_document_unavailable')
    }
  }

  resolvePreview(scope: MatrixDocumentScope, token: string): string | null {
    const preview = this.previews.get(token)

    if (!preview || preview.key !== this.key(scope) || this.links.get(preview.key) !== preview.link) {
      return null
    }

    return this.files.resolveView(preview.link.token)
  }

  closePreview(token: string) {
    this.previews.delete(token)
    this.closeNativePreview(token)
  }

  closePreviews(key?: string) {
    for (const [token, preview] of this.previews) {
      if (!key || preview.key === key) {
        this.closePreview(token)
      }
    }
  }

  textForPreview(scope: MatrixDocumentScope, token: string): MatrixTextDocument {
    const preview = this.previews.get(token)

    if (!preview || preview.key !== this.key(scope) || this.links.get(preview.key) !== preview.link ||
      !preview.link.text || preview.link.unavailable) {throw new Error('matrix_document_unavailable')}

    preview.link.text.describe()

    return preview.link.text
  }

  /** Editor custody ends on foreground room loss. Display intent survives;
   * returning to that room requires explicitly selecting its document again. */
  retainTextRoom(scope: MatrixDocumentScope | null) {
    const retained = scope ? this.key(scope) : null

    for (const [key, link] of this.links) {
      if (link.text && key !== retained) {
        this.closePreviews(key)
        void link.text.release()
        this.files.releaseView(link.token)
        this.links.delete(key)
      }
    }
  }

  /** Membership loss revokes capabilities, but keeps display-only intent. */
  retainRooms(userId: string, joinedRoomIds: string[]) {
    const allowed = new Set(
      joinedRoomIds
        .filter(roomId => typeof roomId === 'string' && roomId.startsWith('!'))
        .map(roomId => this.key({ userId, roomId }))
    )

    for (const key of new Set([...this.links.keys(), ...this.operations.keys()])) {
      if (!allowed.has(key)) {
        this.operations.delete(key)
        this.closePreviews(key)
        const link = this.links.get(key)

        if (link) {
          this.files.releaseView(link.token)
          void link.word?.dispose().catch(() => {})
          void link.text?.release()
        }

        this.links.delete(key)
      }
    }
  }

  /** Freeze the selected grant, not the file body. Called only for a fresh,
   * explicitly confirmed invocation; replay publication never reads a file. */
  forInvocation(scope: MatrixDocumentScope): { name: string; capture(): Promise<MatrixHermesAttachment>; word?: MatrixWordRequest } | undefined {
    const key = this.key(scope)
    const intent = this.intent(key)

    if (!intent) {
      return undefined
    }

    const link = this.links.get(key)

    if (!link || link.unavailable) {
      throw new Error('matrix_document_unavailable')
    }

    return {
      name: link.name,
      ...(link.word ? { word: async (...args: Parameters<MatrixWordRequest>) => {
        if (this.links.get(key) !== link || link.unavailable) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}

        return link.word!.execute(...args)
      } } : {}),
      capture: async () => {
        try {
          if (this.links.get(key) !== link) {
            throw new Error('matrix_document_unavailable')
          }

          if (link.word) {
            const captured = await link.word.capture()

            if (this.links.get(key) !== link) {throw new Error('matrix_document_unavailable')}

            return { name: `${link.name}.context.json`, bytes: Buffer.from(JSON.stringify({
              source: 'Microsoft Word live main-story text', source_revision: captured.revision,
              saved: captured.saved, text: captured.text, ...(captured.selection ? { selection: captured.selection } : {})
            })) }
          }

          if (link.text) {
            const captured = await link.text.capture()

            if (this.links.get(key) !== link) {throw new Error('matrix_document_unavailable')}

            return { name: captured.name, bytes: captured.bytes }
          }

          const result = await this.files.capture(link.token, MATRIX_MAX_FILE_BYTES)

          if (this.links.get(key) !== link) {
            throw new Error('matrix_document_unavailable')
          }

          return { name: link.name, bytes: Buffer.from(result.dataUrl.split(',')[1]!, 'base64') }
        } catch {
          // A failed capture must not retire the open editable preview. It may
          // still hold unsaved text which only its detach barrier can release.
          // Reject the invocation while preserving the editor's scoped custody.
          if (this.links.get(key) === link && !link.text) {
            link.unavailable = true
          }

          throw new Error('matrix_document_unavailable')
        }
      }
    }
  }

  /** Logout/host replacement revokes capabilities, not the user's intent. */
  reset() {
    this.operations.clear()
    this.closePreviews()

    for (const link of this.links.values()) {
      this.files.releaseView(link.token)
      void link.word?.dispose().catch(() => {})
      void link.text?.release()
    }

    this.links.clear()
    this.intents.clear()
  }

  async arrangeWord(scope: MatrixDocumentScope, show: boolean) {
    const link = this.links.get(this.key(scope))

    if (!link?.word || link.unavailable) {throw new Error('matrix_document_unavailable')}

    if (show) {
      await this.hideWord()
      await link.word.show()
    } else {
      await link.word.hide()
    }
  }

  async hideWord() {
    await Promise.allSettled([...this.links.values()].map(link => link.word?.hide()))
  }

  async refreshWord() {
    await Promise.allSettled([...this.links.values()].map(link => link.word?.refresh()))
  }
}
