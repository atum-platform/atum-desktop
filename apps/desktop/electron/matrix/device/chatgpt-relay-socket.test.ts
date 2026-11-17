import { EventEmitter } from 'node:events'

import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(), lstat: vi.fn(), chmod: vi.fn(), unlink: vi.fn(), createServer: vi.fn()
}))

vi.mock('node:fs/promises', () => mocks)
vi.mock('node:net', () => ({ createServer: mocks.createServer }))
import type { ChatGptRelayHandler } from './chatgpt-relay'
import { ChatGptRelaySocket } from './chatgpt-relay-socket'

let server: EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
const handler = { disable: vi.fn(), handleSsh: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.chmod.mockResolvedValue(undefined)
  mocks.unlink.mockResolvedValue(undefined)
  server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_file, done) => done()), close: vi.fn(done => done?.())
  })
  mocks.createServer.mockReturnValue(server)
  mocks.lstat.mockImplementation(async file => {
    if (file.endsWith('.sock')) { throw Object.assign(new Error(), { code: 'ENOENT' }) }

    return { isDirectory: () => true, uid: process.getuid!(), mode: 0o700 }
  })
})
const subject = () => new ChatGptRelaySocket('/fake/.atum-chatgpt-relay/relay.sock', handler as unknown as ChatGptRelayHandler, () => [])
it('creates a user-only directory and chmods only the Unix socket; disabled closes it', async () => {
  const socket = subject()
  await socket.setEnabled(false)
  expect(mocks.createServer).not.toHaveBeenCalled()
  await socket.setEnabled(true)
  expect(mocks.mkdir).toHaveBeenCalledWith('/fake/.atum-chatgpt-relay', { mode: 0o700 })
  expect(server.listen).toHaveBeenCalledWith('/fake/.atum-chatgpt-relay/relay.sock', expect.any(Function))
  expect(mocks.chmod).toHaveBeenCalledWith('/fake/.atum-chatgpt-relay/relay.sock', 0o600)
  await socket.setEnabled(false)
  expect(server.close).toHaveBeenCalled()
  expect(handler.disable).toHaveBeenCalled()
})
it.each([
  { isDirectory: () => false, uid: process.getuid!(), mode: 0o700 },
  { isDirectory: () => true, uid: process.getuid!() + 1, mode: 0o700 },
  { isDirectory: () => true, uid: process.getuid!(), mode: 0o755 }
])('refuses unsafe directories before listening', async info => {
  mocks.lstat.mockResolvedValue(info)
  await expect(subject().setEnabled(true)).rejects.toThrow('unsafe_relay_directory')
  expect(mocks.createServer).not.toHaveBeenCalled()
})
it('refuses an existing symlink or regular file at the socket path', async () => {
  mocks.lstat.mockResolvedValueOnce({ isDirectory: () => true, uid: process.getuid!(), mode: 0o700 })
    .mockResolvedValueOnce({ isSocket: () => false, uid: process.getuid!() })
  await expect(subject().setEnabled(true)).rejects.toThrow('unsafe_relay_socket')
  expect(mocks.unlink).not.toHaveBeenCalled()
})
