import { describe, expect, it, vi } from 'vitest'

import { matrixAssistantNameEntries, MatrixAssistantNameSync } from './assistant-name-sync'

/** A clock and timers the test moves by hand. */
function harness(apply = vi.fn(async (_principal: string, _name: string) => {})) {
  let now = 0
  let timer: { run: () => void; at: number } | undefined

  const sync = new MatrixAssistantNameSync({
    apply,
    now: () => now,
    setTimer: (run, ms) => {
      timer = { run, at: now + ms }

      return timer
    },
    clearTimer: value => {
      if (timer === value) {
        timer = undefined
      }
    }
  })

  const advance = async (ms: number) => {
    now += ms

    while (timer && timer.at <= now) {
      const due = timer
      timer = undefined
      due.run()
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  return { sync, apply, advance }
}

describe('what others see an assistant called', () => {
  it('follows the record once it has held still for ten seconds', async () => {
    const { sync, apply, advance } = harness()
    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])

    await advance(9_999)
    expect(apply).not.toHaveBeenCalled()
    await advance(1)
    expect(apply).toHaveBeenCalledExactlyOnceWith('lan', 'Lan Anh')
  })

  it('sends nothing for a rename followed by Undo inside the quiet window', async () => {
    const { sync, apply, advance } = harness()
    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
    await advance(4_000)
    sync.observe([{ principal: 'lan', wanted: 'Lan', shown: 'Lan' }])
    await advance(60_000)

    expect(apply).not.toHaveBeenCalled()
  })

  it('restarts the wait when the name changes again', async () => {
    const { sync, apply, advance } = harness()
    sync.observe([{ principal: 'lan', wanted: 'Lan A', shown: 'Lan' }])
    await advance(8_000)
    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
    await advance(8_000)
    expect(apply).not.toHaveBeenCalled()
    await advance(2_000)
    expect(apply).toHaveBeenCalledExactlyOnceWith('lan', 'Lan Anh')
  })

  it('makes one call however many roster syncs repeat the same difference', async () => {
    const { sync, apply, advance } = harness()

    for (let index = 0; index < 5; index++) {
      sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
      await advance(5_000)
    }

    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
    await advance(60_000)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the name already shows, or is not known yet', async () => {
    const { sync, apply, advance } = harness()
    sync.observe([
      { principal: 'lan', wanted: 'Lan', shown: 'Lan' },
      { principal: 'mai', wanted: 'Mai' }
    ])
    await advance(60_000)

    expect(apply).not.toHaveBeenCalled()
  })

  it('retries a failed attempt after a minute, not in a loop', async () => {
    const apply = vi.fn(async () => {
      throw new Error('offline')
    })

    const { sync, advance } = harness(apply)
    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
    await advance(10_000)
    expect(apply).toHaveBeenCalledTimes(1)
    await advance(59_000)
    expect(apply).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('forgets an assistant this Mac no longer holds', async () => {
    const { sync, apply, advance } = harness()
    sync.observe([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])
    sync.observe([])
    await advance(60_000)

    expect(apply).not.toHaveBeenCalled()
  })

  it('brings only assistants whose own session is ready here, and never a locked primary', () => {
    const ready = (userId: string, displayName?: string) => ({ ready: true, profile: { userId, displayName } })
    const lan = { primary: false, principal: 'lan', name: 'Lan Anh', userId: '@lan:example.invalid', host: ready('@lan:example.invalid', 'Lan') }

    const entries = matrixAssistantNameEntries(
      [
        lan,
        // The person's own session must never be renamed to an assistant's name.
        { ...lan, principal: 'mixed', host: ready('@minh:atum.chat', 'Minh') },
        { ...lan, principal: 'closed', closed: true },
        { ...lan, principal: 'starting', host: { ready: false, profile: lan.host.profile } },
        { ...lan, principal: 'no-profile', host: { ready: true } },
        { ...lan, principal: 'no-session', host: undefined },
        { ...lan, principal: 'no-name', name: undefined },
        { ...lan, principal: 'no-account', userId: undefined },
        { ...lan, principal: 'atum', primary: true, name: 'Atum', userId: '@atum:example.invalid', host: ready('@atum:example.invalid', 'Atum') }
      ],
      agent => agent.isDefault
    )

    expect(entries).toEqual([{ principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }])

    // With the primary's name unlocked (D1 answered "renameable"), it is brought too.
    expect(
      matrixAssistantNameEntries(
        [{ primary: true, principal: 'atum', name: 'Sao', userId: '@atum:example.invalid', host: ready('@atum:example.invalid', 'Atum') }],
        () => false
      )
    ).toEqual([{ principal: 'atum', wanted: 'Sao', shown: 'Atum' }])
  })

  it('never publishes a record name the rules refuse: the primary shows Atum, others keep theirs', () => {
    const ready = (userId: string, displayName?: string) => ({ ready: true, profile: { userId, displayName } })

    const primary = (name: string) => ({
      primary: true,
      principal: 'atum',
      name,
      userId: '@atum:example.invalid',
      host: ready('@atum:example.invalid', 'Linh')
    })

    const other = (name: string) => ({
      primary: false,
      principal: 'lan',
      name,
      userId: '@lan:example.invalid',
      host: ready('@lan:example.invalid', 'Lan')
    })

    // Stored by another writer (the Shell's naming route, an older client) under older rules.
    for (const refused of [
      'Founder',
      'M00n',
      'Moon Official',
      'Hỗ trợ Atum',
      '\u0410tum',
      'Atum Main',
      'AtumSupport'
    ]) {
      expect(matrixAssistantNameEntries([primary(refused)], () => false)).toEqual([
        { principal: 'atum', wanted: 'Atum', shown: 'Linh' }
      ])
      expect(matrixAssistantNameEntries([other(refused)], () => false)).toEqual([])
    }

    // A name that passes is published in its stored form.
    expect(matrixAssistantNameEntries([primary('Ｌｉｎｈ')], () => false)).toEqual([
      { principal: 'atum', wanted: 'Linh', shown: 'Linh' }
    ])
    expect(matrixAssistantNameEntries([primary('Atum')], () => false)).toEqual([
      { principal: 'atum', wanted: 'Atum', shown: 'Linh' }
    ])
    expect(matrixAssistantNameEntries([primary('Atum Bot')], () => false)).toEqual([
      { principal: 'atum', wanted: 'Atum Bot', shown: 'Linh' }
    ])
    expect(matrixAssistantNameEntries([other('Lan Anh')], () => false)).toEqual([
      { principal: 'lan', wanted: 'Lan Anh', shown: 'Lan' }
    ])
  })
})
