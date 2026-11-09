import { describe, expect, it, vi } from 'vitest'

import {
  matrixFirstLearningPrompt,
  matrixFirstLearningRequest
} from '../../shared/matrix-first-learning'

import {
  MatrixFirstRun,
  matrixFirstRunAvailable,
  type MatrixFirstRunDeps,
  matrixFirstRunOpen,
  matrixFirstRunToolAllowed
} from './first-run'

function harness(overrides: Partial<MatrixFirstRunDeps> = {}) {
  let room: string | undefined = '!atum:test'
  const hidden: Array<{ roomId: string; text: string; context: string; profile: string }> = []
  const answers: string[] = []
  const lines: string[] = []
  const deps: MatrixFirstRunDeps = {
    room: vi.fn(preferred => preferred ?? room),
    claim: vi.fn(async () => 'run_here' as const),
    acceptHidden: vi.fn((roomId, text, context, profile) => void hidden.push({ roomId, text, context, profile })),
    answer: vi.fn(async (folders, welcome) => void answers.push(`${folders}:${welcome}`)),
    changed: vi.fn(),
    log: line => void lines.push(line),
    ...overrides
  }

  return {
    flow: new MatrixFirstRun(deps),
    deps,
    hidden,
    answers,
    lines,
    noRoom: () => (room = undefined)
  }
}

describe('first-learning placement and trigger', () => {
  const account = { identity: true, primary: true, marker: 'unseen' as const, welcome: 'open' as const }

  it('opens once for the new account wherever its primary answers', () => {
    expect(matrixFirstRunOpen(account)).toBe(true)
    expect(matrixFirstRunAvailable({ ...account, assistantPath: 'local', cloudOnly: false })).toBe(true)
    expect(matrixFirstRunAvailable({ ...account, assistantPath: 'server', cloudOnly: true })).toBe(true)

    for (const marker of ['unknown', 'answered', undefined] as const) {
      expect(matrixFirstRunOpen({ ...account, marker })).toBe(false)
    }
    for (const welcome of ['unseen', 'unknown', 'done', 'dismissed', undefined] as const) {
      expect(matrixFirstRunOpen({ ...account, welcome })).toBe(false)
    }
  })

  it.each([
    ['done', 'declined:done'],
    ['dismissed', 'declined:dismissed']
  ] as const)('starts one hidden local context turn and closes the welcome as %s', async (ending, answer) => {
    const f = harness()

    await f.flow.start({ locale: 'vi', roomId: '!chosen:test', ending })

    expect(f.deps.claim).toHaveBeenCalledExactlyOnceWith('vi')
    expect(f.deps.room).toHaveBeenCalledExactlyOnceWith('!chosen:test')
    expect(f.hidden).toEqual([
      {
        roomId: '!chosen:test',
        text: matrixFirstLearningRequest('vi'),
        context: matrixFirstLearningPrompt('vi'),
        profile: 'first_learning'
      }
    ])
    expect(f.deps).not.toHaveProperty('sendQuestion')
    expect(f.answers).toEqual([answer])
    expect(f.flow.view('unseen')).toBeUndefined()
  })

  it('coalesces concurrent starts before the claim and turn are durable', async () => {
    let release!: () => void
    const f = harness({
      claim: vi.fn(
        () =>
          new Promise<'run_here'>(resolve => {
            release = () => resolve('run_here')
          })
      )
    })

    const first = f.flow.start({ locale: 'en', ending: 'done' })
    const second = f.flow.start({ locale: 'en', ending: 'done' })
    await vi.waitFor(() => expect(f.deps.claim).toHaveBeenCalledOnce())
    release()
    await Promise.all([first, second])

    expect(f.hidden).toHaveLength(1)
    expect(f.answers).toEqual(['declined:done'])
  })

  it.each(['remote', 'done'] as const)('does not create another turn when the platform says %s', async claim => {
    const f = harness({ claim: vi.fn(async () => claim) })

    await f.flow.start({ locale: 'en', ending: 'done' })

    expect(f.hidden).toEqual([])
    expect(f.answers).toEqual(['declined:done'])
  })

  it('is idempotent after restart because the platform tombstone says done', async () => {
    const claim = vi.fn(async () => 'done' as const)
    const first = harness({ claim })
    await first.flow.start({ locale: 'en', ending: 'done' })

    const restarted = harness({ claim })
    await restarted.flow.start({ locale: 'en', ending: 'done' })

    expect(claim).toHaveBeenCalledTimes(2)
    expect(first.hidden).toEqual([])
    expect(restarted.hidden).toEqual([])
  })

  it('keeps the card recoverable when no room or durable claim is available', async () => {
    const noRoom = harness()
    noRoom.noRoom()
    await expect(noRoom.flow.start({ locale: 'en', ending: 'done' })).rejects.toThrow('matrix_first_learning_unavailable')
    expect(noRoom.deps.claim).not.toHaveBeenCalled()
    expect(noRoom.flow.view('unseen')).toBe('offer')

    const unavailable = harness({ claim: vi.fn(async () => 'unavailable' as const) })
    await expect(unavailable.flow.start({ locale: 'en', ending: 'done' })).rejects.toThrow('matrix_first_learning_unavailable')
    expect(unavailable.flow.view('unseen')).toBe('offer')
  })
})

