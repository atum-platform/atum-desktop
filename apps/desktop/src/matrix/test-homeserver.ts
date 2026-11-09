/**
 * A homeserver for tests, in memory and in this process: the part of the client-server API that
 * matrix-js-sdk and its Rust crypto use between one person's devices (sync with to-device
 * messages, account data and device-list changes; device and cross-signing keys, one-time keys,
 * signatures; key backup versions; the device list with last-seen times). It is handed to
 * `createClient({ fetchFn })`, so real clients with real crypto talk to it over the SDK's own HTTP
 * layer. One or more users, any number of devices, each signed in with its own access token.
 *
 * Test-only (device-approval, device-trust-proof and agent-trust-identity-import integration
 * tests). One room; a second room or an invite is refused rather than simulating multi-user room
 * behavior. Because the clients here share no encrypted room, sync reports `device_lists.changed`
 * only for the syncing user's own account: another user's key upload does not track that user.
 * It understands what it stores no more than a
 * real server does: encrypted to-device messages and secrets pass through as opaque JSON.
 */

type Json = Record<string, unknown>

interface Device {
  id: string
  userId: string
  token: string
  name?: string
  lastSeen: number
  keys?: Json
  oneTimeKeys: Map<string, Json>
  fallbackKeys: Map<string, Json>
  inbox: Array<{ position: number; event: Json }>
}

interface Backup {
  version: string
  algorithm: string
  auth_data: Json
  rooms: Json
}

/** Decides, per to-device message, whether the server loses it (a test's network failure). */
export type TestToDeviceFilter = (message: { sender: string; recipient: string; type: string }) => 'deliver' | 'drop'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const notFound = (errcode = 'M_NOT_FOUND') => json(404, { errcode, error: errcode })

export class TestHomeserver {
  readonly baseUrl = 'https://atum.test'
  private readonly devices = new Map<string, Device>()
  private readonly accountData = new Map<string, { position: number; content: Json }>()
  private readonly crossSigning = new Map<
    string,
    { master?: Json; self_signing?: Json; user_signing?: Json }
  >()
  private keyChanges: Array<{ position: number; userId: string }> = []
  private position = 1
  private readonly backups = new Map<string, Backup>()
  private backupVersion = 0
  private filters = 0
  /** One encrypted room for the trust proof; events remain opaque ciphertext. */
  private room?: { id: string; state: Json[]; events: Array<{ position: number; event: Json }> }
  private readonly waiting = new Set<() => void>()
  /** Every request that this server does not implement, for a test that wonders why. */
  readonly unknown: string[] = []
  /** A test's network: which to-device messages arrive. */
  toDevice: TestToDeviceFilter = () => 'deliver'
  /** While set, uploaded signatures are accepted but reach nobody (a device that has not seen
   * them yet): `releaseSignatures` delivers them. */
  holdSignatures = false
  private held: Array<{ body: Json; userId: string }> = []

  constructor(readonly userId: string) {}

  private static key(userId: string, deviceId: string): string {
    return `${userId}\u0000${deviceId}`
  }

  private static accountDataKey(userId: string, type: string): string {
    return `${userId}\u0000${type}`
  }

  private get deviceList(): Device[] {
    return [...this.devices.values()]
  }

  /** Signs a new device of this server's user in: its access token. */
  signIn(deviceId: string, name?: string): string {
    return this.signInAs(this.userId, deviceId, name)
  }

  /** Signs a new device of any user in: its access token. */
  signInAs(userId: string, deviceId: string, name?: string): string {
    const token = `token-${userId}-${deviceId}`
    this.devices.set(TestHomeserver.key(userId, deviceId), {
      id: deviceId,
      userId,
      token,
      ...(name ? { name } : {}),
      lastSeen: Date.now(),
      oneTimeKeys: new Map(),
      fallbackKeys: new Map(),
      inbox: []
    })

    return token
  }

  /** The device's to-device messages still waiting on the server. */
  pendingToDevice(deviceId: string): number {
    return this.deviceList.find(each => each.id === deviceId)?.inbox.length ?? 0
  }

  private changed(): void {
    for (const wake of [...this.waiting]) {
      wake()
    }
  }

  private next(): number {
    this.position += 1

    return this.position
  }

