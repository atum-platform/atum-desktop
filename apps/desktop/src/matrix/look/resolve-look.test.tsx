import { render } from '@testing-library/react'
import { expect, it } from 'vitest'

import acmeSubmission from '../../../shared/__fixtures__/look-pack-v1/fixtures/acme.submission.json'
import moonFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import type { AppDescriptor } from '../../../shared/app-catalog'
import { decodeLookPack, type LookPackPublished } from '../../../shared/look-pack'
import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

import { resolveConversationLook } from './resolve-look'

function publishedAcme(): LookPackPublished {
  return decodeLookPack({
    ...structuredClone(acmeSubmission),
    pack_id: '00000000-0000-4000-8000-6d00a0a7b337',
    version: 1,
    digest: 'a'.repeat(64),
    publisher: { kind: 'app', app_id: '00000000-0000-4000-8000-4b2f94c54b02' },
    derived: {
      light: {
        worst: '#F1F5F4',
        ink: '#151515FF',
        ink_soft: '#151515F2',
        ink_muted: '#151515E6',
        ink_faint: '#151515B3',
        line: '#151515A6',
        scrim: '#F1F5F4'
      },
      dark: {
        worst: '#172421',
        ink: '#FFFFFFFF',
        ink_soft: '#FFFFFFF2',
        ink_muted: '#FFFFFFE6',
        ink_faint: '#FFFFFFB3',
        line: '#FFFFFFA6',
        scrim: '#172421'
      }
    }
  })!
}

const moon = decodeLookPack(moonFixture)!
const app = (slug: string, look: LookPackPublished): AppDescriptor => ({
  app: slug,
  app_id: look.publisher.kind === 'app' ? look.publisher.app_id : '00000000-0000-4000-8000-8cca3400b26b',
  app_version_id: '00000000-0000-4000-8000-8cca3400b26b',
  name: { en: slug },
  subtitle: null,
  description: null,
  icon: null,
  accent: look.accent?.light ?? null,
  affiliation: 'partner',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: ['direct'],
  has_surface: false,
  link: { mode: 'none', state: 'never_linked' },
  bot: {
    v: 1,
    user_id: `@app-${slug}:atumplatform.com`,
    handle: `${slug}_bot`,
    display_name: slug,
    avatar: { url: '', sha256: 'b'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'APP', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: false,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: false,
    purchase_route_id: 'chat'
  },
  look
})

const directRoom = (slug: string): MatrixRoom => ({
  id: `!${slug}:test`,
  name: slug,
  membership: 'join',
  encrypted: false,
  direct: true,
  participants: [
    { userId: '@owner:test', membership: 'join' },
    { userId: `@app-${slug}:atumplatform.com`, membership: 'join' }
  ]
})

const snapshot = (apps: AppDescriptor[]): Pick<MatrixSnapshot, 'apps' | 'identity'> => ({
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  apps: { state: 'ready', apps, connections: {} }
})

it('keeps a published v1 pack loading while projecting only its allowed colours', () => {
  const resolved = resolveConversationLook({
    snapshot: snapshot([app('luna', moon)]),
    room: directRoom('luna'),
    appearance: 'dark'
  })

  expect(resolved).toMatchObject({
    pack: { pack_id: moon.pack_id },
    tone: 'dark',
    tokens: moon.chat?.tokens,
    hasIdentityColors: true
  })
  expect(resolved.style).toMatchObject({
    '--look-base': '#0E1D60',
    '--look-l1-opacity': 0.38,
    '--ak-bubble-own': '#F7F6F2',
    '--look-app-bubble': '#FFFFFF',
    '--look-accent': '#D8612F'
  })
  expect(resolved.tokens).toMatchObject({
    fonts: { ui: 'be-vietnam-pro', body: 'literata' },
    radii: { owner_bubble: 'xl-tail-end', app_bubble: 'xl-tail-start', composer: 'pill' },
    composer: { fill: '#F7F6F2', action: '#0E1D60' }
  })
  expect(resolved.style['--look-font-ui']).toBeUndefined()
  expect(resolved.style['--look-font-body']).toBeUndefined()
  expect(resolved.style['--look-owner-radius']).toBeUndefined()
  expect(resolved.style['--look-app-radius']).toBeUndefined()
  expect(resolved.style['--look-composer-radius']).toBeUndefined()
  expect(resolved.style['--look-composer-fill']).toBeUndefined()
  expect(resolved.style['--look-composer-ink']).toBeUndefined()
})

it('lets a background travel to an assistant chat without its app identity tokens', () => {
  const room: MatrixRoom = {
    id: '!assistant:test',
    name: 'Assistant',
    membership: 'join',
    encrypted: false,
    assistant: true,
    look: { v: 1, background: { kind: 'pack', pack_id: moon.pack_id } }
  }
  const resolved = resolveConversationLook({ snapshot: snapshot([app('luna', moon)]), room, appearance: 'light' })

  expect(resolved.pack?.pack_id).toBe(moon.pack_id)
  expect(resolved.tokens).toBeNull()
  expect(resolved.hasIdentityColors).toBe(false)
  expect(resolved.style['--look-base']).toBe('#0E1D60')
  expect(resolved.style['--look-accent']).toBeUndefined()
})

it('falls an unavailable selection back to this chat default and supports an explicit plain ground', () => {
  const room = directRoom('luna')
  const catalog = snapshot([app('luna', moon)])
  const missing = resolveConversationLook({
    snapshot: catalog,
    room,
    appearance: 'light',
    accountData: { v: 1, background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-5dc0bdeee28f' } }
  })
  const plain = resolveConversationLook({
    snapshot: catalog,
    room,
    appearance: 'light',
    accountData: { v: 1, background: { kind: 'none' } }
  })

  expect(missing.pack?.pack_id).toBe(moon.pack_id)
  expect(plain.pack).toBeNull()
  expect(plain.tokens).toEqual(moon.chat?.tokens)
  expect(plain.style['--look-base']).toBeUndefined()
  expect(plain.style['--ak-bubble-own']).toBe('#F7F6F2')
  expect(plain.style['--look-accent']).toBe('#D8612F')
})

it('renders an unknown app slug entirely from the frozen Acme data', () => {
  const acme = publishedAcme()
  const slug = 'publisher-never-registered-in-product-code'
  const resolved = resolveConversationLook({
    snapshot: snapshot([app(slug, acme)]),
    room: directRoom(slug),
    appearance: 'dark'
  })
  const view = render(
    <section
      data-atum-look={resolved.ground ? 'pack' : undefined}
      data-atum-look-colors={resolved.hasIdentityColors ? true : undefined}
      data-atum-look-tone={resolved.tone}
      style={resolved.style}
    />
  )
  const chat = view.container.firstElementChild as HTMLElement

  expect(chat.dataset.atumLook).toBe('pack')
  expect(chat.dataset.atumLookColors).toBe('true')
  expect(chat.dataset.atumLookTone).toBe('dark')
  expect(chat.style.getPropertyValue('--look-base')).toBe('#172421')
  expect(chat.style.getPropertyValue('--look-accent')).toBe('#68D4C8')
})
