import { describe, expect, it } from 'vitest'

import { MatrixHermesTurnLock } from './turn-lock'

it('grants in FIFO order across paths and rooms, one holder at a time', async () => {
  const lock = new MatrixHermesTurnLock()
  const order: string[] = []
  const first = await lock.acquire('!a', 'local')

  const second = lock.acquire('!b', 'watch').then(release => {
    order.push('watch')

    return release
  })

  const third = lock.acquire('!a', 'explicit').then(release => {
    order.push('explicit')

    return release
  })

  expect(lock.holder).toMatchObject({ roomId: '!a', label: 'local' })
  expect(lock.waiting).toBe(2)
  first()
  const releaseSecond = await second
  expect(lock.holder?.label).toBe('watch')
  releaseSecond()
  ;(await third)()
  expect(order).toEqual(['watch', 'explicit'])
  expect(lock.holder).toBeUndefined()
})

describe('tryAcquire: the lock only if it is free this instant', () => {
  it('grants a free lock at once, as the holder', () => {
    const lock = new MatrixHermesTurnLock()
    const release = lock.tryAcquire('home', 'checkpoint')

    expect(release).toBeTypeOf('function')
    expect(lock.holder).toMatchObject({ roomId: 'home', label: 'checkpoint' })
    release!()
    expect(lock.holder).toBeUndefined()
  })

  it('is refused while a turn holds the lock, without queueing behind it', async () => {
    const lock = new MatrixHermesTurnLock()
    const turn = await lock.acquire('!a', 'local')

    expect(lock.tryAcquire('home', 'checkpoint')).toBeNull()
    expect(lock.waiting).toBe(0)
    turn()
    // Refusing it left nothing behind: the lock is free again, and a later ask has it.
    expect(lock.tryAcquire('home', 'checkpoint')).toBeTypeOf('function')
  })

  it('is refused while another try holds it', () => {
    const lock = new MatrixHermesTurnLock()
    const first = lock.tryAcquire('home', 'checkpoint')

    expect(lock.tryAcquire('home', 'checkpoint')).toBeNull()
    first!()
  })

  it('keeps a turn that asks meanwhile waiting, and lets it in the moment the lock is let go', async () => {
    const lock = new MatrixHermesTurnLock()
    const release = lock.tryAcquire('home', 'checkpoint')!
    let admitted = false

    const turn = lock.acquire('!a', 'local').then(letGo => {
      admitted = true

      return letGo
    })

    await Promise.resolve()
    expect(admitted).toBe(false)
    expect(lock.waiting).toBe(1)
    release()
    const letGo = await turn
    expect(admitted).toBe(true)
    expect(lock.holder).toMatchObject({ label: 'local' })
    letGo()
  })

  it('lets go once: a second release does not free the turn that came in after the first', async () => {
    const lock = new MatrixHermesTurnLock()
    const release = lock.tryAcquire('home', 'checkpoint')!
    const turn = lock.acquire('!a', 'local')
    release()
    const letGo = await turn
    release()

    expect(lock.holder).toMatchObject({ label: 'local' })
    expect(lock.tryAcquire('home', 'checkpoint')).toBeNull()
    letGo()
  })
})

it('drops an aborted waiter without granting it, and a double release is harmless', async () => {
  const lock = new MatrixHermesTurnLock()
  const release = await lock.acquire('!a', 'local')
  const abort = new AbortController()
  const waiter = lock.acquire('!a', 'watch', abort.signal)
  abort.abort()
  await expect(waiter).rejects.toBeDefined()
  expect(lock.waiting).toBe(0)
  release()
  release()
  const again = await lock.acquire('!a', 'explicit')
  expect(lock.holder?.label).toBe('explicit')
  again()
})