describe('first-learning prompt and safety policy', () => {
  it('asks for the broad-to-deep arc, progressive messages, memory and a short useful finish', () => {
    const prompt = matrixFirstLearningPrompt('vi')

    for (const source of [
      '~/Desktop',
      '~/Documents',
      '~/Downloads',
      '~/Atum/Drive',
      'Atum Drive',
      'Atum chats',
      'Messages:',
      'Browser:',
      'location.current'
    ]) {
      expect(prompt).toContain(source)
    }
    expect(prompt).toContain('category:promotions')
    expect(prompt).toContain('after:2020/01/01')
    expect(prompt).toContain('the past 30 days')
    expect(prompt).toContain('PDF and Word files cannot yet')
    expect(prompt).toContain('six to ten')
    expect(prompt).toContain('Facts derived from approved sources are allowed')
    expect(prompt).toContain('never save raw mail or file passages')
    expect(prompt).toContain('never quote a message')
    expect(prompt).toContain('never reconstruct or save a full URL')
    expect(prompt).toContain('save city-level facts only, never precise coordinates')
    expect(prompt).toContain('save compact, durable profile facts as you learn them')
    expect(prompt).toContain('Send several short progress messages')
    expect(prompt).toContain('Corroborate any person or fact across at least two sources')
    expect(prompt).toContain('Progress and final messages are paraphrases')
    expect(prompt).toContain('Sheets (first sheet only, as CSV)')
    expect(prompt).toContain('`sort: viewed` and `modifiedAfter`')
    expect(prompt).toContain('last 365 days')
    expect(prompt).toContain('including 60 days')
    expect(prompt).toContain('up to 3 concrete things you can do right away')
    expect(prompt).toContain('at most about ten short lines')
    expect(prompt).toContain('reply in Vietnamese')
    expect(prompt).toContain('normal funded turn')
    expect(prompt).not.toMatch(/five-minute|one memory call|at most 8/i)
  })

  it('admits every learning read and memory, while refusing write-capable side effects', () => {
    for (const tool of [
      'read_file',
      'search_files',
      'memory',
      'session_search',
      'skills_list',
      'skill_view',
      'atum_chats',
      'atum_mac',
      'atum_google_readonly'
    ]) {
      expect(matrixFirstRunToolAllowed(tool), tool).toBe(true)
    }

    for (const tool of [
      'atum_google',
      'terminal',
      'execute_code',
      'write_file',
      'patch',
      'send_message',
      'cronjob',
      'delegate_task',
      'atum_store',
      'atum_agents',
      'computer_use',
      ''
    ]) {
      expect(matrixFirstRunToolAllowed(tool), tool).toBe(false)
    }
  })
})

describe('first learning knows the folders the owner shared', () => {
  it('names the shared folders and the closed ones in the hidden turn, never in the request', async () => {
    const h = harness({ folders: () => ({ shared: ['~/Desktop', '~/Projects/Clients'], skipped: ['~/Downloads'] }) })

    await h.flow.start({ locale: 'en', ending: 'done' })

    const [turn] = h.hidden
    expect(turn!.context).toContain('the folders the owner shared: `~/Desktop`, `~/Projects/Clients`, Atum Drive.')
    expect(turn!.context).toContain('The owner kept `~/Downloads` closed: do not open it with any tool, `terminal` and `execute_code` included.')
    expect(turn!.context).toContain('being able to is not the owner')
    expect(turn!.context).not.toContain('`~/Documents`')
    expect(turn!.text).toBe(matrixFirstLearningRequest('en'))
  })

  it('keeps the usual three folders when the Mac has no choice to report', async () => {
    const h = harness({ folders: () => { throw new Error('no account') } })

    await h.flow.start({ locale: 'en', ending: 'done' })

    expect(h.hidden[0]!.context).toBe(matrixFirstLearningPrompt('en'))
    expect(matrixFirstLearningPrompt('en')).toContain('3. Work surface: `~/Desktop`, `~/Documents`, `~/Downloads` and Atum Drive (`~/Atum/Drive`')
  })
})
