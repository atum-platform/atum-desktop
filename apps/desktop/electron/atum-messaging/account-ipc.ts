import type { AtumAccountAuthController } from './account-auth'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: any[]) => unknown): void
  removeHandler?(channel: string): void
}

export interface AtumAccountIpcAuthority {
  assertTrustedSender(event: unknown): void
}

export interface AtumAccountIpcSenderFacts {
  hasOwner: boolean
  ownsWebContents: boolean
  isMainFrame: boolean
  url: string
  devServerUrl?: string | null
}

export function assertTrustedAtumAccountSender(facts: AtumAccountIpcSenderFacts): void {
  let senderUrl: URL

  try {
    senderUrl = new URL(facts.url)
  } catch {
    throw new Error('atum_account_sender_not_allowed')
  }

  const trustedOrigin =
    senderUrl.protocol === 'file:' ||
    Boolean(facts.devServerUrl && senderUrl.origin === new URL(facts.devServerUrl).origin)

  if (!facts.hasOwner || !facts.ownsWebContents || !facts.isMainFrame || !trustedOrigin) {
    throw new Error('atum_account_sender_not_allowed')
  }
}

export const ATUM_ACCOUNT_IPC_CHANNELS = [
  'atum:account:status',
  'atum:account:retry-restore',
  'atum:account:sign-in',
  'atum:account:sign-in-password',
  'atum:account:cancel',
  'atum:account:sign-out'
] as const

function passwordSignInInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('account_credentials_invalid')
  }

  const record = value as Record<string, unknown>
  const rawIdentifier = typeof record.identifier === 'string' ? record.identifier.trim() : ''
  const password = typeof record.password === 'string' ? record.password : ''

  let identifier = ''

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawIdentifier) && rawIdentifier.length <= 254) {
    identifier = rawIdentifier.toLowerCase()
  } else {
    const compactPhone = rawIdentifier.replace(/[\s().-]/g, '')
    const vietnameseMobile = /^(?:\+84|84|0)\d{9}$/.test(compactPhone)

    if (vietnameseMobile) {
      identifier = compactPhone.startsWith('0')
        ? `+84${compactPhone.slice(1)}`
        : compactPhone.startsWith('84')
          ? `+${compactPhone}`
          : compactPhone
    } else {
      const handle = rawIdentifier.startsWith('@') ? rawIdentifier.slice(1) : rawIdentifier

      if (/^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/.test(handle)) {
        identifier = handle.toLowerCase()
      }
    }
  }

  if (
    !identifier ||
    password.length < 1 ||
    password.length > 4096 ||
    rawIdentifier.length > 254 ||
    rawIdentifier.includes('\0') ||
    password.includes('\0')
  ) {
    throw new Error('account_credentials_invalid')
  }

  return { identifier, password }
}

export function registerAtumAccountIpc(
  ipc: IpcMainLike,
  controller: AtumAccountAuthController,
  authority: AtumAccountIpcAuthority
): () => void {
  ipc.handle('atum:account:status', event => {
    authority.assertTrustedSender(event)

    return controller.status()
  })
  ipc.handle('atum:account:sign-in', event => {
    authority.assertTrustedSender(event)

    return controller.signIn()
  })
  ipc.handle('atum:account:retry-restore', event => {
    authority.assertTrustedSender(event)

    return controller.retryRestore()
  })
  ipc.handle('atum:account:sign-in-password', async (event, input) => {
    authority.assertTrustedSender(event)
    let credentials: ReturnType<typeof passwordSignInInput> | null = null

    try {
      credentials = passwordSignInInput(input)
    } catch {
      const status = controller.status()

      return {
        ...status,
        state: status.account ? 'signed_in' : 'error',
        errorCode: 'account_credentials_invalid'
      }
    }

    try {
      return await controller.signInWithPassword(credentials)
    } finally {
      // JavaScript strings cannot be zeroed, but main retains no credential
      // object after the request finishes and never stores it on the controller.
      credentials = null
    }
  })
  ipc.handle('atum:account:cancel', event => {
    authority.assertTrustedSender(event)

    return controller.cancel()
  })
  ipc.handle('atum:account:sign-out', event => {
    authority.assertTrustedSender(event)

    return controller.signOut()
  })

  return () => {
    for (const channel of ATUM_ACCOUNT_IPC_CHANNELS) {
      ipc.removeHandler?.(channel)
    }
  }
}