  private keysChanged(userId: string): void {
    this.keyChanges.push({ position: this.next(), userId })
    this.changed()
  }

  /** The SDK's `fetchFn`. */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/_matrix\/client\/(v3|r0|v1|unstable)/, '')
    const header = new Headers(init.headers).get('authorization')
    const token = header?.replace(/^Bearer /, '') ?? url.searchParams.get('access_token')
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as Json) : {}

    if (url.pathname === '/_matrix/client/versions') {
      return json(200, { versions: ['v1.1', 'v1.5', 'v1.11', 'v1.12'], unstable_features: {} })
    }

    const device = this.deviceList.find(each => each.token === token)

    if (!device) {
      return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'unknown token' })
    }

    device.lastSeen = Date.now()
    const user = encodeURIComponent(device.userId)

    if (path === '/sync' && method === 'GET') {
      return this.sync(device, url, init.signal ?? undefined)
    }

    if (path === '/pushrules/' && method === 'GET') {
      return json(200, { global: { content: [], override: [], room: [], sender: [], underride: [] } })
    }

    if (path === `/user/${user}/filter` && method === 'POST') {
      this.filters += 1

      return json(200, { filter_id: String(this.filters) })
    }

    if (path.startsWith(`/user/${user}/filter/`)) {
      return notFound()
    }

    if (path === '/capabilities') {
      return json(200, { capabilities: {} })
    }

    if (path === '/account/whoami') {
      return json(200, { user_id: device.userId, device_id: device.id })
    }

    if (path === '/createRoom' && method === 'POST') {
      if (this.room || (Array.isArray(body.invite) && body.invite.length)) {
        return json(400, { errcode: 'M_INVALID_PARAM', error: 'test_homeserver_single_room_single_user' })
      }

      const id = '!trust-proof:atum.test'

      const state = [
        {
          type: 'm.room.create',
          state_key: '',
          // A room type (`creation_content.type`), as `createConversation` sends for an agent's chat.
          content: { ...((body.creation_content ?? {}) as Json), creator: device.userId, room_version: '10' }
        },
        { type: 'm.room.member', state_key: device.userId, content: { membership: 'join' } },
        ...((body.initial_state ?? []) as Json[])
      ].map((event, index) => ({
        ...event,
        room_id: id,
        sender: device.userId,
        event_id: `$state-${index}`,
        origin_server_ts: Date.now()
      }))

      this.room = { id, state, events: [] }
      this.next()
      this.changed()

      return json(200, { room_id: id })
    }

    const roomPath = path.match(/^\/rooms\/([^/]+)\/(.+)$/)

    if (roomPath && decodeURIComponent(roomPath[1]!) === this.room?.id) {
      const endpoint = roomPath[2]!

      if (endpoint === 'members') {
        return json(200, { chunk: this.room.state.filter(e => e.type === 'm.room.member') })
      }

      if (endpoint === 'joined_members') {
        return json(200, { joined: { [device.userId]: { display_name: device.userId } } })
      }

      if (endpoint === 'state') {
        return json(200, this.room.state)
      }

      if (endpoint.startsWith('event/')) {
        const id = decodeURIComponent(endpoint.slice('event/'.length))
        const event = this.room.events.find(entry => entry.event.event_id === id)?.event

        return event ? json(200, event) : notFound()
      }

      const redact = endpoint.match(/^redact\/([^/]+)\/([^/]+)$/)

      if (redact && method === 'PUT') {
        // A redaction strips the target's content and keeps the event (as a homeserver does).
        const target = this.room.events.find(entry => entry.event.event_id === decodeURIComponent(redact[1]!))?.event
        const id = `$${device.id}-redaction-${decodeURIComponent(redact[2]!)}`

        if (target && Object.keys(target.content as object).length) {
          target.content = {}
          target.unsigned = { redacted_because: { type: 'm.room.redaction', event_id: id, sender: device.userId } }
          this.room.events[this.room.events.findIndex(entry => entry.event === target)]!.position = this.next()
          this.changed()
        }

        return json(200, { event_id: id })
      }

      const send = endpoint.match(/^send\/([^/]+)\/([^/]+)$/)

      if (send && method === 'PUT') {
        // Matrix transactions are idempotent per device.
        const id = `$${device.id}-${decodeURIComponent(send[2]!)}`

        if (!this.room.events.some(entry => entry.event.event_id === id)) {
          const position = this.next()
          this.room.events.push({
            position,
            event: {
              type: decodeURIComponent(send[1]!),
              content: structuredClone(body),
              sender: device.userId,
              event_id: id,
              room_id: this.room.id,
              origin_server_ts: Date.now()
            }
          })
          this.changed()
        }

        return json(200, { event_id: id })
      }
    }

    const accountData = path.startsWith(`/user/${user}/account_data/`)
      ? path.slice(`/user/${user}/account_data/`.length)
      : undefined

    if (accountData && !accountData.includes('/')) {
      const type = decodeURIComponent(accountData)

      if (method === 'PUT') {
        this.accountData.set(TestHomeserver.accountDataKey(device.userId, type), {
          position: this.next(),
          content: body
        })
        this.changed()

        return json(200, {})
      }

      const stored = this.accountData.get(TestHomeserver.accountDataKey(device.userId, type))

      return stored ? json(200, stored.content) : notFound()
    }

    if (path === '/keys/upload' && method === 'POST') {
      return this.uploadKeys(device, body)
    }

    if (path === '/keys/query' && method === 'POST') {
      return this.queryKeys(body)
    }

    if (path === '/keys/claim' && method === 'POST') {
      return this.claimKeys(body)
    }

    if (path === '/keys/device_signing/upload' && method === 'POST') {
      const crossSigning = this.crossSigning.get(device.userId) ?? {}

      for (const name of ['master', 'self_signing', 'user_signing'] as const) {
        const key = body[`${name}_key`]

        if (key && typeof key === 'object') {
          crossSigning[name] = key as Json
        }
      }

      this.crossSigning.set(device.userId, crossSigning)
      this.keysChanged(device.userId)

      return json(200, {})
    }

    if (path === '/keys/signatures/upload' && method === 'POST') {
      return this.uploadSignatures(device.userId, body)
    }

    const toDevice = path.match(/^\/sendToDevice\/([^/]+)\/([^/]+)$/)

    if (toDevice && method === 'PUT') {
      return this.sendToDevice(device, decodeURIComponent(toDevice[1]!), body)
    }

    if (path === '/devices' && method === 'GET') {
      return json(200, {
        devices: this.deviceList.filter(each => each.userId === device.userId).map(each => this.listed(each))
      })
    }

    const single = path.match(/^\/devices\/([^/]+)$/)

    if (single) {
      const target = this.devices.get(TestHomeserver.key(device.userId, decodeURIComponent(single[1]!)))

      if (!target) {
        return notFound()
      }

      if (method === 'PUT') {
        if (typeof body.display_name === 'string') {
          target.name = body.display_name
        }

        return json(200, {})
      }

      return json(200, this.listed(target))
    }

    if (path === '/room_keys/version' && method === 'POST') {
      this.backupVersion += 1

      const backup = {
        version: String(this.backupVersion),
        algorithm: String(body.algorithm),
        auth_data: (body.auth_data ?? {}) as Json,
        rooms: {}
      }

      this.backups.set(device.userId, backup)

      return json(200, { version: backup.version })
    }

    const version = path.match(/^\/room_keys\/version(?:\/([^/]+))?$/)

    if (version) {
      const wanted = version[1] ? decodeURIComponent(version[1]) : undefined
      const stored = this.backups.get(device.userId)
      const backup = stored && (!wanted || wanted === stored.version) ? stored : undefined

      if (!backup) {
        return notFound()
      }

      if (method === 'PUT') {
        backup.auth_data = (body.auth_data ?? backup.auth_data) as Json

        return json(200, {})
      }

      if (method === 'DELETE') {
        this.backups.delete(device.userId)

        return json(200, {})
      }

      return json(200, {
        version: backup.version,
        algorithm: backup.algorithm,
        auth_data: backup.auth_data,
        count: 0,
        etag: '1'
      })
    }

    if (path.startsWith('/room_keys/keys')) {
      const backup = this.backups.get(device.userId)

      if (!backup || url.searchParams.get('version') !== backup.version) {
        return notFound()
      }

      if (method === 'PUT') {
        backup.rooms = { ...backup.rooms, ...((body.rooms ?? {}) as Json) }

        return json(200, { etag: '2', count: Object.keys(backup.rooms).length })
      }

      return json(200, { rooms: backup.rooms })
    }

    this.unknown.push(`${method} ${path}`)

    return notFound('M_UNRECOGNIZED')
  }

  private listed(device: Device) {
    return {
      device_id: device.id,
      ...(device.name ? { display_name: device.name } : {}),
      last_seen_ts: device.lastSeen,
      last_seen_ip: '127.0.0.1'
    }
  }

  private async sync(device: Device, url: URL, signal: AbortSignal | undefined): Promise<Response> {
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 0) || 0, 30_000)
    // Everything up to `since` reached the device: its to-device messages are acknowledged.
    device.inbox = device.inbox.filter(message => message.position > since)

    const keyChanges = () =>
      this.keyChanges.some(change => change.position > since && change.userId === device.userId)

    const accountData = () =>
      [...this.accountData.entries()].some(
        ([key, entry]) => key.startsWith(`${device.userId}\u0000`) && entry.position > since
      )

    const fresh = () =>
      device.inbox.length > 0 ||
      (this.room?.events.some(entry => entry.position > since) ?? false) ||
      keyChanges() ||
      accountData()

    if (since && timeout && !fresh()) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer)
          this.waiting.delete(done)
          signal?.removeEventListener('abort', aborted)
          resolve()
        }

        const aborted = () => {
          clearTimeout(timer)
          this.waiting.delete(done)
          reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
        }

        const timer = setTimeout(done, timeout)
        this.waiting.add(done)
        signal?.addEventListener('abort', aborted, { once: true })
      })
    }

    return json(200, {
      next_batch: String(this.position),
      rooms: {
        join: this.room
          ? {
              [this.room.id]: {
                state: { events: this.room.state },
                timeline: {
                  events: this.room.events.filter(entry => entry.position > since).map(entry => entry.event),
                  limited: false,
                  prev_batch: String(since)
                },
                ephemeral: { events: [] },
                account_data: { events: [] },
                unread_notifications: {}
              }
            }
          : {},
        invite: {},
        leave: {}
      },
      presence: { events: [] },
      account_data: {
        events: [...this.accountData.entries()]
          .filter(([key, entry]) => key.startsWith(`${device.userId}\u0000`) && entry.position > since)
          .map(([key, entry]) => ({ type: key.slice(key.indexOf('\u0000') + 1), content: entry.content }))
      },
      to_device: { events: device.inbox.map(message => message.event) },
      device_lists: { changed: keyChanges() ? [device.userId] : [], left: [] },
      device_one_time_keys_count: { signed_curve25519: device.oneTimeKeys.size },
      device_unused_fallback_key_types: [...device.fallbackKeys.keys()].map(id => id.split(':')[0])
    })
  }

  private uploadKeys(device: Device, body: Json): Response {
    if (body.device_keys && typeof body.device_keys === 'object') {
      device.keys = body.device_keys as Json
      this.keysChanged(device.userId)
    }

    for (const [id, key] of Object.entries((body.one_time_keys ?? {}) as Record<string, Json>)) {
      device.oneTimeKeys.set(id, key)
    }

    const fallback = Object.entries((body.fallback_keys ?? {}) as Record<string, Json>)

    if (fallback.length) {
      device.fallbackKeys.clear()

      for (const [id, key] of fallback) {
        device.fallbackKeys.set(id, key)
      }
    }

    return json(200, { one_time_key_counts: { signed_curve25519: device.oneTimeKeys.size } })
  }

  private queryKeys(body: Json): Response {
    const wanted = Object.keys((body.device_keys ?? {}) as Json)
    const deviceKeys: Record<string, Json> = {}
    const masterKeys: Record<string, Json> = {}
    const selfSigningKeys: Record<string, Json> = {}
    const userSigningKeys: Record<string, Json> = {}

    for (const userId of wanted) {
      deviceKeys[userId] = Object.fromEntries(
        this.deviceList
          .filter(device => device.userId === userId && device.keys)
          .map(device => [
            device.id,
            {
              ...structuredClone(device.keys),
              ...(device.name ? { unsigned: { device_display_name: device.name } } : {})
            }
          ])
      )
      const crossSigning = this.crossSigning.get(userId)

      if (crossSigning?.master) {
        masterKeys[userId] = crossSigning.master
      }

      if (crossSigning?.self_signing) {
        selfSigningKeys[userId] = crossSigning.self_signing
      }

      if (crossSigning?.user_signing) {
        userSigningKeys[userId] = crossSigning.user_signing
      }
    }

    return json(200, {
      device_keys: deviceKeys,
      ...(Object.keys(masterKeys).length ? { master_keys: masterKeys } : {}),
      ...(Object.keys(selfSigningKeys).length ? { self_signing_keys: selfSigningKeys } : {}),
      ...(Object.keys(userSigningKeys).length ? { user_signing_keys: userSigningKeys } : {}),
      failures: {}
    })
  }

  private claimKeys(body: Json): Response {
    const claimed: Record<string, Record<string, Record<string, Json>>> = {}
    const wanted = (body.one_time_keys ?? {}) as Record<string, Record<string, string>>

    for (const [userId, userDevices] of Object.entries(wanted)) {
      const userClaimed: Record<string, Record<string, Json>> = {}

      for (const [deviceId, algorithm] of Object.entries(userDevices)) {
        const device = this.devices.get(TestHomeserver.key(userId, deviceId))

        if (!device) {
          continue
        }

        const pick = (keys: Map<string, Json>, remove: boolean) => {
          const entry = [...keys.entries()].find(([id]) => id.startsWith(`${algorithm}:`))

          if (entry && remove) {
            keys.delete(entry[0])
          }

          return entry
        }

        const entry = pick(device.oneTimeKeys, true) ?? pick(device.fallbackKeys, false)

        if (entry) {
          userClaimed[deviceId] = { [entry[0]]: entry[1] }
        }
      }

      if (Object.keys(userClaimed).length) {
        claimed[userId] = userClaimed
      }
    }

    return json(200, { one_time_keys: claimed, failures: {} })
  }

  /** Every signature held back so far reaches the devices now. */
  releaseSignatures(): void {
    this.holdSignatures = false

    for (const { body, userId } of this.held.splice(0)) {
      this.applySignatures(body)
      this.keysChanged(userId)
    }
  }

  private uploadSignatures(userId: string, body: Json): Response {
    if (this.holdSignatures) {
      this.held.push({ body, userId })
    } else {
      this.applySignatures(body)
      this.keysChanged(userId)
    }

    return json(200, { failures: {} })
  }

  private applySignatures(body: Json): void {
    const merge = (target: Json | undefined, source: Json) => {
      if (!target) {
        return false
      }

      const theirs = (source.signatures ?? {}) as Record<string, Record<string, string>>
      const signatures = (target.signatures ??= {}) as Record<string, Record<string, string>>

      for (const [signer, values] of Object.entries(theirs)) {
        signatures[signer] = { ...(signatures[signer] ?? {}), ...values }
      }

      return true
    }

    for (const [signedUserId, signed] of Object.entries(body)) {
      for (const [id, object] of Object.entries(signed as Record<string, Json>)) {
        const device = this.devices.get(TestHomeserver.key(signedUserId, id))

        if (device?.keys) {
          merge(device.keys, object)

          continue
        }

        for (const key of Object.values(this.crossSigning.get(signedUserId) ?? {})) {
          if (key && Object.keys((key.keys ?? {}) as Json).includes(`ed25519:${id}`)) {
            merge(key, object)
          }
        }
      }
    }
  }

  private sendToDevice(device: Device, type: string, body: Json): Response {
    const messages = (body.messages ?? {}) as Record<string, Record<string, Json>>

    for (const [userId, userMessages] of Object.entries(messages)) {
      for (const [target, content] of Object.entries(userMessages)) {
        const recipients =
          target === '*'
            ? this.deviceList.filter(each => each.userId === userId && each !== device)
            : [this.devices.get(TestHomeserver.key(userId, target))]

        for (const recipient of recipients) {
          if (!recipient || this.toDevice({ sender: device.id, recipient: recipient.id, type }) === 'drop') {
            continue
          }

          recipient.inbox.push({ position: this.next(), event: { type, sender: device.userId, content } })
        }
      }
    }

    this.changed()

    return json(200, {})
  }
}
