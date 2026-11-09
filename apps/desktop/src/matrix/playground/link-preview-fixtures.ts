import type { MatrixMessage, MatrixSnapshot } from '../../../shared/matrix'
import type { MatrixLinkPreview, MatrixLinkPreviewBridge } from '../../../shared/matrix-link-preview'

/**
 * Link preview cards in the playground (`?links=1`): the open chat counts as plain and gains
 * three messages with links, answered after a short wait so the fade-in shows. A card with a
 * picture and a long title, one without a picture under your own message, and a link whose page
 * has nothing to show (no card). Dev only; nothing leaves the window.
 */
export function playgroundLinkPreviewMode(params: URLSearchParams): boolean {
  return params.get('links') === '1'
}

const LINKS: Array<{ id: string; sender: 'other' | 'own'; body: string; preview: MatrixLinkPreview | null; picture?: number }> = [
  {
    id: '$link-preview-rich',
    sender: 'other',
    body: 'This is the write-up I mentioned: https://www.example.com/blog/launch-checklist-for-small-teams',
    picture: 0,
    preview: {
      url: 'https://www.example.com/blog/launch-checklist-for-small-teams',
      host: 'example.com',
      siteName: 'Example Journal',
      title:
        'The launch checklist we wish we had: pricing pages, support rotas and the one email that matters most on launch morning',
      description:
        'Three teams compared notes on what actually mattered in the week before launch, and what they would skip next time.'
    }
  },
  {
    id: '$link-preview-plain',
    sender: 'own',
    body: 'Rota template here https://docs.example.org/support-rota',
    preview: {
      url: 'https://docs.example.org/support-rota',
      host: 'docs.example.org',
      title: 'Support rota template',
      description: 'Weekdays split by timezone, weekends one person on call.'
    }
  },
  {
    id: '$link-preview-none',
    sender: 'other',
    body: 'And the staging page: https://staging.example.net/pricing',
    preview: null
  }
]

/** A page picture drawn in the window, standing in for the server's thumbnail. */
function picture(seed: number): string | undefined {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 160
    const context = canvas.getContext('2d')

    if (!context) {
      return undefined
    }

    const gradient = context.createLinearGradient(0, 0, 160, 160)
    gradient.addColorStop(0, seed === 0 ? '#f3c37a' : '#8fb3e8')
    gradient.addColorStop(1, seed === 0 ? '#d9653b' : '#3d5a99')
    context.fillStyle = gradient
    context.fillRect(0, 0, 160, 160)
    context.fillStyle = 'rgba(255,255,255,0.85)'
    context.fillRect(28, 40, 104, 10)
    context.fillRect(28, 62, 76, 10)
    context.fillRect(28, 84, 92, 10)
    context.beginPath()
    context.arc(122, 122, 18, 0, Math.PI * 2)
    context.fill()

    return canvas.toDataURL('image/png')
  } catch {
    return undefined
  }
}

export function withPlaygroundLinkPreviews(snapshot: MatrixSnapshot, enabled: boolean): MatrixSnapshot {
  const roomId = snapshot.roomId
  const me = snapshot.identity?.userId

  if (!enabled || !roomId || !me || snapshot.messages.some(message => message.id === LINKS[0]!.id)) {
    return snapshot
  }

  const other =
    snapshot.messages.find(message => !message.own && message.sender.startsWith('@') && !message.notice)?.sender ??
    '@linh:example.invalid'

  const now = Date.now()

  const added = LINKS.map(
    (link, index): MatrixMessage => ({
      id: link.id,
      sender: link.sender === 'own' ? me : other,
      body: link.body,
      timestamp: now - (3 - index) * 60_000,
      own: link.sender === 'own',
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false
    })
  )

  return {
    ...snapshot,
    rooms: snapshot.rooms.map(room => (room.id === roomId ? { ...room, encrypted: false } : room)),
    messages: [...snapshot.messages, ...added]
  }
}

export function playgroundLinkPreviews(): MatrixLinkPreviewBridge {
  return {
    read: (_roomId, eventId) =>
      new Promise(resolve => {
        const link = LINKS.find(each => each.id === eventId)
        const image = link?.picture === undefined ? undefined : picture(link.picture)

        setTimeout(() => resolve(link?.preview ? { ...link.preview, ...(image ? { image } : {}) } : null), 600)
      })
  }
}
